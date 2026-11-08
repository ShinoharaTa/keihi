// 周期の検出（docs/mvp-plan-v3.md T302、src/cashflow/detect.ts）と候補の API。一時ディレクトリの DB だけを使う。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { appendAudit, verifyAudit } from '../../src/audit.ts';
import { insertAccount, insertBankTxn, updateAccountSettings, type TxnSide } from '../../src/bank/repo.ts';
import { detectTransfers } from '../../src/bank/transfers.ts';
import { addDays, addMonths } from '../../src/calendar/businessDays.ts';
import { acceptCandidate, detectRecurrences, dismissCandidate, findRecurrences, nextDueFromCandidate } from '../../src/cashflow/detect.ts';
import { insertRecurrenceCandidate, listRecurrenceCandidates, listScheduledItems, setRecurrenceCandidateState } from '../../src/cashflow/repo.ts';
import { createItem } from '../../src/cashflow/schedule.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createAuth } from '../../src/web/auth.ts';
import { cashflowRoutes } from '../../src/web/routes/cashflow.ts';

// 2026-11-06 09:00 JST
const T0 = new Date('2026-11-06T00:00:00.000Z');
const TODAY = '2026-11-06';
const now = T0.toISOString();
const by = { actor: 'user', user: 'me@example.com' };
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-detect-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function fresh(): { db: Db; A: string; B: string } {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  const A = insertAccount(db, { provider: 'fake', name: '銀行A', kind: 'bank', source: 'csv', now }).id;
  const B = insertAccount(db, { provider: 'fake', name: '銀行B', kind: 'bank', source: 'csv', now }).id;
  return { db, A, B };
}

function txn(db: Db, accountId: string, date: string, amount: number, desc: string, side: TxnSide = 'expense'): string {
  return insertBankTxn(db, { accountId, txnDate: date, amount, side, description: desc, descriptionNorm: desc, now }).id;
}

const day = (ym: string, d: number) => `${ym}-${String(d).padStart(2, '0')}`;
// 2024-11 〜 2026-10 の 24 か月。
const MONTHS = Array.from({ length: 24 }, (_, i) => addMonths('2024-11-01', i).slice(0, 7));

// 合成した 24 か月の明細。毎月 2 本・隔月 1 本・毎年 1 本と、ノイズ。
function seed(db: Db, A: string, B: string): void {
  MONTHS.forEach((ym, i) => {
    txn(db, A, day(ym, 27), 80000, '家賃');
    txn(db, A, day(ym, 10), i % 2 === 0 ? 3000 : 3120, '携帯'); // 4% の揺れ
    if (Number(ym.slice(5, 7)) % 2 === 1) txn(db, A, day(ym, 15), 6000, '水道');
    // 振替（B に同額の入金）: 毎月でも検出の対象から外れる。
    txn(db, A, day(ym, 25), 50000, '振込 銀行B');
    txn(db, B, day(ym, 25), 50000, '振込 銀行A', 'income');
  });
  txn(db, A, '2025-05-20', 39500, '自動車税');
  txn(db, A, '2026-05-22', 39500, '自動車税');
  // ノイズ: 1 回だけ。
  txn(db, A, '2026-03-03', 50000, '家電');
  // ノイズ: 1 年おきだが金額が 20% 違う（段 1 は 1 件ずつの段で値上げとみなさず、段 2 は金額ごとに 1 回しかない）。
  txn(db, A, '2025-07-01', 20000, '保険');
  txn(db, A, '2026-07-01', 24000, '保険');
  // ノイズ: 毎月だが真ん中だけ 20% 違う（段 1 は金額の段が 3 つで捨て、段 2 の同じ金額の 2 本は隔月に 2 回しかない）。
  txn(db, A, '2026-01-05', 10000, '電気');
  txn(db, A, '2026-02-04', 12000, '電気');
  txn(db, A, '2026-03-06', 10000, '電気');
  // 入金は対象外。
  for (const ym of MONTHS) txn(db, A, day(ym, 20), 300000, '給与', 'income');
  assert.equal(detectTransfers(db, { windowDays: 3, now: T0 }).length, 24);
}

const summary = (db: Db) =>
  listRecurrenceCandidates(db)
    .map((c) => `${c.description_norm}:${c.interval}:${c.amount}`)
    .sort();

