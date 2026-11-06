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

export type MoneyAccountRow = {
  id: string;
  name: string;
  kind: AccountKind;
  source: AccountSource;
  freee_walletable_id: string | null;
  default_tag: Tag;
  mcp_visibility: McpVisibility;
  include_in_cashflow: 0 | 1;
  card_settlement_account_id: string | null;
  card_settlement_pattern: string | null;
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

export type AccountBalanceRow = { account_id: string; as_of_date: string; balance: number; source: BalanceSource; recorded_at: string };

export type TxnTagRow = {
  bank_txn_id: string;
  version: number;
  tag: Tag;
  category: string | null;
  source: TagSource;
  actor: string;
  decided_at: string;
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
  name: string;
  kind: AccountKind;
  source: AccountSource;
  freeeWalletableId?: string | null;
  now: string;
};

export function insertAccount(db: Db, a: NewAccount): MoneyAccountRow {
  const id = ulid();
  db.prepare(
    `INSERT INTO money_accounts (id, name, kind, source, freee_walletable_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, a.name, a.kind, a.source, a.freeeWalletableId ?? null, a.now, a.now);
  return getAccount(db, id)!;
}

// freee の walletable の口座を freee_walletable_id で upsert する。既にあれば name だけ変える（変わったときだけ updated_at も）。
export function upsertFreeeAccount(db: Db, a: { freeeWalletableId: string; name: string; kind: AccountKind; now: string }): MoneyAccountRow {
  return tx(db, () => {
    const cur = getAccountByWalletable(db, a.freeeWalletableId);
    if (!cur) return insertAccount(db, { ...a, source: 'freee' });
    if (cur.name !== a.name) db.prepare('UPDATE money_accounts SET name = ?, updated_at = ? WHERE id = ?').run(a.name, a.now, cur.id);
    return getAccount(db, cur.id)!;
  });
}

export function getAccount(db: Db, id: string): MoneyAccountRow | null {
  return (db.prepare('SELECT * FROM money_accounts WHERE id = ?').get(id) as MoneyAccountRow | undefined) ?? null;
}

export function getAccountByWalletable(db: Db, freeeWalletableId: string): MoneyAccountRow | null {
  return (db.prepare('SELECT * FROM money_accounts WHERE freee_walletable_id = ?').get(freeeWalletableId) as MoneyAccountRow | undefined) ?? null;
}

export function listAccounts(db: Db): MoneyAccountRow[] {
  return db.prepare('SELECT * FROM money_accounts ORDER BY created_at, id').all() as MoneyAccountRow[];
}

export type AccountSettings = {
  name?: string;
  defaultTag?: Tag;
  mcpVisibility?: McpVisibility;
  includeInCashflow?: boolean;
  cardSettlementAccountId?: string | null;
  cardSettlementPattern?: string | null;
};

const SETTING_COLUMNS: Record<keyof AccountSettings, string> = {
  name: 'name',
  defaultTag: 'default_tag',
  mcpVisibility: 'mcp_visibility',
  includeInCashflow: 'include_in_cashflow',
  cardSettlementAccountId: 'card_settlement_account_id',
  cardSettlementPattern: 'card_settlement_pattern',
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

// 再取得したときに変わってよい列（freee_status・due_amount・last_seen_at）だけを書く。渡さなかった列はそのまま。
export function touchBankTxn(
  db: Db,
  id: string,
  t: { lastSeenAt: string; freeeStatus?: FreeeTxnStatus | null; dueAmount?: number | null },
): BankTxnRow | null {
  const sets = ['last_seen_at = ?'];
  const args: (string | number | null)[] = [t.lastSeenAt];
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

export function listBankTxnSources(db: Db, bankTxnId: string): BankTxnSourceRow[] {
  return db.prepare('SELECT * FROM bank_txn_sources WHERE bank_txn_id = ? ORDER BY rowid').all(bankTxnId) as BankTxnSourceRow[];
}

// ---- account_balances ----

export function appendBalance(db: Db, b: { accountId: string; asOfDate: string; balance: number; source: BalanceSource; now: string }): void {
  db.prepare('INSERT INTO account_balances (account_id, as_of_date, balance, source, recorded_at) VALUES (?, ?, ?, ?, ?)').run(
    b.accountId, b.asOfDate, b.balance, b.source, b.now,
  );
}

// as_of_date が最も新しい行（同じ日なら後に記録した方）。
export function latestBalance(db: Db, accountId: string): AccountBalanceRow | null {
  return (
    (db.prepare('SELECT * FROM account_balances WHERE account_id = ? ORDER BY as_of_date DESC, rowid DESC LIMIT 1').get(accountId) as
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

// 次の版を追記して返す（version = 今の最大 + 1）。
export function appendTxnTag(
  db: Db,
  t: { bankTxnId: string; tag: Tag; category?: string | null; source: TagSource; actor: string; decidedAt: string },
): TxnTagRow {
  return tx(db, () => {
    const { v } = db.prepare('SELECT coalesce(max(version), 0) + 1 AS v FROM txn_tags WHERE bank_txn_id = ?').get(t.bankTxnId) as { v: number };
    db.prepare('INSERT INTO txn_tags (bank_txn_id, version, tag, category, source, actor, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      t.bankTxnId, v, t.tag, t.category ?? null, t.source, t.actor, t.decidedAt,
    );
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
