// GET /api/status（docs/mvp-plan.md T1-14、§4.2 の curl 確認）。認証の後に置く。
//   → 200 {ok, user, documents: {total, needs_attention}, jobs: {queued, running, failed},
//          backup: {last_success_at, last_drill: {at, ok, failure_count} | null}, freee_reauth_required,
//          retention: {earliest_retain_until: 'YYYY-MM-DD' | null, documents},
//          bank: {accounts, last_ok_at, errors, latest_txn_date}}
// 件数と日時だけを返す（中身・エラー文は返さない）。バックアップの状態は監査ログ（backup.run / backup.drill）から読む。
// freee_reauth_required は settings の同名キーが 1 のとき true（providers/freee/state.ts。PWA の再認可の帯）。
// bank は使っている口座の数・最後にうまくいった明細の同期・last_error がある口座の数（src/bank/sync.ts bankSummary）と、
// 使っている口座の明細の最新の日付（latest_txn_date。無ければ null）。
// retention は最も古い受領日の保持期限（src/retention.ts。期限は受領日の年で決まるので最小の received_on で足りる）。
import { Hono } from 'hono';
import { getSetting } from '../../attention.ts';
import { latestTxnDateActive } from '../../bank/repo.ts';
import { bankSummary } from '../../bank/sync.ts';
import { REAUTH_KEY } from '../../providers/freee/state.ts';
import type { AppDeps } from '../app.ts';
import { retainUntil } from '../../retention.ts';
import { USER_HEADER } from '../auth.ts';

export function statusRoutes(deps: Pick<AppDeps, 'db' | 'config'>): Hono {
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
    const freeeReauthRequired = getSetting(deps.db, REAUTH_KEY) === 1;
    const earliest = (deps.db.prepare('SELECT min(received_on) d FROM documents').get() as { d: string | null }).d;
    const retention = { earliest_retain_until: earliest === null ? null : retainUntil({ received_on: earliest }, deps.config), documents: total };
    return c.json({
      ok: true,
      user: c.req.header(USER_HEADER) ?? null,
      documents: { total, needs_attention: needsAttention },
      jobs,
      backup,
      freee_reauth_required: freeeReauthRequired,
      retention,
      bank: { ...bankSummary(deps.db), latest_txn_date: latestTxnDateActive(deps.db) },
    });
  });
  return r;
}