describe('detectRecurrences', () => {
  test('24 か月の明細から、毎月 2・隔月 1・毎年 1 だけを候補にする', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 4, updated: 0 });
    assert.deepEqual(summary(db), ['家賃:monthly:80000', '携帯:monthly:3120', '水道:bimonthly:6000', '自動車税:yearly:39500'].sort());
    for (const c of listRecurrenceCandidates(db)) {
      assert.equal(c.state, 'open');
      assert.equal(c.account_id, A);
      assert.equal(c.scheduled_item_id, null);
    }
    const rent = listRecurrenceCandidates(db).find((c) => c.description_norm === '家賃')!;
    const occ = JSON.parse(rent.occurrences_json) as { date: string; amount: number; bank_txn_id: string }[];
    assert.equal(occ.length, 24);
    assert.deepEqual(Object.keys(occ[0]).sort(), ['amount', 'bank_txn_id', 'date']);
    assert.equal(occ[0].date, '2024-11-27');
    assert.equal(occ[23].date, '2026-10-27');
    db.close();
  });

  test('2 回目の検出では増えない', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    detectRecurrences(db, { today: TODAY, now: T0 });
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 0, updated: 0 });
    assert.equal(listRecurrenceCandidates(db).length, 4);
    db.close();
  });

  test('見る範囲は today から lookbackMonths か月前まで', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    // 6 か月なら毎年の 2 回は入らない。隔月は 3 回（5・7・9 月）入る。
    const found = findRecurrences(db, { today: TODAY, lookbackMonths: 6 })
      .map((d) => `${d.descriptionNorm}:${d.interval}`)
      .sort();
    assert.deepEqual(found, ['家賃:monthly', '携帯:monthly', '水道:bimonthly'].sort());
    db.close();
  });

  // 最後の出現を 2026-11-01 にして、等間隔で count 回さかのぼる。
  const series = (gap: number, count: number, end = '2026-11-01') => Array.from({ length: count }, (_, i) => addDays(end, -gap * (count - 1 - i)));
  const found = (db: Db) => findRecurrences(db, { today: TODAY }).map((d) => `${d.descriptionNorm}:${d.interval}:${d.amount}:${d.occurrences.length}`).sort();
  // 1.06 倍ずつ違う額（どの 2 つも ±5% に入らない）。
  const spread = (k: number) => Math.round(1000 * 1.06 ** k);

  test('枠: 毎月 27 日のうち 2 回が +2 日・+1 日にずれても 1 本の列', () => {
    const { db, A } = fresh();
    for (const d of ['2026-05-27', '2026-06-29', '2026-07-27', '2026-08-27', '2026-09-28', '2026-10-27']) txn(db, A, d, 50000, 'テスト家賃');
    assert.deepEqual(found(db), ['テスト家賃:monthly:50000:6']);
    db.close();
  });

  test('枠: 月末払いが 12/31 → 1/5（+5 日）にずれても列が切れない', () => {
    const { db, A } = fresh();
    const dates = Array.from({ length: 16 }, (_, i) => addMonths('2025-07-31', i)).map((d) => (d === '2025-12-31' ? '2026-01-05' : d));
    for (const d of dates) txn(db, A, d, 3000, 'テスト月末');
    const [f] = findRecurrences(db, { today: TODAY });
    assert.deepEqual([f.interval, f.occurrences.length], ['monthly', 16]);
    assert.ok(f.occurrences.some((o) => o.date === '2026-01-05'));
    db.close();
  });

  test('枠: −3 日（前営業日）は同じ列、−4 日は枠外で列が切れる', () => {
    const { db, A } = fresh();
    for (const ym of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
      txn(db, A, ym === '2026-08' ? '2026-08-07' : day(ym, 10), 2000, 'テスト前営業日');
      txn(db, A, ym === '2026-06' ? '2026-06-06' : day(ym, 10), 2000, 'テスト枠外');
    }
    // 枠外の 6/6 で切れ、7 月〜10 月の 4 回だけが列になる（5 月の 1 回は 3 回に足りない）。
    assert.deepEqual(found(db), ['テスト前営業日:monthly:2000:6', 'テスト枠外:monthly:2000:4']);
    db.close();
  });

  test('枠: 隔月・3 か月・毎年・隔年も日のずれを許す', () => {
    const { db, A } = fresh();
    for (const d of ['2026-04-15', '2026-06-18', '2026-08-15', '2026-10-15']) txn(db, A, d, 6000, 'テスト水道');
    for (const d of ['2026-01-20', '2026-04-18', '2026-07-20', '2026-10-20']) txn(db, A, d, 40000, 'テスト国保');
    for (const d of ['2024-11-10', '2025-11-12']) txn(db, A, d, 30000, 'テスト年払い');
    for (const d of ['2024-10-01', '2026-10-03']) txn(db, A, d, 10000, 'テスト更新');
    assert.deepEqual(found(db), ['テスト水道:bimonthly:6000:4', 'テスト国保:quarterly:40000:4', 'テスト年払い:yearly:30000:2', 'テスト更新:biennial:10000:2'].sort());
    db.close();
  });

  test('増額: 10,000 × 5 回 → 20,000 × 2 回は毎月の定額 1 件（額は新しい方、7 回）', () => {
    const { db, A } = fresh();
    ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].forEach((ym, i) => txn(db, A, day(ym, 27), i < 5 ? 10000 : 20000, 'テスト積立A'));
    assert.deepEqual(found(db), ['テスト積立A:monthly:20000:7']);
    db.close();
  });

  test('1 件だけの段は値上げとみなさない: 1 年違いで金額が違う 2 件は何も作らない', () => {
    const { db, A } = fresh();
    for (const [d, a] of [['2025-07-01', 3000], ['2026-07-01', 48000]] as const) txn(db, A, d, a, 'テスト年会費');
    assert.deepEqual(findRecurrences(db, { today: TODAY }), []);
    db.close();
  });

  test('1 件だけの段は値上げとみなさない: 10,000 × 5 回 → 20,000 × 1 回は段 2 で 10,000 の毎月', () => {
    const { db, A } = fresh();
    ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].forEach((ym, i) => txn(db, A, day(ym, 27), i < 5 ? 10000 : 20000, 'テスト積立B'));
    assert.deepEqual(found(db), ['テスト積立B:monthly:10000:5']);
    db.close();
  });

  test('毎月同じ日の 600 円と月 3 回のばらばらの買い物: 段 1 は純度で落ち、段 2 で 600 円の毎月', () => {
    const { db, A } = fresh();
    ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].forEach((ym, i) => {
      txn(db, A, day(ym, 15), 600, 'テスト店');
      [3 + i, 9 + i, 22 - i].forEach((d, j) => txn(db, A, day(ym, d), spread(i * 3 + j), 'テスト店'));
    });
    assert.deepEqual(found(db), ['テスト店:monthly:600:6']);
    db.close();
  });

  test('月に 4 回以上ばらばらに出る店は何も作らない', () => {
    const { db, A } = fresh();
    MONTHS.slice(-10).forEach((ym, i) => {
      [2 + (i % 3), 9 + (i % 4), 16 + (i % 2), 24 + (i % 3)].forEach((d, j) => txn(db, A, day(ym, d), spread(i * 4 + j), 'テスト雑貨'));
    });
    assert.deepEqual(findRecurrences(db, { today: TODAY }), []);
    db.close();
  });

  test('週 1 回・同じ額の買い物（13 週）は毎月にしない（段 2 も金額のまとまりの中で純度を見る）', () => {
    const { db, A } = fresh();
    for (let i = 0; i < 13; i++) txn(db, A, addDays('2026-08-03', 7 * i), 500, 'テストパン屋');
    assert.deepEqual(findRecurrences(db, { today: TODAY }), []);
    db.close();
  });

  test('毎月は 2 回では足りない（3 回から）', () => {
    const { db, A } = fresh();
    for (const d of series(30, 2)) txn(db, A, d, 1000, '二回');
    assert.deepEqual(findRecurrences(db, { today: TODAY }), []);
    db.close();
  });

  test('金額: 最小の 105% ちょうどは同じまとまり、わずかに超えると別', () => {
    const { db, A } = fresh();
    const ds = series(30, 3);
    [2000, 2100, 2000].forEach((a, i) => txn(db, A, ds[i], a, 'ちょうど'));
    [2000, 2101, 2000].forEach((a, i) => txn(db, A, ds[i], a, '超える'));
    assert.deepEqual(findRecurrences(db, { today: TODAY }).map((d) => `${d.descriptionNorm}:${d.amount}`), ['ちょうど:2000']);
    db.close();
  });

  test('値上げ: 3000 → 3500 は 1 本の列で、金額は新しい方', () => {
    const { db, A } = fresh();
    for (const ym of MONTHS) txn(db, A, day(ym, 10), ym < '2026-07' ? 3000 : 3500, '携帯');
    assert.deepEqual(findRecurrences(db, { today: TODAY }).map((d) => `${d.interval}:${d.amount}:${d.occurrences.length}`), ['monthly:3500:24']);
    db.close();
  });

  test('同じ摘要で金額違いの月額 2 本は両方出る', () => {
    const { db, A } = fresh();
    for (const ym of MONTHS) {
      txn(db, A, day(ym, 5), 5000, '保険料');
      txn(db, A, day(ym, 20), 8000, '保険料');
    }
    assert.deepEqual(findRecurrences(db, { today: TODAY }).map((d) => `${d.interval}:${d.amount}`).sort(), ['monthly:5000', 'monthly:8000']);
    db.close();
  });

  test('周期の切り替え: 毎月から隔月に変わった水道は隔月だけ', () => {
    const { db, A } = fresh();
    MONTHS.forEach((ym, i) => {
      if (i < 12 || i % 2 === 1) txn(db, A, day(ym, 15), 6000, '水道'); // 2024-11〜2025-10 は毎月、2025-12 から隔月
    });
    const found = findRecurrences(db, { today: TODAY });
    assert.deepEqual(found.map((d) => d.interval), ['bimonthly']);
    assert.equal(found[0].occurrences.at(-1)!.date, '2026-10-15');
    db.close();
  });

  test('止まった支払いは出ない（次の予定日から months × 15 + 6 日を過ぎたら）', () => {
    const { db, A } = fresh();
    // 毎月: 最後の枠は 9 月。次の予定日 10/10 + 21 日 = 10/31 までは出る。最後の明細が −2 日ずれていても枠で数える。
    for (const ym of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
      txn(db, A, day(ym, 10), 1000, 'テスト毎月');
      txn(db, A, ym === '2026-09' ? '2026-09-08' : day(ym, 10), 1000, 'テストずれ');
    }
    // 毎年: 次の予定日 2026-05-20 + 186 日 = 2026-11-22 までは出る。
    for (const d of ['2024-05-20', '2025-05-20']) txn(db, A, d, 1000, 'テスト毎年');
    const names = (today: string) =>
      findRecurrences(db, { today, lookbackMonths: 40 })
        .map((d) => d.descriptionNorm)
        .sort();
    assert.deepEqual(names('2026-10-31'), ['テストずれ', 'テスト毎年', 'テスト毎月'].sort());
    assert.deepEqual(names('2026-11-01'), ['テスト毎年']);
    assert.deepEqual(names('2026-11-22'), ['テスト毎年']);
    assert.deepEqual(names('2026-11-23'), []);
    db.close();
  });

  test('active = 0 / include_in_cashflow = 0 の口座は見ない', () => {
    const { db, A, B } = fresh();
    for (const d of series(30, 3)) {
      txn(db, A, d, 1000, '口座A');
      txn(db, B, d, 1000, '口座B');
    }
    assert.equal(findRecurrences(db, { today: TODAY }).length, 2);
    updateAccountSettings(db, A, { active: false }, now);
    updateAccountSettings(db, B, { includeInCashflow: false }, now);
    assert.deepEqual(findRecurrences(db, { today: TODAY }), []);
    db.close();
  });

  test('同じ日・同じ額の 2 件（2 回線）は 1 件に畳む', () => {
    const { db, A } = fresh();
    for (const d of series(30, 3)) {
      txn(db, A, d, 2980, '回線');
      txn(db, A, d, 2980, '回線');
    }
    const found = findRecurrences(db, { today: TODAY });
    assert.deepEqual(found.map((d) => `${d.interval}:${d.occurrences.length}`), ['monthly:3']);
    db.close();
  });

  test('隔年は 715〜745 日で 2 回', () => {
    const { db, A } = fresh();
    txn(db, A, '2024-10-01', 12000, '免許更新');
    txn(db, A, '2026-10-01', 12500, '免許更新');
    assert.deepEqual(
      findRecurrences(db, { today: TODAY }).map((d) => `${d.interval}:${d.amount}`),
      ['biennial:12500'],
    );
    db.close();
  });

  test('同じ口座・同じ名前の active な予定項目があれば作らない（止めた項目なら作る）', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    const it = createItem(
      db,
      { name: '家賃', amount: 80000, direction: 'out', category: 'other', accountId: A, recurrence: 'monthly', anchorDate: '2026-11-27', endDate: null, notifyDaysBefore: 14, origin: 'manual' },
      by,
      T0,
    );
    // 別の口座の同名は関係ない。
    createItem(
      db,
      { name: '携帯', amount: 3000, direction: 'out', category: 'other', accountId: B, recurrence: 'monthly', anchorDate: '2026-11-10', endDate: null, notifyDaysBefore: 14, origin: 'manual' },
      by,
      T0,
    );
    detectRecurrences(db, { today: TODAY, now: T0 });
    assert.deepEqual(summary(db), ['携帯:monthly:3120', '水道:bimonthly:6000', '自動車税:yearly:39500'].sort());
    db.prepare('UPDATE scheduled_items SET active = 0 WHERE id = ?').run(it.id);
    assert.equal(detectRecurrences(db, { today: TODAY, now: T0 }).created, 1);
    db.close();
  });
});

