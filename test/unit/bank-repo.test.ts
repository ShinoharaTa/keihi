// マイグレーション 0005_bank とリポジトリ層（docs/mvp-plan-v3.md T102）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { integrityCheck, openDb, type Db } from '../../src/db/index.ts';
import { listMigrations, migrate } from '../../src/db/migrate.ts';
import {
  addBankTxnSource,
  appendBalance,
  appendTxnTag,
  findBankTxnByExternalId,
  getAccount,
  getBankTxn,
  getSyncStatus,
  insertAccount,
  insertBankTxn,
  latestBalance,
  latestTxnTag,
  listAccounts,
  listBankTxnSources,
  touchBankTxn,
  updateAccountSettings,
  updateSyncStatus,
  upsertFreeeAccount,
} from '../../src/bank/repo.ts';

const now = '2026-11-06T00:00:00.000Z';
const later = '2026-11-07T00:00:00.000Z';
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-bank-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function freshDb(): Db {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  return db;
}

const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

describe('0005_bank のマイグレーション', () => {
  test('空の DB から上がる', () => {
    const db = openDb(path.join(root, `${n++}.db`));
    try {
      assert.ok(migrate(db).includes('0005_bank.sql'));
      assert.deepEqual(integrityCheck(db), []);
      for (const t of ['money_accounts', 'bank_txns', 'bank_txn_sources', 'csv_imports', 'account_balances', 'txn_tags', 'tag_rules', 'transfer_links', 'sync_status', 'freee_rule_links']) {
        assert.equal(count(db, t), 0, t);
      }
    } finally {
      db.close();
    }
  });

  test('0004 まで上げた DB（既存の行あり）から上がる', () => {
    const db = openDb(path.join(root, `${n++}.db`));
    try {
      const ms = listMigrations();
      const upTo4 = ms.filter((m) => m.version <= 4);
      assert.equal(upTo4.at(-1)!.name, '0004_deals.sql');
      migrate(db, upTo4);
      db.prepare(`INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source,
        deadline_on, deadline_mode, storage_key, created_at) VALUES ('D1', ?, 1, 'image/jpeg', 'pwa', 'scan', ?, '2026-11-06', 'server',
        '2026-11-17', 'early', 'x', ?)`).run('0'.repeat(64), now, now);
      assert.deepEqual(migrate(db, ms), ms.filter((m) => m.version > 4).map((m) => m.name));
      assert.equal(count(db, 'documents'), 1);
      assert.equal(count(db, 'money_accounts'), 0);
      assert.deepEqual(integrityCheck(db), []);
    } finally {
      db.close();
    }
  });
});

