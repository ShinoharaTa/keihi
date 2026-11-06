// 口座と明細の同期の API（docs/mvp-plan-v3.md T103・T104、requirements-v2.md R-A の A5）。認証の後に置く。
//   GET   /api/accounts       → 200 {accounts: [Account]}（Account は money_accounts の列 + sync_status + latest_balance。src/bank/accounts.ts）
//   POST  /api/accounts       body {name, kind} → 201 Account（CSV だけの口座。source = csv、provider = [provider] kind）/ 400
//   PATCH /api/accounts/:id   body {default_tag?, mcp_visibility?, include_in_cashflow?, card_settlement_account_id?, card_settlement_pattern?, active?}
//         → 200 Account / 400 / 404。変わった列を監査ログ（money_account.updated）に残す。
//   POST  /api/bank/sync      → 200 {job_id, created}（今すぐ同期。未完了の sync_bank があるか、前回積んでから 10 分以内なら積まない）
//   GET   /api/bank/status    → 200 {accounts: [{account_id, name, kind, source, active, last_sync_at, last_ok_at, last_error, last_csv_at, backfill_done_until}]}
//   GET   /api/bank_txns      ?from&to（YYYY-MM-DD）&account_id&tag&category&side&amount_min&amount_max&q&cursor&limit（1〜100、既定 100）
//         → 200 {items: [TxnView], next_cursor: string | null} / 400（T110。src/bank/summary.ts。category=none は未分類）
//   GET   /api/summary/monthly ?month=YYYY-MM → 200 MonthlySummary
//                              ?from=YYYY-MM&to=YYYY-MM（最大 36 か月）→ 200 {months: [MonthlySummary]} / 400
import { Hono } from 'hono';
import { AccountError, accountView, createCsvAccount, listAccountViews, parseAccountPatch, updateAccount } from '../../bank/accounts.ts';
import { listTxns, monthlySummaries, monthlySummary, monthsBetween, parseTxnQuery, SummaryError } from '../../bank/summary.ts';
import { bankStatus, enqueueSyncBank, MANUAL_SYNC_INTERVAL_MS } from '../../bank/sync.ts';
import type { AppDeps } from '../app.ts';
import { USER_HEADER } from '../auth.ts';

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text === '') return {};
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function bankRoutes(deps: Pick<AppDeps, 'db' | 'config' | 'now' | 'triggerWorker'>): Hono {
  const r = new Hono();
  const now = () => (deps.now ?? (() => new Date()))();
  const providerKind = () => deps.config.provider?.kind ?? 'freee';

  r.get('/accounts', (c) => c.json({ accounts: listAccountViews(deps.db) }));

  r.post('/accounts', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    try {
      const a = createCsvAccount(deps.db, { provider: providerKind(), name: body.name, kind: body.kind }, { user: c.req.header(USER_HEADER) ?? null }, now());
      return c.json(accountView(deps.db, a), 201);
    } catch (e) {
      if (e instanceof AccountError) return c.json({ error: e.reason }, e.status);
      throw e;
    }
  });

  r.patch('/accounts/:id', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    try {
      const a = updateAccount(deps.db, c.req.param('id'), parseAccountPatch(body), { user: c.req.header(USER_HEADER) ?? null }, now());
      return c.json(accountView(deps.db, a));
    } catch (e) {
      if (e instanceof AccountError) return c.json({ error: e.reason }, e.status);
      throw e;
    }
  });

  r.post('/bank/sync', (c) => {
    const res = enqueueSyncBank(deps.db, now(), { minIntervalMs: MANUAL_SYNC_INTERVAL_MS });
    if (res.created) {
      try {
        deps.triggerWorker();
      } catch {
        // 握りつぶす（ingest.ts と同じ。積んだジョブは keihi-worker.timer が拾う）
      }
    }
    return c.json(res);
  });

  r.get('/bank/status', (c) => c.json({ accounts: bankStatus(deps.db) }));

  r.get('/bank_txns', (c) => {
    try {
      return c.json(listTxns(deps.db, parseTxnQuery(c.req.query())));
    } catch (e) {
      if (e instanceof SummaryError) return c.json({ error: e.reason }, e.status);
      throw e;
    }
  });

  r.get('/summary/monthly', (c) => {
    const { month, from, to } = c.req.query();
    try {
      if (month !== undefined) {
        if (from !== undefined || to !== undefined) return c.json({ error: 'month_and_range' }, 400);
        return c.json(monthlySummary(deps.db, month));
      }
      if (from === undefined || to === undefined) return c.json({ error: 'month_required' }, 400);
      return c.json({ months: monthlySummaries(deps.db, monthsBetween(from, to)) });
    } catch (e) {
      if (e instanceof SummaryError) return c.json({ error: e.reason }, e.status);
      throw e;
    }
  });

  return r;
}
