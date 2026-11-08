// 口座と明細の同期の API（docs/mvp-plan-v3.md T103・T104、requirements-v2.md R-A の A5）。認証の後に置く。
//   GET   /api/accounts       → 200 {accounts: [Account]}（Account は money_accounts の列 + sync_status + latest_balance。src/bank/accounts.ts）
//   POST  /api/accounts       body {name, kind} → 201 Account（CSV だけの口座。source = csv、provider = [provider] kind）/ 400
//   PATCH /api/accounts/:id   body {default_tag?, mcp_visibility?, include_in_cashflow?, card_settlement_account_id?, card_settlement_pattern?, active?}
//         → 200 Account / 400 / 404。変わった列を監査ログ（money_account.updated）に残す。
//   POST  /api/accounts/:id/import  multipart: file（CSV、5MB まで）→ 201 CsvImportResult（src/bank/csv/import.ts）
//         / 400 {error: file_required | not_csv_account | unknown_format | empty_file} / 404 {error: not_found} / 409 {error: already_imported, csv_import_id}
//         / 413 {error: too_large, max_bytes}。取り込みの後に振替を検出する（[bank] transfer_window_days）。
//   GET   /api/accounts/:id/imports → 200 {imports: [{id, imported_at, file_name, parser_id, rows_total, rows_new, rows_merged, rows_error}]} / 404
//   POST  /api/bank/sync      → 200 {job_id, created}（今すぐ同期。未完了の sync_bank があるか、前回積んでから 10 分以内なら積まない）
//   GET   /api/bank/status    → 200 {accounts: [{account_id, name, kind, source, active, last_sync_at, last_ok_at, last_error, last_csv_at, backfill_done_until}]}
//   GET   /api/bank_txns      ?from&to（YYYY-MM-DD）&account_id&tag&category&side&amount_min&amount_max&q&excluded（0|1）&vendor_key
//         &receipt（matched|pending_review|candidate|waiting）&cursor&limit（1〜100、既定 100）
//         → 200 {items: [TxnView], next_cursor: string | null} / 400（T110。src/bank/summary.ts。category=none は未分類）
//   GET   /api/bank_txns/:id/matches → 200 {links: [Link], candidates: [Candidate]} / 404 {error: not_found}（照合。src/bank/match.ts）
//   POST  /api/bank_txns/:id/matches body {document_id} → 201 {link, warnings} / 400 / 404 {error: not_found | document_not_found}
//         / 409 {error: already_linked} / 422 {error: document_not_matchable}
//   POST  /api/bank_txns/:id/matches/:document_id/unlink → 200 {link} / 404 / 409 {error: not_linked}
//   GET   /api/documents/:id/matches → 200 {links: [Link]} / 404 {error: not_found}
//   GET   /api/summary/monthly ?month=YYYY-MM → 200 MonthlySummary
//                              ?from=YYYY-MM&to=YYYY-MM（最大 36 か月）→ 200 {months: [MonthlySummary]} / 400
//   GET   /api/bank/overview  → 200 Overview（お金タブのホーム。src/bank/overview.ts。[cashflow] の設定は deps.config.cashflow）
//   GET   /api/balance_history ?months=12（1〜BALANCE_HISTORY_MAX_MONTHS の整数）→ 200 {months: [{month, total, by_account}]}
//         / 400 {error: invalid_months}（src/bank/balanceHistory.ts。古い順、最後は今月 = 今日時点）
// 今日は Asia/Tokyo の暦日。
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { BALANCE_HISTORY_DEFAULT_MONTHS, BALANCE_HISTORY_MAX_MONTHS, balanceHistory } from '../../bank/balanceHistory.ts';
import { AccountError, accountView, createCsvAccount, listAccountViews, parseAccountPatch, updateAccount } from '../../bank/accounts.ts';
import { CsvImportError, importCsv, listCsvImports } from '../../bank/csv/import.ts';
import { documentMatches, linkDocument, MatchError, matchWindowsOf, txnMatches, unlinkDocument } from '../../bank/match.ts';
import { buildOverview } from '../../bank/overview.ts';
import { getAccount } from '../../bank/repo.ts';
import { listTxns, monthlySummaries, monthlySummary, monthsBetween, parseTxnQuery, SummaryError } from '../../bank/summary.ts';
import { bankStatus, enqueueSyncBank, MANUAL_SYNC_INTERVAL_MS } from '../../bank/sync.ts';
import { todayInTokyo } from '../../calendar/businessDays.ts';
import { DEFAULT_DEDUP_DATE_WINDOW_DAYS, DEFAULT_TRANSFER_WINDOW_DAYS } from '../../config.ts';
import type { AppDeps } from '../app.ts';
import { USER_HEADER } from '../auth.ts';

// CSV の上限（docs/mvp-plan-v3.md T105）。multipart の境界の分の余裕は ingest.ts と同じ。
export const CSV_MAX_BYTES = 5 * 1024 * 1024;
const MULTIPART_OVERHEAD = 64 * 1024;

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