describe('既存の候補・予定項目との重複', () => {
  const systemDismissals = (db: Db) =>
    db.prepare("SELECT entity_id, payload_json FROM audit_log WHERE actor = 'system' AND action = 'recurrence_candidate.dismissed'").all() as {
      entity_id: string;
      payload_json: string;
    }[];

  test('値上げで open の候補を置き換える（古い方は system が dismissed、updated = 1）', () => {
    const { db, A } = fresh();
    for (const ym of MONTHS) if (ym < '2026-07') txn(db, A, day(ym, 10), 3000, '携帯');
    assert.deepEqual(detectRecurrences(db, { today: '2026-07-01', now: T0 }), { created: 1, updated: 0 });
    const old = listRecurrenceCandidates(db)[0];
    for (const ym of MONTHS) if (ym >= '2026-07') txn(db, A, day(ym, 10), 3500, '携帯');
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 1, updated: 1 });
    const all = listRecurrenceCandidates(db);
    const neu = all.find((c) => c.amount === 3500)!;
    assert.equal(all.find((c) => c.id === old.id)!.state, 'dismissed');
    assert.equal(neu.state, 'open');
    assert.deepEqual(
      systemDismissals(db).map((r) => [r.entity_id, JSON.parse(r.payload_json)]),
      [[old.id, { reason: 'superseded', by: neu.id }]],
    );
    assert.equal(verifyAudit(db).ok, true);
    // もう一度回しても変わらない。
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 0, updated: 0 });
    db.close();
  });

  test('人が dismissed にした候補には触らない', () => {
    const { db, A } = fresh();
    for (const ym of MONTHS) if (ym < '2026-07') txn(db, A, day(ym, 10), 3000, '携帯');
    detectRecurrences(db, { today: '2026-07-01', now: T0 });
    const old = listRecurrenceCandidates(db)[0];
    const d = dismissCandidate(db, old.id, by, T0);
    for (const ym of MONTHS) if (ym >= '2026-07') txn(db, A, day(ym, 10), 3500, '携帯');
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 1, updated: 0 });
    assert.deepEqual(listRecurrenceCandidates(db).find((c) => c.id === old.id), d);
    assert.deepEqual(systemDismissals(db), []);
    db.close();
  });

  test('system が superseded で dismissed にした候補は、作らない判定に数えない', () => {
    const { db, A } = fresh();
    const yms = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
    const ids = yms.map((ym) => txn(db, A, day(ym, 10), 5000, 'テスト保険'));
    const occ = ids.slice(0, 3).map((id, i) => ({ date: day(yms[i], 10), amount: 5000, bank_txn_id: id }));
    // 同じ摘要・周期・金額の候補を、system が superseded で dismissed にした状態で置く。
    const sys = insertRecurrenceCandidate(db, { accountId: A, descriptionNorm: 'テスト保険', interval: 'monthly', amount: 5000, occurrences: occ, now });
    setRecurrenceCandidateState(db, sys.id, 'dismissed', null, now);
    appendAudit(db, { actor: 'system', action: 'recurrence_candidate.dismissed', entity: 'recurrence_candidate', entityId: sys.id, payload: { reason: 'superseded', by: 'X' } }, T0);
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 1, updated: 0 });
    const neu = listRecurrenceCandidates(db, { state: 'open' });
    assert.equal(neu.length, 1);
    // 人が dismissed にすると、次からは作らない。
    dismissCandidate(db, neu[0].id, by, T0);
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 0, updated: 0 });
    db.close();
  });

  test('明細が重なる open の候補は周期が違っても置き換える（人が dismissed にしたもの・重ならないものは触らない）', () => {
    const { db, A } = fresh();
    const ids = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((ym) =>
      txn(db, A, day(ym, 10), 5000, 'テスト保険'),
    );
    const other = ['2026-08', '2026-09', '2026-10'].map((ym) => txn(db, A, day(ym, 20), 1000, 'テスト回線'));
    // 前の版の検出で作られた候補を置く: 同じ明細を含む「毎年」と「3 か月ごと」（後者は人が却下）、重ならない別の摘要。
    const occ = (xs: string[]) => xs.map((id) => ({ ...(db.prepare('SELECT txn_date AS date, amount FROM bank_txns WHERE id = ?').get(id) as { date: string; amount: number }), bank_txn_id: id }));
    const yearly = insertRecurrenceCandidate(db, { accountId: A, descriptionNorm: 'テスト保険', interval: 'yearly', amount: 5000, occurrences: occ([ids[0], ids[11]]), now });
    const quarterly = insertRecurrenceCandidate(db, { accountId: A, descriptionNorm: 'テスト保険', interval: 'quarterly', amount: 5000, occurrences: occ([ids[5], ids[8], ids[11]]), now });
    const q = dismissCandidate(db, quarterly.id, by, T0);
    const keep = insertRecurrenceCandidate(db, { accountId: A, descriptionNorm: 'テスト回線', interval: 'monthly', amount: 1000, occurrences: occ(other), now });

    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 1, updated: 1 });
    const all = listRecurrenceCandidates(db);
    const neu = all.find((c) => c.interval === 'monthly' && c.description_norm === 'テスト保険')!;
    assert.equal(neu.state, 'open');
    assert.equal(all.find((c) => c.id === yearly.id)!.state, 'dismissed');
    assert.deepEqual(all.find((c) => c.id === quarterly.id), q);
    assert.equal(all.find((c) => c.id === keep.id)!.state, 'open');
    assert.deepEqual(
      systemDismissals(db).map((r) => [r.entity_id, JSON.parse(r.payload_json)]),
      [[yearly.id, { reason: 'superseded', by: neu.id }]],
    );
    assert.equal(verifyAudit(db).ok, true);
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 0, updated: 0 });
    db.close();
  });

  test('金額違いの月額 2 本は互いを置き換えない', () => {
    const { db, A } = fresh();
    for (const ym of MONTHS) {
      txn(db, A, day(ym, 5), 5000, '保険料');
      txn(db, A, day(ym, 20), 8000, '保険料');
    }
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 2, updated: 0 });
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 0, updated: 0 });
    assert.equal(listRecurrenceCandidates(db, { state: 'open' }).length, 2);
    db.close();
  });

  test('金額が ±5% 以内なら既存の候補と同じとみなす（作らない）', () => {
    const { db, A } = fresh();
    for (const ym of MONTHS) if (ym < '2026-07') txn(db, A, day(ym, 10), 3000, '携帯');
    detectRecurrences(db, { today: '2026-07-01', now: T0 });
    for (const ym of MONTHS) if (ym >= '2026-07') txn(db, A, day(ym, 10), 3150, '携帯');
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 0, updated: 0 });
    db.close();
  });

  test('同じ口座・同じ周期・金額 ±5% の active な予定項目があれば、名前が違っても作らない', () => {
    const { db, A } = fresh();
    for (const ym of MONTHS) txn(db, A, day(ym, 27), 80000, '家賃');
    const mk = (recurrence: 'monthly' | 'yearly', amount: number) =>
      createItem(
        db,
        { name: '事務所の家賃', amount, direction: 'out', category: 'other', accountId: A, recurrence, anchorDate: '2026-11-27', endDate: null, notifyDaysBefore: 14, origin: 'manual' },
        by,
        T0,
      );
    mk('yearly', 80000); // 周期が違う
    mk('monthly', 84001); // 5% を超える
    assert.equal(detectRecurrences(db, { today: TODAY, now: T0 }).created, 1);
    db.close();
    const f = fresh();
    for (const ym of MONTHS) txn(f.db, f.A, day(ym, 27), 80000, '家賃');
    createItem(
      f.db,
      { name: '事務所の家賃', amount: 84000, direction: 'out', category: 'other', accountId: f.A, recurrence: 'monthly', anchorDate: '2026-11-27', endDate: null, notifyDaysBefore: 14, origin: 'manual' },
      by,
      T0,
    );
    assert.equal(detectRecurrences(f.db, { today: TODAY, now: T0 }).created, 0);
    f.db.close();
  });
});

