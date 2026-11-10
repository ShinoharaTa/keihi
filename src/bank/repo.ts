// 口座・明細の表への読み書き（docs/mvp-plan-v3.md T102、0005_bank.sql）。SQL はここに閉じ込める。
// 重複排除・振替検出・タグの決定はここに入れない（T106〜T108）。監査ログは呼ぶ側が同じトランザクションで残す。
import { tx, type Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';

export const ACCOUNT_KINDS = ['bank', 'card', 'wallet', 'paypay', 'cash'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type AccountSource = 'freee' | 'csv';
export const TAGS = ['business', 'private', 'unset'] as const;
export type Tag = (typeof TAGS)[number];
export type McpVisibility = 'full' | 'summary' | 'none';
export type TxnSide = 'income' | 'expense';
export type TxnSource = 'freee' | 'csv';
// wallet_txns の status（1 消込待ち / 2 消込済み / 3 無視 / 4 消込中 / 6 対象外）。
export type FreeeTxnStatus = 1 | 2 | 3 | 4 | 6;
export type BalanceSource = 'freee_walletable' | 'freee_txn' | 'csv' | 'manual';
export type TagSource = 'rule' | 'human' | 'agent';

export type AccountProvider = 'freee' | 'fake';

export type MoneyAccountRow = {
  id: string;
  provider: AccountProvider;
  name: string;
  kind: AccountKind;
  source: AccountSource;
  freee_walletable_id: string | null;
  default_tag: Tag;
  mcp_visibility: McpVisibility;
  include_in_cashflow: 0 | 1;
  card_settlement_account_id: string | null;
  card_settlement_pattern: string | null;
  active: 0 | 1;
  created_at: string;
  updated_at: string;
};

export type BankTxnRow = {
  id: string;
  account_id: string;
  txn_date: string;
  amount: number;
  side: TxnSide;
  description: string;
  description_norm: string;
  freee_status: FreeeTxnStatus | null;
  due_amount: number | null;
  balance: number | null;
  first_seen_at: string;
  last_seen_at: string;
};

export type BankTxnSourceRow = {
  bank_txn_id: string;
  account_id: string;
  source: TxnSource;
  external_id: string;
  csv_import_id: string | null;
  raw_sha256: string | null;
};

export type AccountBalanceRow = { seq: number; account_id: string; as_of_date: string; balance: number; source: BalanceSource; recorded_at: string };

export type TxnTagRow = {
  bank_txn_id: string;
  version: number;
  tag: Tag;
  category: string | null;
  source: TagSource;
  actor: string;
  decided_at: string;
  batch_id: string | null; // 一括の上書き・その取り消しで書いた版（0013）
  cleared: 0 | 1; // 1 は「上書きを外す」版（0013）
};

export type SyncStatusRow = {
  account_id: string;
  last_sync_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_csv_at: string | null;
  backfill_done_until: string | null;
};

// ---- money_accounts ----

export type NewAccount = {
  provider: AccountProvider;
  name: string;
  kind: AccountKind;
  source: AccountSource;
  freeeWalletableId?: string | null;
  now: string;
};

export function insertAccount(db: Db, a: NewAccount): MoneyAccountRow {
  const id = ulid();
  db.prepare(
    `INSERT INTO money_accounts (id, provider, name, kind, source, freee_walletable_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, a.provider, a.name, a.kind, a.source, a.freeeWalletableId ?? null, a.now, a.now);
  return getAccount(db, id)!;
}

// freee の walletable の口座を (provider, freee_walletable_id) で upsert する。既にあれば name だけ変える（変わったときだけ updated_at も）。
export function upsertFreeeAccount(
  db: Db,
  a: { provider: AccountProvider; freeeWalletableId: string; name: string; kind: AccountKind; now: string },
): MoneyAccountRow {
  return tx(db, () => {
    const cur = getAccountByWalletable(db, a.provider, a.freeeWalletableId);
    if (!cur) return insertAccount(db, { ...a, source: 'freee' });
    if (cur.name !== a.name) db.prepare('UPDATE money_accounts SET name = ?, updated_at = ? WHERE id = ?').run(a.name, a.now, cur.id);
    return getAccount(db, cur.id)!;
  });
}

export function getAccount(db: Db, id: string): MoneyAccountRow | null {
  return (db.prepare('SELECT * FROM money_accounts WHERE id = ?').get(id) as MoneyAccountRow | undefined) ?? null;
}

export function getAccountByWalletable(db: Db, provider: AccountProvider, freeeWalletableId: string): MoneyAccountRow | null {
  return (
    (db.prepare('SELECT * FROM money_accounts WHERE provider = ? AND freee_walletable_id = ?').get(provider, freeeWalletableId) as
      | MoneyAccountRow
      | undefined) ?? null
  );
}

export function listAccounts(db: Db): MoneyAccountRow[] {
  return db.prepare('SELECT * FROM money_accounts ORDER BY created_at, rowid').all() as MoneyAccountRow[];
}

export type AccountSettings = {
  name?: string;
  defaultTag?: Tag;
  mcpVisibility?: McpVisibility;
  includeInCashflow?: boolean;
  cardSettlementAccountId?: string | null;
  cardSettlementPattern?: string | null;
  active?: boolean;
};

const SETTING_COLUMNS: Record<keyof AccountSettings, string> = {
  name: 'name',
  defaultTag: 'default_tag',
  mcpVisibility: 'mcp_visibility',
  includeInCashflow: 'include_in_cashflow',
  cardSettlementAccountId: 'card_settlement_account_id',
  cardSettlementPattern: 'card_settlement_pattern',
  active: 'active',
};

// 設定の列だけを変える。渡したキーだけ書く。口座が無ければ null。
export function updateAccountSettings(db: Db, id: string, patch: AccountSettings, now: string): MoneyAccountRow | null {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, col] of Object.entries(SETTING_COLUMNS) as [keyof AccountSettings, string][]) {
    const v = patch[k];
    if (v === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (sets.length === 0) return getAccount(db, id);
  const r = db.prepare(`UPDATE money_accounts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now, id);
  return r.changes === 0 ? null : getAccount(db, id);
}

// ---- bank_txns / bank_txn_sources ----

export type NewBankTxn = {
  accountId: string;
  txnDate: string;
  amount: number;
  side: TxnSide;
  description: string;
  descriptionNorm: string;
  freeeStatus?: FreeeTxnStatus | null;
  dueAmount?: number | null;
  balance?: number | null;
  now: string; // first_seen_at と last_seen_at
};

export function insertBankTxn(db: Db, t: NewBankTxn): BankTxnRow {
  const id = ulid();
  db.prepare(
    `INSERT INTO bank_txns (id, account_id, txn_date, amount, side, description, description_norm, freee_status, due_amount, balance,
      first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, t.accountId, t.txnDate, t.amount, t.side, t.description, t.descriptionNorm, t.freeeStatus ?? null, t.dueAmount ?? null,
    t.balance ?? null, t.now, t.now);
  return getBankTxn(db, id)!;
}

export function getBankTxn(db: Db, id: string): BankTxnRow | null {
  return (db.prepare('SELECT * FROM bank_txns WHERE id = ?').get(id) as BankTxnRow | undefined) ?? null;
}

// 口座・取得元・外部 ID で明細を引く。
export function findBankTxnByExternalId(db: Db, accountId: string, source: TxnSource, externalId: string): BankTxnRow | null {
  return (
    (db
      .prepare(
        `SELECT t.* FROM bank_txn_sources s JOIN bank_txns t ON t.id = s.bank_txn_id
         WHERE s.account_id = ? AND s.source = ? AND s.external_id = ?`,
      )
      .get(accountId, source, externalId) as BankTxnRow | undefined) ?? null
  );
}

// 再取得したときに変わってよい列（freee_status・due_amount・last_seen_at）だけを書く。渡さなかった列はそのまま（null は NULL を書く）。
// balance は今が NULL のときだけ書く（入っていれば変えない）。
export function touchBankTxn(
  db: Db,
  id: string,
  t: { lastSeenAt: string; freeeStatus?: FreeeTxnStatus | null; dueAmount?: number | null; balance?: number | null },
): BankTxnRow | null {
  const sets = ['last_seen_at = ?'];
  const args: (string | number | null)[] = [t.lastSeenAt];
  if (t.balance !== undefined && t.balance !== null) {
    sets.push('balance = coalesce(balance, ?)');
    args.push(t.balance);
  }
  if (t.freeeStatus !== undefined) {
    sets.push('freee_status = ?');
    args.push(t.freeeStatus);
  }
  if (t.dueAmount !== undefined) {
    sets.push('due_amount = ?');
    args.push(t.dueAmount);
  }
  const r = db.prepare(`UPDATE bank_txns SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return r.changes === 0 ? null : getBankTxn(db, id);
}

// 取得元を足す。account_id は明細の口座を写す。
export function addBankTxnSource(
  db: Db,
  s: { bankTxnId: string; source: TxnSource; externalId: string; csvImportId?: string | null; rawSha256?: string | null },
): void {
  const r = db
    .prepare(
      `INSERT INTO bank_txn_sources (bank_txn_id, account_id, source, external_id, csv_import_id, raw_sha256)
       SELECT id, account_id, ?, ?, ?, ? FROM bank_txns WHERE id = ?`,
    )
    .run(s.source, s.externalId, s.csvImportId ?? null, s.rawSha256 ?? null, s.bankTxnId);
  if (r.changes === 0) throw new Error(`bank_txns に ${s.bankTxnId} が無い`);
}

// 口座の、取得元 source（既定 freee）を持つ明細の最新の日付（無ければ null）。
export function latestTxnDate(db: Db, accountId: string, source: TxnSource = 'freee'): string | null {
  return (
    db
      .prepare(
        `SELECT max(t.txn_date) d FROM bank_txns t JOIN bank_txn_sources s ON s.bank_txn_id = t.id
         WHERE t.account_id = ? AND s.source = ?`,
      )
      .get(accountId, source) as { d: string | null }
  ).d;
}

export function listBankTxnSources(db: Db, bankTxnId: string): BankTxnSourceRow[] {
  return db.prepare('SELECT * FROM bank_txn_sources WHERE bank_txn_id = ? ORDER BY rowid').all(bankTxnId) as BankTxnSourceRow[];
}

// ---- 明細の一覧と月次の集計（T110。src/bank/summary.ts） ----

export type BankTxnListRow = BankTxnRow & { account_name: string };

// SQL で絞れる条件。タグ・カテゴリは効くタグ（tags.ts）で決まるので、ここでは絞らない。
export type BankTxnSqlFilter = {
  from?: string;
  to?: string;
  accountId?: string;
  side?: TxnSide;
  amountMin?: number;
  amountMax?: number;
  // description_norm に含まれる文字列（正規化済み）。
  descriptionNorm?: string;
  // true なら active = 0 の口座の明細も含める（既定は active = 1 の口座だけ）。
  includeInactive?: boolean;
  // description_norm と完全に一致する文字列（vendor_key）。
  descriptionNormExact?: string;
};

// txn_date DESC, id DESC の順で、after（その行より後ろ）から limit 件。
export function listBankTxnsPage(
  db: Db,
  f: BankTxnSqlFilter,
  after: { txnDate: string; id: string } | null,
  limit: number,
): BankTxnListRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, ...v: (string | number)[]) => {
    where.push(sql);
    args.push(...v);
  };
  if (!f.includeInactive) where.push('a.active = 1');
  if (f.from !== undefined) add('t.txn_date >= ?', f.from);
  if (f.to !== undefined) add('t.txn_date <= ?', f.to);
  if (f.accountId !== undefined) add('t.account_id = ?', f.accountId);
  if (f.side !== undefined) add('t.side = ?', f.side);
  if (f.amountMin !== undefined) add('t.amount >= ?', f.amountMin);
  if (f.amountMax !== undefined) add('t.amount <= ?', f.amountMax);
  if (f.descriptionNorm !== undefined) add('instr(t.description_norm, ?) > 0', f.descriptionNorm);
  if (f.descriptionNormExact !== undefined) add('t.description_norm = ?', f.descriptionNormExact);
  if (after) add('(t.txn_date < ? OR (t.txn_date = ? AND t.id < ?))', after.txnDate, after.txnDate, after.id);
  return db
    .prepare(
      `SELECT t.*, a.name AS account_name FROM bank_txns t JOIN money_accounts a ON a.id = t.account_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.txn_date DESC, t.id DESC LIMIT ?`,
    )
    .all(...args, limit) as BankTxnListRow[];
}

// 日付が [from, to] の、active な口座の明細（口座名付き）。
export function listBankTxnsBetween(db: Db, from: string, to: string): BankTxnListRow[] {
  return db
    .prepare(
      `SELECT t.*, a.name AS account_name FROM bank_txns t JOIN money_accounts a ON a.id = t.account_id
       WHERE a.active = 1 AND t.txn_date BETWEEN ? AND ? ORDER BY t.txn_date, t.rowid`,
    )
    .all(from, to) as BankTxnListRow[];
}

// active な口座の明細の ID（GET /api/bank/overview の untagged_count）。
export function listAllBankTxnIds(db: Db): string[] {
  return (
    db.prepare('SELECT t.id FROM bank_txns t JOIN money_accounts a ON a.id = t.account_id WHERE a.active = 1 ORDER BY t.txn_date, t.id').all() as { id: string }[]
  ).map((r) => r.id);
}

// 口座の、残高（balance）付きの明細の日付と残高（to 以前。txn_date, id の昇順）。GET /api/balance_history。
export function listTxnBalances(db: Db, accountId: string, to: string): { txn_date: string; balance: number }[] {
  return db
    .prepare('SELECT txn_date, balance FROM bank_txns WHERE account_id = ? AND balance IS NOT NULL AND txn_date <= ? ORDER BY txn_date, id')
    .all(accountId, to) as { txn_date: string; balance: number }[];
}

// 口座の残高の記録（account_balances。as_of_date が to 以前。as_of_date, seq の昇順）。GET /api/balance_history。
export function listBalancesUpTo(db: Db, accountId: string, to: string): { as_of_date: string; balance: number }[] {
  return db
    .prepare('SELECT as_of_date, balance FROM account_balances WHERE account_id = ? AND as_of_date <= ? ORDER BY as_of_date, seq')
    .all(accountId, to) as { as_of_date: string; balance: number }[];
}

// 使っている口座（active = 1）の明細の最新の日付（無ければ null）。/api/status の bank.latest_txn_date。
export function latestTxnDateActive(db: Db): string | null {
  return (
    db.prepare('SELECT max(t.txn_date) d FROM bank_txns t JOIN money_accounts a ON a.id = t.account_id WHERE a.active = 1').get() as {
      d: string | null;
    }
  ).d;
}

// last_seen_at がちょうど lastSeenAt の明細（= その時刻の同期で取った明細）の最小の日付（無ければ null）。
export function minTxnDateSeenAt(db: Db, lastSeenAt: string): string | null {
  return (db.prepare('SELECT min(txn_date) d FROM bank_txns WHERE last_seen_at = ?').get(lastSeenAt) as { d: string | null }).d;
}

// ---- account_balances ----

export function appendBalance(db: Db, b: { accountId: string; asOfDate: string; balance: number; source: BalanceSource; now: string }): void {
  db.prepare('INSERT INTO account_balances (account_id, as_of_date, balance, source, recorded_at) VALUES (?, ?, ?, ?, ?)').run(
    b.accountId, b.asOfDate, b.balance, b.source, b.now,
  );
}

// as_of_date が最も新しい行（同じ日なら後に記録した方 = seq が大きい方）。
export function latestBalance(db: Db, accountId: string): AccountBalanceRow | null {
  return (
    (db.prepare('SELECT * FROM account_balances WHERE account_id = ? ORDER BY as_of_date DESC, seq DESC LIMIT 1').get(accountId) as
      | AccountBalanceRow
      | undefined) ?? null
  );
}

// ---- txn_tags ----

export function latestTxnTag(db: Db, bankTxnId: string): TxnTagRow | null {
  return (
    (db.prepare('SELECT * FROM txn_tags WHERE bank_txn_id = ? ORDER BY version DESC LIMIT 1').get(bankTxnId) as TxnTagRow | undefined) ?? null
  );
}

// 次の版を追記して返す（version = 今の最大 + 1）。batchId は一括の上書き・取り消しの ID、cleared は「上書きを外す」版。
export function appendTxnTag(
  db: Db,
  t: { bankTxnId: string; tag: Tag; category?: string | null; source: TagSource; actor: string; decidedAt: string; batchId?: string | null; cleared?: boolean },
): TxnTagRow {
  return tx(db, () => {
    const { v } = db.prepare('SELECT coalesce(max(version), 0) + 1 AS v FROM txn_tags WHERE bank_txn_id = ?').get(t.bankTxnId) as { v: number };
    db.prepare(
      'INSERT INTO txn_tags (bank_txn_id, version, tag, category, source, actor, decided_at, batch_id, cleared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(t.bankTxnId, v, t.tag, t.category ?? null, t.source, t.actor, t.decidedAt, t.batchId ?? null, t.cleared ? 1 : 0);
    return latestTxnTag(db, t.bankTxnId)!;
  });
}

// ---- sync_status ----

export function getSyncStatus(db: Db, accountId: string): SyncStatusRow | null {
  return (db.prepare('SELECT * FROM sync_status WHERE account_id = ?').get(accountId) as SyncStatusRow | undefined) ?? null;
}

export type SyncStatusPatch = {
  lastSyncAt?: string | null;
  lastOkAt?: string | null;
  lastError?: string | null;
  lastCsvAt?: string | null;
  backfillDoneUntil?: string | null;
};

const SYNC_COLUMNS: Record<keyof SyncStatusPatch, string> = {
  lastSyncAt: 'last_sync_at',
  lastOkAt: 'last_ok_at',
  lastError: 'last_error',
  lastCsvAt: 'last_csv_at',
  backfillDoneUntil: 'backfill_done_until',
};

// 行が無ければ作り、渡したキーだけ書く。
export function updateSyncStatus(db: Db, accountId: string, patch: SyncStatusPatch): SyncStatusRow {
  return tx(db, () => {
    db.prepare('INSERT INTO sync_status (account_id) VALUES (?) ON CONFLICT (account_id) DO NOTHING').run(accountId);
    const sets: string[] = [];
    const args: (string | null)[] = [];
    for (const [k, col] of Object.entries(SYNC_COLUMNS) as [keyof SyncStatusPatch, string][]) {
      const v = patch[k];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(v);
    }
    if (sets.length) db.prepare(`UPDATE sync_status SET ${sets.join(', ')} WHERE account_id = ?`).run(...args, accountId);
    return getSyncStatus(db, accountId)!;
  });
}
