// 口座（money_accounts）の管理（docs/mvp-plan-v3.md T103、requirements-v2.md R-A）。
// - マスタ同期のたびに freee の walletable ごとに 1 行を upsert する（既にあれば name だけ。設定の列は触らない）。
// - CSV だけの口座（PayPay 残高など）は API で作る（source = csv）。
// - 設定の変更（PATCH /api/accounts/:id）は、変わった列の前後を監査ログ（money_account.updated）に残す。同じトランザクション。
import { appendAudit } from '../audit.ts';
import { tx, type Db } from '../db/index.ts';
import type { WalletableType } from '../providers/types.ts';
import {
  ACCOUNT_KINDS,
  TAGS,
  getAccount,
  getSyncStatus,
  insertAccount,
  latestBalance,
  listAccounts,
  updateAccountSettings,
  upsertFreeeAccount,
  type AccountKind,
  type AccountProvider,
  type AccountSettings,
  type MoneyAccountRow,
  type SyncStatusRow,
} from './repo.ts';

const KIND_OF: Record<WalletableType, AccountKind> = { bank_account: 'bank', credit_card: 'card', wallet: 'wallet' };
const MCP_VISIBILITIES = ['full', 'summary', 'none'] as const;

export function walletableKind(type: WalletableType): AccountKind {
  const k = KIND_OF[type];
  if (!k) throw new Error(`知らない walletable の種類: ${String(type)}`);
  return k;
}

// walletable（remote_id は src/masters/sync.ts の walletableRemoteId = `type:id`）ごとに口座を upsert する。
export function upsertWalletableAccounts(
  db: Db,
  provider: AccountProvider,
  walletables: { remoteId: string; type: WalletableType; name: string }[],
  now: string,
): MoneyAccountRow[] {
  return tx(db, () =>
    walletables.map((w) => upsertFreeeAccount(db, { provider, freeeWalletableId: w.remoteId, name: w.name, kind: walletableKind(w.type), now })),
  );
}

export class AccountError extends Error {
  readonly status: 400 | 404;
  readonly reason: string;
  constructor(status: 400 | 404, reason: string) {
    super(reason);
    this.name = 'AccountError';
    this.status = status;
    this.reason = reason;
  }
}

// CSV だけの口座を作る。
export function createCsvAccount(
  db: Db,
  input: { provider: AccountProvider; name: unknown; kind: unknown },
  by: { user: string | null },
  now: Date,
): MoneyAccountRow {
  if (typeof input.name !== 'string' || input.name.trim() === '') throw new AccountError(400, 'invalid_name');
  if (!(ACCOUNT_KINDS as readonly unknown[]).includes(input.kind)) throw new AccountError(400, 'invalid_kind');
  const name = input.name.trim();
  const kind = input.kind as AccountKind;
  return tx(db, () => {
    const a = insertAccount(db, { provider: input.provider, name, kind, source: 'csv', now: now.toISOString() });
    appendAudit(
      db,
      { actor: 'user', action: 'money_account.created', entity: 'money_account', entityId: a.id, payload: { provider: a.provider, name, kind, source: 'csv', user: by.user } },
      now,
    );
    return a;
  });
}

// PATCH の本文（snake_case）→ 設定。知らないキー・型の違いは AccountError(400)。
const PATCH_FIELDS: Record<string, keyof AccountSettings> = {
  default_tag: 'defaultTag',
  mcp_visibility: 'mcpVisibility',
  include_in_cashflow: 'includeInCashflow',
  card_settlement_account_id: 'cardSettlementAccountId',
  card_settlement_pattern: 'cardSettlementPattern',
  active: 'active',
};

export function parseAccountPatch(body: Record<string, unknown>): AccountSettings {
  const out: AccountSettings = {};
  for (const [k, v] of Object.entries(body)) {
    const key = PATCH_FIELDS[k];
    if (!key) throw new AccountError(400, `unknown_field: ${k}`);
    const bad = () => new AccountError(400, `invalid_${k}`);
    switch (key) {
      case 'defaultTag':
        if (!(TAGS as readonly unknown[]).includes(v)) throw bad();
        out.defaultTag = v as AccountSettings['defaultTag'];
        break;
      case 'mcpVisibility':
        if (!(MCP_VISIBILITIES as readonly unknown[]).includes(v)) throw bad();
        out.mcpVisibility = v as AccountSettings['mcpVisibility'];
        break;
      case 'includeInCashflow':
      case 'active':
        if (typeof v !== 'boolean') throw bad();
        out[key] = v;
        break;
      case 'cardSettlementAccountId':
      case 'cardSettlementPattern':
        if (v !== null && typeof v !== 'string') throw bad();
        out[key] = v as string | null;
        break;
    }
  }
  return out;
}

const COLUMN_OF: Record<keyof AccountSettings, keyof MoneyAccountRow> = {
  name: 'name',
  defaultTag: 'default_tag',
  mcpVisibility: 'mcp_visibility',
  includeInCashflow: 'include_in_cashflow',
  cardSettlementAccountId: 'card_settlement_account_id',
  cardSettlementPattern: 'card_settlement_pattern',
  active: 'active',
};

// 設定を変え、変わった列だけを監査に残す（何も変わらなければ残さない）。
export function updateAccount(db: Db, id: string, patch: AccountSettings, by: { user: string | null }, now: Date): MoneyAccountRow {
  return tx(db, () => {
    const cur = getAccount(db, id);
    if (!cur) throw new AccountError(404, 'not_found');
    const sid = patch.cardSettlementAccountId;
    if (sid !== undefined && sid !== null && (sid === id || !getAccount(db, sid))) throw new AccountError(400, 'invalid_card_settlement_account_id');
    const next = updateAccountSettings(db, id, patch, now.toISOString())!;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(patch) as (keyof AccountSettings)[]) {
      const col = COLUMN_OF[k];
      if (cur[col] !== next[col]) changes[col] = { from: cur[col], to: next[col] };
    }
    if (Object.keys(changes).length) {
      appendAudit(db, { actor: 'user', action: 'money_account.updated', entity: 'money_account', entityId: id, payload: { changes, user: by.user } }, now);
    }
    return next;
  });
}

export type AccountView = Omit<MoneyAccountRow, 'include_in_cashflow' | 'active'> & {
  include_in_cashflow: boolean;
  active: boolean;
  sync_status: Omit<SyncStatusRow, 'account_id'> | null;
  latest_balance: { as_of_date: string; balance: number; source: string } | null;
};

export function accountView(db: Db, a: MoneyAccountRow): AccountView {
  const s = getSyncStatus(db, a.id);
  const b = latestBalance(db, a.id);
  return {
    ...a,
    include_in_cashflow: a.include_in_cashflow === 1,
    active: a.active === 1,
    sync_status: s
      ? { last_sync_at: s.last_sync_at, last_ok_at: s.last_ok_at, last_error: s.last_error, last_csv_at: s.last_csv_at, backfill_done_until: s.backfill_done_until }
      : null,
    latest_balance: b ? { as_of_date: b.as_of_date, balance: b.balance, source: b.source } : null,
  };
}

export function listAccountViews(db: Db): AccountView[] {
  return listAccounts(db).map((a) => accountView(db, a));
}