describe('次の期日（anchor_date）', () => {
  const cand = (interval: 'monthly' | 'yearly', dates: string[]) =>
    ({ interval, occurrences_json: JSON.stringify(dates.map((date, i) => ({ date, amount: 1000, bank_txn_id: `T${i}` }))) }) as Parameters<
      typeof nextDueFromCandidate
    >[0];
  const CASES: [string, 'monthly' | 'yearly', string[], string][] = [
    ['最後だけずれた日は最頻値に戻す', 'monthly', ['2026-07-27', '2026-08-27', '2026-09-27', '2026-10-28'], '2026-11-27'],
    ['月末が多ければ月末（30 日の月は 30 日）', 'monthly', ['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31'], '2026-11-30'],
    ['月末が多ければ月末（31 日の月は 31 日）', 'monthly', ['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30'], '2026-12-31'],
    ['同数なら新しい出現の日', 'yearly', ['2025-05-20', '2026-05-22'], '2027-05-22'],
    ['2 月の 28 日は月末として数える', 'monthly', ['2026-01-31', '2026-02-28', '2026-03-31'], '2026-04-30'],
  ];
  for (const [label, interval, dates, want] of CASES) {
    test(label, () => assert.equal(nextDueFromCandidate(cand(interval, dates)), want));
  }
});

