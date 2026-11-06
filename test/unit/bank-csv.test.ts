// CSV の枠と PayPay のパーサー（docs/mvp-plan-v3.md T105）。fixture は架空の店名・相手で作ったもの（test/fixtures/csv/）。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeCsv, detectParser, headLine, splitCsv } from '../../src/bank/csv/index.ts';
import { paypayParser } from '../../src/bank/csv/paypay.ts';
import { dedupAndInsert, type DedupInput } from '../../src/bank/dedup.ts';
import { insertAccount } from '../../src/bank/repo.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';

const FIX = path.resolve(import.meta.dirname, '../fixtures/csv');
const fixture = (name: string) => readFile(path.join(FIX, name));
const HEADER = '取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号';

describe('splitCsv', () => {
  test('引用符・引用符の中のカンマと改行・"" ・CRLF / LF・空の行', () => {
    const recs = splitCsv('a,"b,1","c\r\nd"\r\n\r\n"e""f",,g\nh');
    assert.deepEqual(
      recs.map((r) => [r.line, r.fields]),
      [
        [1, ['a', 'b,1', 'c\r\nd']],
        [4, ['e"f', '', 'g']],
        [5, ['h']],
      ],
    );
    assert.equal(recs[1]!.raw, '"e""f",,g');
  });

  test('末尾の改行の後は行にしない', () => {
    assert.equal(splitCsv('a,b\r\n').length, 1);
    assert.equal(splitCsv('').length, 0);
  });
});

describe('decodeCsv', () => {
  const enc = new TextEncoder();
  test('UTF-8 の BOM は外す', () => {
    const r = decodeCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('取引日,x')]));
    assert.deepEqual(r, { text: '取引日,x', encoding: 'utf-8' });
  });
  test('UTF-16LE / BE の BOM', () => {
    const le = Buffer.from('取引日,x', 'utf16le');
    assert.deepEqual(decodeCsv(new Uint8Array([0xff, 0xfe, ...le])), { text: '取引日,x', encoding: 'utf-16le' });
    const be = Buffer.from(le).swap16();
    assert.deepEqual(decodeCsv(new Uint8Array([0xfe, 0xff, ...be])), { text: '取引日,x', encoding: 'utf-16be' });
  });
  test('BOM が無ければ UTF-8、読めなければ Shift_JIS', async () => {
    assert.equal(decodeCsv(enc.encode('あ,い')).encoding, 'utf-8');
    const r = decodeCsv(await fixture('paypay-sjis.csv'));
    assert.equal(r.encoding, 'shift_jis');
    assert.equal(headLine(r.text), HEADER);
  });
});

describe('detectParser', () => {
  test('PayPay のヘッダで paypay を選ぶ。知らないヘッダは null', () => {
    assert.equal(detectParser(HEADER)?.id, 'paypay');
    assert.equal(detectParser(`﻿${HEADER}`)?.id, 'paypay');
    assert.equal(detectParser('日付,金額,摘要'), null);
  });
});