export function bankRoutes(deps: Pick<AppDeps, 'db' | 'config' | 'now' | 'triggerWorker' | 'objectsDir'>): Hono {
  const r = new Hono();
  const now = () => (deps.now ?? (() => new Date()))();
  const providerKind = () => deps.config.provider?.kind ?? 'freee';
  const matchWindows = () => matchWindowsOf(deps.config.bank);

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

  r.post(
    '/accounts/:id/import',
    bodyLimit({ maxSize: CSV_MAX_BYTES + MULTIPART_OVERHEAD, onError: (c) => c.json({ error: 'too_large', max_bytes: CSV_MAX_BYTES }, 413) }),
    async (c) => {
      let body: Record<string, string | File>;
      try {
        body = (await c.req.parseBody()) as Record<string, string | File>;
      } catch {
        return c.json({ error: 'file_required' }, 400);
      }
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: 'file_required' }, 400);
      if (file.size > CSV_MAX_BYTES) return c.json({ error: 'too_large', max_bytes: CSV_MAX_BYTES }, 413);
      const bank = deps.config.bank;
      try {
        const res = await importCsv(deps.db, {
          accountId: c.req.param('id'),
          bytes: new Uint8Array(await file.arrayBuffer()),
          fileName: file.name || null,
          objectsDir: deps.objectsDir,
          user: c.req.header(USER_HEADER) ?? null,
          dedupDateWindowDays: bank?.dedupDateWindowDays ?? DEFAULT_DEDUP_DATE_WINDOW_DAYS,
          transferWindowDays: bank?.transferWindowDays ?? DEFAULT_TRANSFER_WINDOW_DAYS,
          matchWindows: matchWindows(),
          now: now(),
        });
        return c.json(res, 201);
      } catch (e) {
        if (e instanceof CsvImportError) return c.json({ error: e.reason, ...e.extra }, e.status);
        throw e;
      }
    },
  );

  r.get('/accounts/:id/imports', (c) => {
    const id = c.req.param('id');
    if (!getAccount(deps.db, id)) return c.json({ error: 'not_found' }, 404);
    return c.json({
      imports: listCsvImports(deps.db, id).map((i) => ({
        id: i.id, imported_at: i.imported_at, file_name: i.file_name, parser_id: i.parser_id,
        rows_total: i.rows_total, rows_new: i.rows_new, rows_merged: i.rows_merged, rows_error: i.rows_error,
      })),
    });
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

  r.get('/bank/overview', (c) => {
    const cf = deps.config.cashflow;
    return c.json(
      buildOverview(deps.db, {
        today: todayInTokyo(now()),
        unplannedLookbackMonths: cf.unplannedLookbackMonths,
        reserveMonths: cf.reserveMonths,
        includeUnplannedIncome: cf.includeUnplannedIncome,
        matchWindows: matchWindows(),
      }),
    );
  });

  r.get('/balance_history', (c) => {
    const q = c.req.query('months');
    const months = q === undefined ? BALANCE_HISTORY_DEFAULT_MONTHS : /^\d+$/.test(q) ? Number(q) : NaN;
    if (!Number.isSafeInteger(months) || months < 1 || months > BALANCE_HISTORY_MAX_MONTHS) return c.json({ error: 'invalid_months' }, 400);
    return c.json(balanceHistory(deps.db, { today: todayInTokyo(now()), months }));
  });

  r.get('/bank_txns', (c) => {
    try {
      return c.json(listTxns(deps.db, parseTxnQuery(c.req.query()), { matchWindows: matchWindows() }));
    } catch (e) {
      if (e instanceof SummaryError) return c.json({ error: e.reason }, e.status);
      throw e;
    }
  });

  r.get('/bank_txns/:id/matches', (c) => {
    const res = txnMatches(deps.db, c.req.param('id'), matchWindows());
    if (!res) return c.json({ error: 'not_found' }, 404);
    return c.json(res);
  });

  r.post('/bank_txns/:id/matches', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    try {
      const res = linkDocument(deps.db, { txnId: c.req.param('id'), documentId: body.document_id, user: c.req.header(USER_HEADER) ?? null, now: now(), windows: matchWindows() });
      return c.json(res, 201);
    } catch (e) {
      if (e instanceof MatchError) return c.json({ error: e.reason }, e.status);
      throw e;
    }
  });

  r.post('/bank_txns/:id/matches/:document_id/unlink', (c) => {
    try {
      return c.json(unlinkDocument(deps.db, { txnId: c.req.param('id'), documentId: c.req.param('document_id'), user: c.req.header(USER_HEADER) ?? null, now: now() }));
    } catch (e) {
      if (e instanceof MatchError) return c.json({ error: e.reason }, e.status);
      throw e;
    }
  });

  r.get('/documents/:id/matches', (c) => {
    const res = documentMatches(deps.db, c.req.param('id'));
    if (!res) return c.json({ error: 'not_found' }, 404);
    return c.json(res);
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