describe('acceptCandidate / dismissCandidate', () => {
  test('受け入れると台帳に入り、次の期日は最後の出現日 + 周期。監査に残る', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    detectRecurrences(db, { today: TODAY, now: T0 });
    const byName = (s: string) => listRecurrenceCandidates(db).find((c) => c.description_norm === s)!;
    const expect: Record<string, string> = { 家賃: '2026-11-27', 携帯: '2026-11-10', 水道: '2026-11-15', 自動車税: '2027-05-22' };
    for (const [name, due] of Object.entries(expect)) assert.equal(nextDueFromCandidate(byName(name)), due, name);

    const { candidate, item } = acceptCandidate(db, byName('自動車税').id, by, { category: 'tax' }, T0);
    assert.equal(candidate.state, 'accepted');
    assert.equal(candidate.scheduled_item_id, item.id);
    assert.equal(item.name, '自動車税');
    assert.equal(item.amount, 39500);
    assert.equal(item.direction, 'out');
    assert.equal(item.category, 'tax');
    assert.equal(item.account_id, A);
    assert.equal(item.recurrence, 'yearly');
    assert.equal(item.anchor_date, '2027-05-22');
    assert.equal(item.origin, 'detected');
    assert.equal(item.active, 1);

    const r2 = acceptCandidate(db, byName('家賃').id, by, { name: '  事務所家賃 ' }, T0);
    assert.equal(r2.item.name, '事務所家賃');
    assert.equal(r2.item.category, 'other');
    assert.equal(r2.item.anchor_date, '2026-11-27');

    const r3 = acceptCandidate(db, byName('携帯').id, by, { amount: 3300 }, T0);
    assert.equal(r3.item.amount, 3300);

    const actions = (db.prepare('SELECT action FROM audit_log ORDER BY seq').all() as { action: string }[]).map((r) => r.action);
    assert.deepEqual(actions, ['scheduled_item.created', 'recurrence_candidate.accepted', 'scheduled_item.created', 'recurrence_candidate.accepted', 'scheduled_item.created', 'recurrence_candidate.accepted']);
    assert.equal(verifyAudit(db).ok, true);

    // 受け入れたものは再検出で作らない（名前を変えても、候補が accepted のまま残る）。
    assert.equal(detectRecurrences(db, { today: TODAY, now: T0 }).created, 0);
    // 2 回は受け入れられない。却下もできない。
    assert.throws(() => acceptCandidate(db, byName('家賃').id, by, {}, T0), /not_open/);
    assert.throws(() => dismissCandidate(db, byName('家賃').id, by, T0), /not_open/);
    assert.equal(listScheduledItems(db).length, 3);
    db.close();
  });

  test('3 か月ごと: 検出して受け入れると quarterly の項目になり、次の期日は最後の出現月 + 3 か月', () => {
    const { db, A } = fresh();
    for (const d of ['2026-02-20', '2026-05-20', '2026-08-20']) txn(db, A, d, 45000, '国保');
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 1, updated: 0 });
    const c = listRecurrenceCandidates(db)[0];
    assert.equal(c.interval, 'quarterly');
    assert.equal(nextDueFromCandidate(c), '2026-11-20');
    const { candidate, item } = acceptCandidate(db, c.id, by, { category: 'insurance' }, T0);
    assert.equal(candidate.state, 'accepted');
    assert.equal(item.recurrence, 'quarterly');
    assert.equal(item.anchor_date, '2026-11-20');
    assert.equal(item.category, 'insurance');
    assert.equal(item.origin, 'detected');
    // 受け入れた後は再検出で作らない。
    assert.equal(detectRecurrences(db, { today: TODAY, now: T0 }).created, 0);
    assert.equal(verifyAudit(db).ok, true);
    db.close();
  });

  test('値が不正なら台帳も候補も変わらない', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    detectRecurrences(db, { today: TODAY, now: T0 });
    const c = listRecurrenceCandidates(db)[0];
    assert.throws(() => acceptCandidate(db, c.id, by, { category: 'income' }, T0), /invalid_category_for_direction/);
    assert.throws(() => acceptCandidate(db, c.id, by, { name: ' ' }, T0), /invalid_name/);
    assert.throws(() => acceptCandidate(db, c.id, by, { amount: 0 }, T0), /invalid_amount/);
    assert.throws(() => acceptCandidate(db, 'nope', by, {}, T0), /not_found/);
    assert.equal(listScheduledItems(db).length, 0);
    assert.equal(listRecurrenceCandidates(db, { state: 'open' }).length, 4);
    db.close();
  });

  test('却下したものは次回作らない。却下は監査に残り、2 回目はそのまま', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    detectRecurrences(db, { today: TODAY, now: T0 });
    const c = listRecurrenceCandidates(db).find((x) => x.description_norm === '水道')!;
    const d = dismissCandidate(db, c.id, by, T0);
    assert.equal(d.state, 'dismissed');
    assert.equal(d.scheduled_item_id, null);
    assert.deepEqual(dismissCandidate(db, c.id, by, T0), d);
    assert.equal((db.prepare("SELECT count(*) n FROM audit_log WHERE action = 'recurrence_candidate.dismissed'").get() as { n: number }).n, 1);
    // 明細が増えても同じ条件では出さない。
    txn(db, A, '2026-11-05', 6000, '水道');
    assert.equal(detectRecurrences(db, { today: TODAY, now: T0 }).created, 0);
    assert.equal(listRecurrenceCandidates(db).length, 4);
    db.close();
  });
});