describe('0005_bank の制約', () => {
  let db: Db;
  let acc: string;
  let acc2: string;
  let txn: string;
  let txn2: string;
  before(() => {
    db = freshDb();
    acc = insertAccount(db, { provider: 'freee', name: '普通預金', kind: 'bank', source: 'freee', freeeWalletableId: 'bank_account:1', now }).id;
    acc2 = insertAccount(db, { provider: 'freee', name: 'PayPay', kind: 'paypay', source: 'csv', now }).id;
    txn = insertBankTxn(db, { accountId: acc, txnDate: '2026-11-01', amount: 1000, side: 'expense', description: 'ｺﾝﾋﾞﾆ', descriptionNorm: 'コンビニ', freeeStatus: 1, dueAmount: 1000, balance: 5000, now }).id;
    txn2 = insertBankTxn(db, { accountId: acc2, txnDate: '2026-11-01', amount: 1000, side: 'income', description: 'チャージ', descriptionNorm: 'チャージ', now }).id;
    db.exec(`INSERT INTO csv_imports (id, account_id, parser_id, file_sha256, storage_key, rows_total, rows_new, rows_merged, rows_error, actor, imported_at)
      VALUES ('I1', '${acc2}', 'paypay', 'f1', 'k1', 1, 1, 0, 0, 'user', '${now}')`);
  });
  after(() => db.close());

  test('追記専用の表は UPDATE / DELETE を拒否', () => {
    addBankTxnSource(db, { bankTxnId: txn, source: 'freee', externalId: '100' });
    appendBalance(db, { accountId: acc, asOfDate: '2026-11-01', balance: 5000, source: 'freee_walletable', now });
    appendTxnTag(db, { bankTxnId: txn, tag: 'business', source: 'human', actor: 'user', decidedAt: now });
    db.exec(`INSERT INTO transfer_links (id, out_txn_id, in_txn_id, kind, source, state, created_at) VALUES ('L1', '${txn}', '${txn2}', 'charge', 'auto', 'active', '${now}')`);
    db.exec(`INSERT INTO freee_rule_links (id, account_id, remote_matcher_id, act, state, created_at) VALUES ('F1', '${acc}', '9', 4, 'active', '${now}')`);
    const cols: [string, string][] = [
      ['bank_txn_sources', 'external_id'],
      ['csv_imports', 'rows_new'],
      ['account_balances', 'balance'],
      ['txn_tags', 'tag'],
      ['transfer_links', 'state'],
      ['freee_rule_links', 'state'],
    ];
    for (const [table, col] of cols) {
      const before = count(db, table);
      assert.ok(before >= 1, table);
      assert.throws(() => db.exec(`UPDATE ${table} SET ${col} = ${col}`), /追記専用/, table);
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /追記専用/, table);
      assert.equal(count(db, table), before, table);
    }
  });

  test('bank_txns は削除できず、freee_status・due_amount・last_seen_at だけ更新できる', () => {
    assert.throws(() => db.exec(`DELETE FROM bank_txns WHERE id = '${txn}'`), /削除できない/);
    for (const set of [`account_id = '${acc2}'`, `txn_date = '2026-11-02'`, 'amount = 999', `side = 'income'`, `description = 'x'`,
      `description_norm = 'x'`, 'balance = 1', `first_seen_at = '${later}'`, `id = 'X'`]) {
      assert.throws(() => db.exec(`UPDATE bank_txns SET ${set} WHERE id = '${txn}'`), /不変の列/, set);
    }
    db.exec(`UPDATE bank_txns SET freee_status = 2, due_amount = 0, last_seen_at = '${later}' WHERE id = '${txn}'`);
  });

  test('bank_txns の balance は NULL → 値 だけ更新でき、値 → 別の値・NULL は拒否', () => {
    const t = insertBankTxn(db, { accountId: acc2, txnDate: '2026-11-03', amount: 10, side: 'expense', description: 'b', descriptionNorm: 'b', now }).id;
    db.exec(`UPDATE bank_txns SET balance = 900 WHERE id = '${t}'`);
    assert.equal(getBankTxn(db, t)!.balance, 900);
    assert.throws(() => db.exec(`UPDATE bank_txns SET balance = 800 WHERE id = '${t}'`), /不変の列/);
    assert.throws(() => db.exec(`UPDATE bank_txns SET balance = NULL WHERE id = '${t}'`), /不変の列/);
    db.exec(`UPDATE bank_txns SET balance = 900 WHERE id = '${t}'`);
  });

  test('bank_txns の CHECK（金額は正の整数、side・freee_status の値）', () => {
    const ins = (amount: string, side = 'expense', status = 'NULL') =>
      db.exec(`INSERT INTO bank_txns (id, account_id, txn_date, amount, side, description, description_norm, freee_status, first_seen_at, last_seen_at)
        VALUES ('C${n++}', '${acc}', '2026-11-01', ${amount}, '${side}', 'd', 'd', ${status}, '${now}', '${now}')`);
    for (const [a, s, st] of [['0'], ['-1'], ['1.5'], [`'abc'`], ['1', 'out'], ['1', 'expense', '5']] as [string, string?, string?][]) {
      assert.throws(() => ins(a, s, st), /CHECK/, `${a} ${s} ${st}`);
    }
    assert.throws(() => db.exec(`UPDATE bank_txns SET due_amount = 1.5 WHERE id = '${txn}'`), /CHECK/);
  });

  test('money_accounts は設定の列だけ更新でき、kind・source・freee_walletable_id は変えられない', () => {
    for (const set of [`kind = 'card'`, `source = 'csv'`, `provider = 'fake'`, `freee_walletable_id = 'bank_account:2'`, `created_at = '${later}'`, `id = 'X'`]) {
      assert.throws(() => db.exec(`UPDATE money_accounts SET ${set} WHERE id = '${acc}'`), /不変の列/, set);
    }
    assert.throws(() => db.exec(`UPDATE money_accounts SET default_tag = 'mixed' WHERE id = '${acc}'`), /CHECK/);
    assert.throws(() => db.exec(`UPDATE money_accounts SET mcp_visibility = 'all' WHERE id = '${acc}'`), /CHECK/);
    assert.throws(() => insertAccount(db, { provider: 'freee', name: 'x', kind: 'bank', source: 'freee', freeeWalletableId: 'bank_account:1', now }), /UNIQUE/);
    // provider が違えば同じ walletable でもよい（poc → prod の切り替え、fake）。
    insertAccount(db, { provider: 'fake', name: 'x', kind: 'bank', source: 'freee', freeeWalletableId: 'bank_account:1', now });
    assert.throws(() => insertAccount(db, { provider: 'other' as never, name: 'x', kind: 'bank', source: 'csv', now }), /CHECK/);
    assert.throws(() => db.exec(`UPDATE money_accounts SET card_settlement_account_id = id WHERE id = '${acc}'`), /CHECK/);
    db.exec(`UPDATE money_accounts SET active = 0 WHERE id = '${acc2}'`);
    assert.throws(() => db.exec(`UPDATE money_accounts SET active = 2 WHERE id = '${acc2}'`), /CHECK/);
  });

  test('money_accounts の source と freee_walletable_id の整合', () => {
    assert.throws(() => insertAccount(db, { provider: 'freee', name: 'x', kind: 'paypay', source: 'csv', freeeWalletableId: 'wallet:9', now }), /CHECK/);
    assert.throws(() => insertAccount(db, { provider: 'freee', name: 'x', kind: 'bank', source: 'freee', now }), /CHECK/);
  });

  test('UNIQUE: 口座・取得元・外部 ID、口座・ファイル、明細・版', () => {
    assert.throws(() => addBankTxnSource(db, { bankTxnId: txn, source: 'freee', externalId: '100' }), /UNIQUE/);
    // 取得元が違えば同じ外部 ID でもよい。口座が違っても同じ。
    addBankTxnSource(db, { bankTxnId: txn, source: 'csv', externalId: '100' });
    addBankTxnSource(db, { bankTxnId: txn2, source: 'freee', externalId: '100', csvImportId: null });
    assert.throws(() => db.exec(`INSERT INTO csv_imports (id, account_id, parser_id, file_sha256, storage_key, rows_total, rows_new, rows_merged, rows_error, actor, imported_at)
      VALUES ('I2', '${acc2}', 'paypay', 'f1', 'k2', 1, 1, 0, 0, 'user', '${now}')`), /UNIQUE/);
    db.exec(`INSERT INTO csv_imports (id, account_id, parser_id, file_sha256, storage_key, rows_total, rows_new, rows_merged, rows_error, actor, imported_at)
      VALUES ('I3', '${acc}', 'paypay', 'f1', 'k3', 1, 1, 0, 0, 'user', '${now}')`);
    assert.throws(() => db.exec(`INSERT INTO txn_tags (bank_txn_id, version, tag, source, actor, decided_at) VALUES ('${txn}', 1, 'private', 'human', 'user', '${now}')`), /UNIQUE/);
  });

  test('bank_txn_sources の account_id は明細の口座と同じでないと入らない', () => {
    assert.throws(() => db.exec(`INSERT INTO bank_txn_sources (bank_txn_id, account_id, source, external_id) VALUES ('${txn}', '${acc2}', 'csv', 'zz')`), /口座と違う/);
    assert.throws(() => addBankTxnSource(db, { bankTxnId: 'NOPE', source: 'csv', externalId: 'zz' }), /無い/);
    // csv_import_id が指す取り込みの口座も明細の口座と同じでないといけない（I1 は acc2 の取り込み）。
    assert.throws(() => addBankTxnSource(db, { bankTxnId: txn, source: 'csv', externalId: 'zz', csvImportId: 'I1' }), /口座と違う/);
    addBankTxnSource(db, { bankTxnId: txn2, source: 'csv', externalId: 'zz', csvImportId: 'I1' });
  });

  test('transfer_links: card_settlement だけ in_txn_id が NULL でよい。out = in は拒否', () => {
    const ins = (id: string, kind: string, inTxn: string | null, out = txn) =>
      db.prepare(`INSERT INTO transfer_links (id, out_txn_id, in_txn_id, kind, source, state, created_at) VALUES (?, ?, ?, ?, 'auto', 'active', ?)`).run(id, out, inTxn, kind, now);
    ins('L2', 'card_settlement', null);
    assert.throws(() => ins('L3', 'transfer', null), /CHECK/);
    assert.throws(() => ins('L4', 'charge', null), /CHECK/);
    assert.throws(() => ins('L5', 'transfer', txn), /CHECK/);
    assert.throws(() => ins('L2', 'transfer', txn2), /UNIQUE/);
    const seqs = db.prepare(`SELECT seq FROM transfer_links ORDER BY seq`).all() as { seq: number }[];
    assert.ok(seqs.length >= 2 && seqs.every((r, i) => i === 0 || r.seq > seqs[i - 1].seq));
  });

  test('freee_rule_links の act は 4 か 12', () => {
    db.exec(`INSERT INTO freee_rule_links (id, account_id, remote_matcher_id, act, state, created_at) VALUES ('F2', '${acc}', '10', 12, 'active', '${now}')`);
    assert.throws(() => db.exec(`INSERT INTO freee_rule_links (id, account_id, remote_matcher_id, act, state, created_at) VALUES ('F3', '${acc}', '11', 1, 'active', '${now}')`), /CHECK/);
  });

  test('外部キーと enum の CHECK', () => {
    assert.throws(() => insertBankTxn(db, { accountId: 'NOPE', txnDate: '2026-11-01', amount: 1, side: 'income', description: 'd', descriptionNorm: 'd', now }), /FOREIGN KEY/);
    assert.throws(() => db.exec(`INSERT INTO transfer_links (id, out_txn_id, in_txn_id, kind, source, state, created_at) VALUES ('L9', '${txn}', '${txn2}', 'loan', 'auto', 'active', '${now}')`), /CHECK/);
    assert.throws(() => db.exec(`INSERT INTO tag_rules (id, pattern, match, tag, origin, created_at, updated_at) VALUES ('R9', 'p', 'regex', 'business', 'manual', '${now}', '${now}')`), /CHECK/);
    assert.throws(() => appendBalance(db, { accountId: acc, asOfDate: '2026-11-01', balance: 1, source: 'guess' as never, now }), /CHECK/);
  });

  test('tag_rules と sync_status は更新できる', () => {
    db.exec(`INSERT INTO tag_rules (id, account_id, pattern, match, tag, origin, created_at, updated_at) VALUES ('R1', '${acc}', 'コンビニ', 'prefix', 'private', 'learned', '${now}', '${now}')`);
    db.exec(`UPDATE tag_rules SET hit_count = hit_count + 1, tag = 'business', updated_at = '${later}' WHERE id = 'R1'`);
    assert.equal((db.prepare(`SELECT hit_count FROM tag_rules WHERE id = 'R1'`).get() as { hit_count: number }).hit_count, 1);
    updateSyncStatus(db, acc, { lastSyncAt: now });
    updateSyncStatus(db, acc, { lastSyncAt: later });
    assert.equal(getSyncStatus(db, acc)!.last_sync_at, later);
  });
});

