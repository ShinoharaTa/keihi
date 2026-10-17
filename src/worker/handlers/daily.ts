// daily ジョブ（docs/mvp-plan.md §4.4 keihi-daily、T1-10・T2-1・T2-12）。keihi-daily.timer が src/jobs/trigger.ts で 1 日 1 回積む。
// 1. freee のリフレッシュトークンの更新（残り 30 日を切ったら。refreshIfExpiringSoon）。fake では何もしない。
//    invalid_grant なら settings.freee_reauth_required = 1（PWA の帯）。
// 2. マスタ同期（src/masters/sync.ts）。
// 3. 検索項目の期限チェック: アップロード済みで meta_state = none の証憑のうち、meta_deadline_on を過ぎたものは
//    needs_attention: meta_deadline_passed、期限の 7 日前からのものは settings.meta_deadline_warnings に載せる（PWA の一覧の警告）。
// 4. 日次照合: reconcile_deals ジョブを積む（未実行のものがあれば積み増さない）。
// 5. 紙原本のステータスの更新（src/deals/paper.ts refreshPaperStatuses）。
// 6. 証憑の照合（src/backup/verifyRemote.ts）: 前回（settings.remote_verify_last_at）から 30 日以上空いたら。
//    downloadReceipt は用途 sync で予算に通す（worker/main.ts）。途中で止まったら（予算など）前回実行日を進めず翌日に回す。
// 7. needs_attention の集計。結果は settings.daily_report と監査ログ（daily.completed）に残す。
// - 各段は独立に動かし、どれかが失敗したら最後に例外を投げてジョブの再試行に回す（成功した段も再試行でもう一度動く）。
import { getSetting, markNeedsAttention, setSetting } from '../../attention.ts';
import { appendAudit } from '../../audit.ts';
import { addDays, todayInTokyo } from '../../calendar/businessDays.ts';
import { verifyRemoteReceipts, type RemoteVerifyResult } from '../../backup/verifyRemote.ts';
import type { RemoteVerifyMode } from '../../config.ts';
import { refreshPaperStatuses } from '../../deals/paper.ts';
import { tx, type Db } from '../../db/index.ts';
import { enqueue } from '../../jobs/queue.ts';
import type { Handler } from '../../jobs/worker.ts';
import { syncMasters, type SyncResult } from '../../masters/sync.ts';
import { FreeeAuthError, type RefreshCheck } from '../../providers/freee/auth.ts';
import { setReauthRequired } from '../../providers/freee/state.ts';
import type { Provider } from '../../providers/types.ts';
import { PROVIDER } from './uploadReceipt.ts';

export const META_WARN_DAYS = 7;
export const DAILY_REPORT_KEY = 'daily_report';
export const META_WARNINGS_KEY = 'meta_deadline_warnings';
export const REMOTE_VERIFY_LAST_KEY = 'remote_verify_last_at';
export const REMOTE_VERIFY_INTERVAL_DAYS = 30;

export type DailyDeps = {
  provider: () => Provider;
  // freee のトークンの更新。null なら飛ばす（fake）。
  refreshToken: (() => Promise<RefreshCheck>) | null;
  // 証憑の照合。省略・null なら飛ばす。provider は downloadReceipt を用途 sync で予算に通したもの。
  remoteVerify?: { provider: () => Pick<Provider, 'downloadReceipt'>; objectsDir: string; mode: RemoteVerifyMode } | null;
};

export type MetaDeadlineItem = { document_id: string; meta_deadline_on: string };

export type DailyReport = {
  at: string;
  token: { refreshed: boolean; refresh_token_expires_at: string } | 'skipped' | null;
  masters: SyncResult | null;
  meta_deadline: { warn: MetaDeadlineItem[]; passed: MetaDeadlineItem[] } | null;
  reconcile: { job_id: number; created: boolean } | null;
  paper_status_changed: number | null;
  remote_verify: Omit<RemoteVerifyResult, 'items'> | 'skipped' | 'not_due' | null;
  needs_attention: number;
  errors: { step: string; error: string }[];
};

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
      markNeedsAttention(db, r.document_id, 'meta_deadline_passed', { meta_deadline_on: r.meta_deadline_on }, { now });
    } else if (today >= addDays(r.meta_deadline_on, -META_WARN_DAYS)) warn.push(item);
  }
  setSetting(db, META_WARNINGS_KEY, warn, now);
  return { warn, passed };
}

// reconcile_deals を積む。未実行のもの（queued / running）があればその id を返す（積み増さない）。
export function enqueueReconcile(db: Db, now: Date): { job_id: number; created: boolean } {
  const cur = db.prepare(`SELECT id FROM jobs WHERE kind = 'reconcile_deals' AND state IN ('queued', 'running') ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
  if (cur) return { job_id: cur.id, created: false };
  return { job_id: enqueue(db, 'reconcile_deals', null, { now }), created: true };
}

// 前回の証憑の照合から REMOTE_VERIFY_INTERVAL_DAYS 日以上空いたか（未実行なら true）。
export function remoteVerifyDue(db: Db, now: Date): boolean {
  const last = getSetting(db, REMOTE_VERIFY_LAST_KEY);
  if (typeof last !== 'string') return true;
  return now.getTime() - new Date(last).getTime() >= REMOTE_VERIFY_INTERVAL_DAYS * 86_400_000;
}

export function createDailyHandler(getDeps: () => DailyDeps): Handler {
  return async (_job, ctx) => {
    const { db } = ctx;
    const now = ctx.now();
    const deps = getDeps();
    const report: DailyReport = {
      at: now.toISOString(),
      token: null,
      masters: null,
      meta_deadline: null,
      reconcile: null,
      paper_status_changed: null,
      remote_verify: null,
      needs_attention: 0,
      errors: [],
    };
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

    try {
      report.reconcile = enqueueReconcile(db, now);
    } catch (e) {
      fail('reconcile', e);
    }

    try {
      report.paper_status_changed = refreshPaperStatuses(db, now);
    } catch (e) {
      fail('paper_status', e);
    }

    const rv = deps.remoteVerify ?? null;
    if (rv === null) report.remote_verify = 'skipped';
    else if (!remoteVerifyDue(db, now)) report.remote_verify = 'not_due';
    else {
      try {
        const { items: _items, ...r } = await verifyRemoteReceipts({ db, provider: rv.provider(), objectsDir: rv.objectsDir, mode: rv.mode, now: ctx.now });
        report.remote_verify = r;
        if (r.stopped === null) setSetting(db, REMOTE_VERIFY_LAST_KEY, now.toISOString(), now);
      } catch (e) {
        fail('remote_verify', e);
      }
    }

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
            reconcile: report.reconcile,
            paper_status_changed: report.paper_status_changed,
            remote_verify: report.remote_verify,
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