describe('/api/recurrence_candidates', () => {
  const HOST = '127.0.0.1:8787';
  const USER = 'me@example.com';
  let db: Db;
  let app: Hono;
  beforeEach(() => {
    db?.close();
    const f = fresh();
    db = f.db;
    seed(db, f.A, f.B);
    app = new Hono();
    app.use('*', createAuth({ allowedUsers: [USER], allowedHosts: [HOST] }));
    app.route('/api', cashflowRoutes({ db, now: () => T0, config: { cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false } } }));
  });
  const headers = { Host: HOST, 'Tailscale-User-Login': USER, 'content-type': 'application/json' };
  const get = (url: string) => app.request(url, { headers });
  const post = (url: string, body?: unknown) =>
    app.request(url, { method: 'POST', headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

  test('detect → 一覧 → accept / dismiss', async () => {
    let res = await post('/api/recurrence_candidates/detect');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { created: 4, updated: 0 });
    res = await post('/api/recurrence_candidates/detect');
    assert.deepEqual(await res.json(), { created: 0, updated: 0 });

    res = await get('/api/recurrence_candidates?state=open');
    assert.equal(res.status, 200);
    const { candidates } = (await res.json()) as { candidates: { id: string; description_norm: string }[] };
    assert.equal(candidates.length, 4);
    const id = (s: string) => candidates.find((c) => c.description_norm === s)!.id;

    res = await post(`/api/recurrence_candidates/${id('自動車税')}/accept`, { category: 'car' });
    assert.equal(res.status, 200);
    const acc = (await res.json()) as { candidate: { state: string }; item: { category: string; anchor_date: string; origin: string } };
    assert.equal(acc.candidate.state, 'accepted');
    assert.deepEqual([acc.item.category, acc.item.anchor_date, acc.item.origin], ['car', '2027-05-22', 'detected']);
    const actor = db.prepare("SELECT payload_json FROM audit_log WHERE action = 'recurrence_candidate.accepted'").get() as { payload_json: string };
    assert.equal(JSON.parse(actor.payload_json).user, USER);

    res = await post(`/api/recurrence_candidates/${id('水道')}/dismiss`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { state: string }).state, 'dismissed');

    res = await get('/api/recurrence_candidates?state=open');
    assert.equal(((await res.json()) as { candidates: unknown[] }).candidates.length, 2);
    res = await get('/api/recurrence_candidates');
    assert.equal(((await res.json()) as { candidates: unknown[] }).candidates.length, 4);

    // 受け入れ済みは 400。
    res = await post(`/api/recurrence_candidates/${id('自動車税')}/accept`, {});
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'not_open' });
  });

  test('一覧の各候補に最新の明細の正規化前の摘要と口座名が付く', async () => {
    const A = (db.prepare("SELECT id FROM money_accounts WHERE name = '銀行A'").get() as { id: string }).id;
    const norm = 'ntt東日本光コラボ回収代行分';
    MONTHS.forEach((ym, i) => {
      const description = i === MONTHS.length - 1 ? 'NTT東日本光コラボ回収代行分' : 'ＮＴＴ東日本光コラボ回収代行分';
      insertBankTxn(db, { accountId: A, txnDate: day(ym, 12), amount: 5500, side: 'expense', description, descriptionNorm: norm, now });
    });
    await post('/api/recurrence_candidates/detect');
    const { candidates } = (await (await get('/api/recurrence_candidates')).json()) as {
      candidates: { description_norm: string; description: string | null; account_name: string | null }[];
    };
    assert.equal(candidates.length, 5);
    const c = candidates.find((x) => x.description_norm === norm)!;
    assert.deepEqual([c.description, c.account_name], ['NTT東日本光コラボ回収代行分', '銀行A']);
    for (const x of candidates) assert.equal(x.account_name, '銀行A');
    assert.equal(candidates.find((x) => x.description_norm === '家賃')!.description, '家賃');
  });

  test('不正な入力は 400 / 404', async () => {
    await post('/api/recurrence_candidates/detect');
    const { candidates } = (await (await get('/api/recurrence_candidates')).json()) as { candidates: { id: string }[] };
    const cid = candidates[0].id;
    const cases: [string, unknown, number, string][] = [
      [`/api/recurrence_candidates/${cid}/accept`, '{', 400, 'invalid_json'],
      [`/api/recurrence_candidates/${cid}/accept`, { interval: 'yearly' }, 400, 'invalid_field'],
      [`/api/recurrence_candidates/${cid}/accept`, { amount: 1.5 }, 400, 'invalid_amount'],
      [`/api/recurrence_candidates/${cid}/accept`, { category: 'food' }, 400, 'invalid_category'],
      [`/api/recurrence_candidates/${cid}/accept`, { name: 1 }, 400, 'invalid_name'],
      ['/api/recurrence_candidates/nope/accept', {}, 404, 'not_found'],
      ['/api/recurrence_candidates/nope/dismiss', undefined, 404, 'not_found'],
    ];
    for (const [url, body, status, error] of cases) {
      const res = await post(url, body);
      assert.equal(res.status, status, `${url} ${JSON.stringify(body)}`);
      assert.deepEqual(await res.json(), { error });
    }
    const res = await get('/api/recurrence_candidates?state=closed');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_state' });
    assert.equal(listScheduledItems(db).length, 0);
  });
});