describe('src/bank/repo.ts', () => {
  let db: Db;
  before(() => {
    db = freshDb();
  });
  after(() => db.close());

  test('upsertFreeeAccount: 2 回目は行を増やさず名前だけ変える。既定は unset / summary / 1', () => {
    const a = upsertFreeeAccount(db, { provider: 'freee', freeeWalletableId: 'credit_card:1', name: 'カード', kind: 'card', now });
    assert.equal(a.source, 'freee');
    assert.equal(a.default_tag, 'unset');
    assert.equal(a.mcp_visibility, 'summary');
    assert.equal(a.include_in_cashflow, 1);
    const same = upsertFreeeAccount(db, { provider: 'freee', freeeWalletableId: 'credit_card:1', name: 'カード', kind: 'card', now: later });
    assert.equal(same.updated_at, now);
    const b = upsertFreeeAccount(db, { provider: 'freee', freeeWalletableId: 'credit_card:1', name: 'カード（新）', kind: 'card', now: later });
    assert.equal(b.id, a.id);
    assert.equal(b.name, 'カード（新）');
    assert.equal(b.updated_at, later);
    // type が違えば別の口座。
    upsertFreeeAccount(db, { provider: 'freee', freeeWalletableId: 'bank_account:1', name: '普通', kind: 'bank', now });
    assert.equal(listAccounts(db).length, 2);
  });

  test('upsertFreeeAccount の再同期は設定の列（default_tag・mcp_visibility・card_settlement_*・active）を上書きしない', () => {
    const settle = upsertFreeeAccount(db, { provider: 'fake', freeeWalletableId: 'bank_account:5', name: '引落', kind: 'bank', now });
    const a = upsertFreeeAccount(db, { provider: 'fake', freeeWalletableId: 'credit_card:5', name: 'C', kind: 'card', now });
    const set = updateAccountSettings(db, a.id, {
      defaultTag: 'private', mcpVisibility: 'none', includeInCashflow: false, cardSettlementAccountId: settle.id, cardSettlementPattern: 'ｶｰﾄﾞ', active: false,
    }, later)!;
    assert.equal(set.active, 0);
    const again = upsertFreeeAccount(db, { provider: 'fake', freeeWalletableId: 'credit_card:5', name: 'C2', kind: 'card', now: later });
    assert.deepEqual({ ...again }, { ...set, name: 'C2' });
    assert.equal(upsertFreeeAccount(db, { provider: 'fake', freeeWalletableId: 'credit_card:5', name: 'C2', kind: 'card', now: later }).id, a.id);
  });

  test('updateAccountSettings: 渡した設定の列だけ書く。無い口座は null', () => {
    const settle = insertAccount(db, { provider: 'freee', name: '引落口座', kind: 'bank', source: 'csv', now });
    const card = listAccounts(db).find((a) => a.kind === 'card')!;
    const r = updateAccountSettings(db, card.id, { defaultTag: 'private', includeInCashflow: false, cardSettlementAccountId: settle.id, cardSettlementPattern: 'ｶｰﾄﾞ' }, later);
    assert.equal(r!.default_tag, 'private');
    assert.equal(r!.include_in_cashflow, 0);
    assert.equal(r!.mcp_visibility, 'summary');
    assert.equal(r!.card_settlement_account_id, settle.id);
    assert.equal(r!.name, 'カード（新）');
    assert.equal(updateAccountSettings(db, card.id, { cardSettlementAccountId: null }, later)!.card_settlement_account_id, null);
    assert.equal(updateAccountSettings(db, 'NOPE', { defaultTag: 'business' }, later), null);
    assert.deepEqual(updateAccountSettings(db, card.id, {}, later), getAccount(db, card.id));
  });

  test('明細の insert・外部 ID での検索・touch', () => {
    const acc = listAccounts(db).find((a) => a.kind === 'card')!.id;
    const t = insertBankTxn(db, { accountId: acc, txnDate: '2026-11-02', amount: 2500, side: 'expense', description: 'A', descriptionNorm: 'a', freeeStatus: 1, dueAmount: 2500, now });
    assert.equal(t.first_seen_at, now);
    assert.equal(t.last_seen_at, now);
    assert.equal(t.balance, null);
    addBankTxnSource(db, { bankTxnId: t.id, source: 'freee', externalId: '777', rawSha256: 'r' });
    assert.equal(findBankTxnByExternalId(db, acc, 'freee', '777')!.id, t.id);
    assert.equal(findBankTxnByExternalId(db, acc, 'csv', '777'), null);
    assert.equal(findBankTxnByExternalId(db, 'other', 'freee', '777'), null);
    assert.deepEqual(listBankTxnSources(db, t.id).map((r) => ({ ...r })), [{ bank_txn_id: t.id, account_id: acc, source: 'freee', external_id: '777', csv_import_id: null, raw_sha256: 'r' }]);

    const u1 = touchBankTxn(db, t.id, { lastSeenAt: later });
    assert.equal(u1!.last_seen_at, later);
    assert.equal(u1!.freee_status, 1);
    const u2 = touchBankTxn(db, t.id, { lastSeenAt: later, freeeStatus: 2, dueAmount: 0 });
    assert.equal(u2!.freee_status, 2);
    assert.equal(u2!.due_amount, 0);
    // null を渡せば NULL を書く。渡さなければそのまま。
    const u3 = touchBankTxn(db, t.id, { lastSeenAt: later, freeeStatus: null });
    assert.equal(u3!.freee_status, null);
    assert.equal(u3!.due_amount, 0);
    assert.equal(touchBankTxn(db, 'NOPE', { lastSeenAt: later }), null);
  });

  test('残高の追記と最新', () => {
    const acc = listAccounts(db)[0].id;
    assert.equal(latestBalance(db, acc), null);
    appendBalance(db, { accountId: acc, asOfDate: '2026-11-02', balance: 100, source: 'freee_walletable', now });
    appendBalance(db, { accountId: acc, asOfDate: '2026-11-01', balance: 50, source: 'freee_txn', now: later });
    // 同じ as_of_date・同じ recorded_at でも、後に入れた方（seq が大きい方）。
    appendBalance(db, { accountId: acc, asOfDate: '2026-11-02', balance: -30, source: 'manual', now });
    const { seq, ...rest } = latestBalance(db, acc)!;
    assert.deepEqual({ ...rest }, { account_id: acc, as_of_date: '2026-11-02', balance: -30, source: 'manual', recorded_at: now });
    assert.equal(seq, 3);
  });

  test('txn_tags は版を追記し、最新版を返す', () => {
    const acc = listAccounts(db)[0].id;
    const t = insertBankTxn(db, { accountId: acc, txnDate: '2026-11-03', amount: 1, side: 'income', description: 'B', descriptionNorm: 'b', now });
    assert.equal(latestTxnTag(db, t.id), null);
    assert.equal(appendTxnTag(db, { bankTxnId: t.id, tag: 'business', source: 'rule', actor: 'system', decidedAt: now }).version, 1);
    const v2 = appendTxnTag(db, { bankTxnId: t.id, tag: 'private', category: '食費', source: 'human', actor: 'user', decidedAt: later });
    assert.equal(v2.version, 2);
    assert.deepEqual({ ...latestTxnTag(db, t.id)! }, { bank_txn_id: t.id, version: 2, tag: 'private', category: '食費', source: 'human', actor: 'user', decided_at: later, batch_id: null, cleared: 0 });
  });

  test('sync_status: 無ければ作り、渡したキーだけ書く', () => {
    const acc = listAccounts(db)[0].id;
    assert.equal(getSyncStatus(db, acc), null);
    updateSyncStatus(db, acc, { lastSyncAt: now, lastError: 'invalid_grant' });
    const s = updateSyncStatus(db, acc, { lastOkAt: later, lastError: null, backfillDoneUntil: '2026-08-01' });
    assert.deepEqual({ ...s }, { account_id: acc, last_sync_at: now, last_ok_at: later, last_error: null, last_csv_at: null, backfill_done_until: '2026-08-01' });
  });
});
