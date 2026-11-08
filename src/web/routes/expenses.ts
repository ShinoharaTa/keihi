// 経費の一覧の API（docs/cashflow.md §16.1、src/expenses/summary.ts）。認証は app.ts が全ルートの前に差し込む。
//   GET /api/expenses ?month=YYYY-MM、または ?from=YYYY-MM&to=YYYY-MM（最大 12 か月）
//       → 200 {from, to, total: {amount, count, waiting_count, waiting_amount}, months: [{month, amount, count, waiting_count}],
//              vendors: [{vendor_key, label, count, amount, waiting_count, category}]}
//       / 400 {error: month_required | invalid_month | invalid_range | range_too_long | month_and_range}
import { Hono } from 'hono';
import { matchWindowsOf } from '../../bank/match.ts';
import { SummaryError } from '../../bank/summary.ts';
import { expensesSummary, parseExpensesRange } from '../../expenses/summary.ts';
import type { AppDeps } from '../app.ts';

export function expensesRoutes(deps: Pick<AppDeps, 'db' | 'config'>): Hono {
  const r = new Hono();

  r.get('/expenses', (c) => {
    const { month, from, to } = c.req.query();
    try {
      return c.json(expensesSummary(deps.db, parseExpensesRange({ month, from, to }), { matchWindows: matchWindowsOf(deps.config.bank) }));
    } catch (e) {
      if (e instanceof SummaryError) return c.json({ error: e.reason }, e.status);
      throw e;
    }
  });

  return r;
}