describe('PayPay のパーサー', () => {
  test('fixture: 件数・金額・符号・skip・errors', async () => {
    const { text } = decodeCsv(await fixture('paypay-2026-10.csv'));
    const { rows, errors } = paypayParser.parse(text);
    assert.equal(rows.length + errors.length, 30);
    assert.deepEqual(errors, [{ line: 10, reason: 'invalid_date' }]);
    const skipped = rows.filter((r) => r.skip);
    assert.deepEqual(skipped.map((r) => [r.line, r.skip, r.kind]), [
      [3, 'points', 'points'],
      [4, 'points', 'invest'],
      [12, 'points', 'points'],
      [16, 'points', 'invest'],
    ]);
    const live = rows.filter((r) => !r.skip);
    assert.equal(live.length, 25);
    const sum = (side: string) => live.filter((r) => r.side === side).reduce((n, r) => n + r.amount, 0);
    assert.equal(live.filter((r) => r.side === 'expense').length, 21);
    assert.equal(sum('expense'), 67320);
    assert.equal(live.filter((r) => r.side === 'income').length, 4);
    assert.equal(sum('income'), 19500);
    assert.deepEqual(live[0], {
      line: 2,
      raw: '2026/10/31 20:10:05,"1,580",-,-,-,-,-,支払い,テスト珈琲店 本町店,PayPay残高,-,-,05200000000000000001',
      externalId: '05200000000000000001',
      txnDate: '2026-10-31',
      amount: 1580,
      side: 'expense',
      description: '支払い テスト珈琲店 本町店',
      counterparty: 'テスト珈琲店 本町店',
      kind: 'payment',
    });
    const by = (id: string) => live.find((r) => r.externalId === id)!;
    assert.deepEqual([by('05200000000000000005').description, by('05200000000000000005').kind, by('05200000000000000005').side], ['チャージ テスト銀行 *****99', 'charge', 'income']);
    assert.deepEqual([by('05200000000000000003').kind, by('05200000000000000004').kind], ['transfer', 'receive']);
    assert.deepEqual([by('4800000000000000000#11111').kind, by('4800000000000000000#11111').amount, by('4800000000000000000#11111').description], ['bill', 8900, '請求書払い 架空県架空市']);
    assert.equal(by('05200000000000000007').counterparty, 'テスト商店, 駅前店');
    assert.equal(by('520000000000000099').amount, 450, '先頭 0 の無い番号も文字列のまま');
  });

  test('同じ番号の 2 行目は duplicate_in_file。金額の欠け・両方・形式違い', () => {
    const line = (o: string, i: string, id: string, method = 'PayPay残高', date = '2026/10/01 10:00:00') =>
      [date, o, i, '-', '-', '-', '-', '支払い', '店', method, '-', '-', id].join(',');
    const text = [
      HEADER,
      line('100', '-', 'X1'),
      line('-', '5', 'X1', 'PayPayポイント'),
      line('200', '-', 'X1'),
      line('-', '-', 'X2'),
      line('1', '2', 'X3'),
      line('1.5', '-', 'X4'),
      line('0', '-', 'X5'),
      line('100', '-', '-'),
      'a,b,c',
      line('100', '-', 'X6', 'PayPay残高', '2026-10-01'),
    ].join('\n');
    const { rows, errors } = paypayParser.parse(text);
    assert.deepEqual(rows.map((r) => [r.externalId, r.skip ?? null]), [['X1', null], ['X1', 'points']]);
    assert.deepEqual(errors, [
      { line: 4, reason: 'duplicate_in_file' },
      { line: 5, reason: 'no_amount' },
      { line: 6, reason: 'both_amounts' },
      { line: 7, reason: 'invalid_amount' },
      { line: 8, reason: 'invalid_amount' },
      { line: 9, reason: 'missing_external_id' },
      { line: 10, reason: 'invalid_columns' },
      { line: 11, reason: 'invalid_date' },
    ]);
  });
});

describe('dedupAndInsert の dryRun', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'keihi-csv-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const now = '2026-11-06T00:00:00.000Z';
  const count = (db: Db, t: string) => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;

  test('書かずに本番と同じ件数・組を返す（同額 2 件・外部 ID の一致・入力の中の重なり）', () => {
    const db = openDb(path.join(root, 'a.db'));
    migrate(db);
    const acc = insertAccount(db, { provider: 'fake', name: '銀行', kind: 'bank', source: 'csv', now }).id;
    const inp = (source: 'freee' | 'csv', externalId: string, txnDate: string, amount: number): DedupInput => ({
      accountId: acc, source, externalId, txnDate, amount, side: 'expense', description: `ﾃｽﾄ ${externalId}`,
    });
    dedupAndInsert(db, [inp('freee', 'f1', '2026-10-01', 500), inp('freee', 'f2', '2026-10-01', 500), inp('csv', 'c0', '2026-10-02', 70)], { dateWindowDays: 0, now });
    const batch = [
      inp('csv', 'c1', '2026-10-01', 500),
      inp('csv', 'c2', '2026-10-01', 500),
      inp('csv', 'c3', '2026-10-01', 500),
      inp('csv', 'c0', '2026-10-02', 70),
      inp('csv', 'c4', '2026-10-03', 900),
      inp('csv', 'c4', '2026-10-03', 900),
      inp('freee', 'f9', '2026-10-03', 900),
      { ...inp('csv', 'c5', '2026-10-03', 900), amount: 0 },
    ];
    const before = [count(db, 'bank_txns'), count(db, 'bank_txn_sources')];
    const dry = dedupAndInsert(db, batch, { dateWindowDays: 0, now, dryRun: true });
    assert.deepEqual([count(db, 'bank_txns'), count(db, 'bank_txn_sources')], before, 'dryRun は書かない');
    const real = dedupAndInsert(db, batch, { dateWindowDays: 0, now });
    const shape = (r: typeof dry) => ({
      new: r.new.map((h) => h.index),
      merged: r.merged.map((h) => h.index),
      touched: r.touched.map((h) => h.index),
      suspects: r.suspects.map((h) => [h.index, h.candidateIds]),
      errors: r.errors,
    });
    assert.deepEqual(shape(dry), shape(real));
    assert.deepEqual(shape(real).new, [2, 4]);
    assert.deepEqual(shape(real).merged, [0, 1, 6], 'freee の f9 は同じバッチの csv の c4 と組む');
    assert.deepEqual(dry.new.map((h) => h.bankTxnId), ['dry:2', 'dry:4']);
    assert.equal(dry.merged.find((h) => h.index === 6)!.bankTxnId, 'dry:4');
  });
});
