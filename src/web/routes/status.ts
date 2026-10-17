// GET /api/status（docs/mvp-plan.md T1-14、§4.2 の curl 確認）。認証の後に置く。
//   → 200 {ok, user, documents: {total}, jobs: {queued, running, failed}}
// 件数だけを返す（中身・エラー文は返さない）。
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { USER_HEADER } from '../auth.ts';

export function statusRoutes(deps: Pick<AppDeps, 'db'>): Hono {
  const r = new Hono();
  r.get('/status', (c) => {
    const total = (deps.db.prepare('SELECT count(*) n FROM documents').get() as { n: number }).n;
    const jobs = { queued: 0, running: 0, failed: 0 };
    const rows = deps.db
      .prepare(`SELECT state, count(*) n FROM jobs WHERE state IN ('queued', 'running', 'failed') GROUP BY state`)
      .all() as { state: keyof typeof jobs; n: number }[];
    for (const row of rows) jobs[row.state] = row.n;
    return c.json({ ok: true, user: c.req.header(USER_HEADER) ?? null, documents: { total }, jobs });
  });
  return r;
}
