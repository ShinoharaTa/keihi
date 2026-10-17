// GET /api/status（docs/mvp-plan.md T1-14、§4.2 の curl 確認）。認証の後に置く。
//   → 200 {ok, user, documents: {total, needs_attention}, jobs: {queued, running, failed},
//          backup: {last_success_at, last_drill: {at, ok, failure_count} | null}}
// 件数と日時だけを返す（中身・エラー文は返さない）。バックアップの状態は監査ログ（backup.run / backup.drill）から読む。
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
    const needsAttention = (deps.db.prepare(`SELECT count(*) n FROM documents WHERE status = 'needs_attention'`).get() as { n: number }).n;
    const lastBackup = deps.db
      .prepare(`SELECT ts FROM audit_log WHERE action = 'backup.run' AND json_extract(payload_json, '$.ok') = 1 ORDER BY seq DESC LIMIT 1`)
      .get() as { ts: string } | undefined;
    const drill = deps.db
      .prepare(`SELECT ts, json_extract(payload_json, '$.ok') AS ok, json_extract(payload_json, '$.failure_count') AS failure_count FROM audit_log WHERE action = 'backup.drill' ORDER BY seq DESC LIMIT 1`)
      .get() as { ts: string; ok: number | null; failure_count: number | null } | undefined;
    const backup = {
      last_success_at: lastBackup?.ts ?? null,
      last_drill: drill ? { at: drill.ts, ok: drill.ok === 1, failure_count: drill.failure_count } : null,
    };
    return c.json({ ok: true, user: c.req.header(USER_HEADER) ?? null, documents: { total, needs_attention: needsAttention }, jobs, backup });
  });
  return r;
}
