// daily ジョブ（docs/mvp-plan.md §4.4 keihi-daily、T1-10・T2-1・T2-12）。keihi-daily.timer が src/jobs/trigger.ts で 1 日 1 回積む。
// 1. freee のリフレッシュトークンの更新（残り 30 日を切ったら。refreshIfExpiringSoon）。fake では何もしない。
//    invalid_grant なら settings.freee_reauth_required = 1（PWA の帯）。
// 2. マスタ同期（src/masters/sync.ts）。
// 3. 検索項目の期限チェック: アップロード済みで meta_state = none の証憑のうち、meta_deadline_on を過ぎたものは
//    needs_attention: meta_deadline_passed、期限の 7 日前からのものは settings.meta_deadline_warnings に載せる（PWA の一覧の警告）。
// 4. needs_attention の集計。結果は settings.daily_report と監査ログ（daily.completed）に残す。
// - 各段は独立に動かし、どれかが失敗したら最後に例外を投げてジョブの再試行に回す（成功した段も再試行でもう一度動く）。
import { appendAudit } from '../../audit.ts';
import { addDays, todayInTokyo } from '../../calendar/businessDays.ts';
import { tx, type Db } from '../../db/index.ts';
import type { Handler } from '../../jobs/worker.ts';
import { syncMasters, type SyncResult } from '../../masters/sync.ts';
import { FreeeAuthError, type RefreshCheck } from '../../providers/freee/auth.ts';
import { setReauthRequired } from '../../providers/freee/state.ts';
import type { Provider } from '../../providers/types.ts';
import { PROVIDER } from './uploadReceipt.ts';

export const META_WARN_DAYS = 7;
export const DAILY_REPORT_KEY = 'daily_report';
export const META_WARNINGS_KEY = 'meta_deadline_warnings';

export type DailyDeps = {
  provider: () => Provider;
  // freee のトークンの更新。null なら飛ばす（fake）。
  refreshToken: (() => Promise<RefreshCheck>) | null;
};

export type MetaDeadlineItem = { document_id: string; meta_deadline_on: string };

export type DailyReport = {
  at: string;
  token: { refreshed: boolean; refresh_token_expires_at: string } | 'skipped' | null;
  masters: SyncResult | null;
  meta_deadline: { warn: MetaDeadlineItem[]; passed: MetaDeadlineItem[] } | null;
  needs_attention: number;
  errors: { step: string; error: string }[];
};

function setSetting(db: Db, key: string, value: unknown, now: Date): void {
  db.prepare(
    'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(value), now.toISOString());
}

// 検索項目の期限チェック。過ぎたものは needs_attention にし、7 日前からのものを返す。
export function checkMetaDeadlines(db: Db, now: Date): { warn: MetaDeadlineItem[]; passed: MetaDeadlineItem[] } {
  const today = todayInTokyo(now);
  const rows = db
    .prepare(
      `SELECT u.document_id, u.meta_deadline_on, d.status FROM provider_uploads u JOIN documents d ON d.id = u.document_id
       WHERE u.provider = ? AND u.state = 'uploaded' AND u.meta_state = 'none' AND u.meta_deadline_on IS NOT NULL
       ORDER BY u.meta_deadline_on, u.document_id`,
    )
    .all(PROVIDER) as { document_id: string; meta_deadline_on: string; status: string }[];
  const warn: MetaDeadlineItem[] = [];
  const passed: MetaDeadlineItem[] = [];
  for (const r of rows) {
    const item = { document_id: r.document_id, meta_deadline_on: r.meta_deadline_on };
    if (today > r.meta_deadline_on) {
      passed.push(item);
      if (r.status !== 'needs_attention') {
        tx(db, () => {
          db.prepare(`UPDATE documents SET status = 'needs_attention' WHERE id = ?`).run(r.document_id);
          appendAudit(
            db,
            { actor: 'worker', action: 'document.needs_attention', entity: 'document', entityId: r.document_id, payload: { reason: 'meta_deadline_passed', from: r.status, meta_deadline_on: r.meta_deadline_on } },
            now,
          );
        });
      }
    } else if (today >= addDays(r.meta_deadline_on, -META_WARN_DAYS)) warn.push(item);
  }
  setSetting(db, META_WARNINGS_KEY, warn, now);
  return { warn, passed };
}

export function createDailyHandler(getDeps: () => DailyDeps): Handler {
  return async (_job, ctx) => {
    const { db } = ctx;
    const now = ctx.now();
    const deps = getDeps();
    const report: DailyReport = { at: now.toISOString(), token: null, masters: null, meta_deadline: null, needs_attention: 0, errors: [] };
    const fail = (step: string, e: unknown) => report.errors.push({ step, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });

    if (deps.refreshToken === null) report.token = 'skipped';
    else {
      try {
        const r = await deps.refreshToken();
        report.token = { refreshed: r.refreshed, refresh_token_expires_at: new Date(r.refreshTokenExpiresAt * 1000).toISOString() };
      } catch (e) {
        if (e instanceof FreeeAuthError && e.error === 'invalid_grant') setReauthRequired(db, true, now);
        fail('token', e);
      }
    }

    try {
      report.masters = await syncMasters(db, deps.provider(), { providerName: PROVIDER, now: ctx.now });
    } catch (e) {
      fail('masters', e);
    }

    try {
      report.meta_deadline = checkMetaDeadlines(db, now);
    } catch (e) {
      fail('meta_deadline', e);
    }

    // T4-4（日次照合）はここで reconcile ジョブを積む（別担当が足す）。

    report.needs_attention = (db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE status = 'needs_attention'`).get() as { n: number }).n;

    tx(db, () => {
      setSetting(db, DAILY_REPORT_KEY, report, now);
      appendAudit(
        db,
        {
          actor: 'worker',
          action: 'daily.completed',
          entity: 'system',
          entityId: null,
          payload: {
            token: report.token,
            masters: report.masters,
            meta_deadline_warn: report.meta_deadline?.warn.length ?? null,
            meta_deadline_passed: report.meta_deadline?.passed.length ?? null,
            needs_attention: report.needs_attention,
            errors: report.errors,
          },
        },
        now,
      );
    });
    if (report.errors.length) throw new Error(`daily の一部が失敗: ${report.errors.map((x) => `${x.step}: ${x.error}`).join(' / ')}`);
  };
}
