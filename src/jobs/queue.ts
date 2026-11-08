// SQLite の jobs 表によるジョブキュー（docs/mvp-plan-v0.1.md T1-8）。worker は 1 本だけ動く前提（systemd の oneshot unit）。
// - claim はトランザクションの中で 1 件を running にする。locked_at が 15 分より古い running は取り直す
//   （落ちたまま再取得を繰り返さないよう、取り直しも 1 回の失敗として attempts に数える）。
// - 失敗したら attempts を増やし、指数バックオフ（1 → 5 → 30 → 120 分、以降 120 分）で run_after を進める。6 回で failed。
// - defer は失敗ではない待ち（再認可待ち・証憑のアップロード待ち）。attempts を数えずに run_after を進めて queued に戻す。
import { tx, type Db } from '../db/index.ts';

export const BACKOFF_MINUTES = [1, 5, 30, 120] as const;
export const MAX_ATTEMPTS = 6;
export const LOCK_TIMEOUT_MS = 15 * 60 * 1000;

export type JobKind = 'upload_receipt' | 'extract' | 'update_receipt_meta' | 'daily' | 'send_deal' | 'reconcile_deals' | 'sync_bank' | 'fetch_mail';
export type JobState = 'queued' | 'running' | 'done' | 'failed';

export type Job = {
  id: number;
  kind: string;
  ref_id: string | null;
  state: JobState;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export function backoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[i] * 60 * 1000;
}

export function enqueue(db: Db, kind: JobKind, refId: string | null, opts: { runAfter?: Date; now?: Date } = {}): number {
  const now = (opts.now ?? new Date()).toISOString();
  const runAfter = (opts.runAfter ?? opts.now ?? new Date()).toISOString();
  const r = db
    .prepare(`INSERT INTO jobs (kind, ref_id, state, attempts, max_attempts, run_after, created_at, updated_at) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)`)
    .run(kind, refId, MAX_ATTEMPTS, runAfter, now, now);
  return Number(r.lastInsertRowid);
}

// attempts を 1 増やし、上限なら failed、そうでなければ run_after を進めて queued に戻す。
function recordFailure(db: Db, job: Job, error: string, now: Date): void {
  const attempts = job.attempts + 1;
  const iso = now.toISOString();
  if (attempts >= job.max_attempts) {
    db.prepare(`UPDATE jobs SET state = 'failed', attempts = ?, locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`).run(attempts, error, iso, job.id);
  } else {
    const runAfter = new Date(now.getTime() + backoffMs(attempts)).toISOString();
    db.prepare(`UPDATE jobs SET state = 'queued', attempts = ?, run_after = ?, locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`).run(attempts, runAfter, error, iso, job.id);
  }
}

export function claim(db: Db, now: Date = new Date()): Job | null {
  return tx(db, () => {
    const iso = now.toISOString();
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS).toISOString();
    const stale = db.prepare(`SELECT * FROM jobs WHERE state = 'running' AND locked_at < ? ORDER BY id`).all(staleBefore) as Job[];
    for (const j of stale) recordFailure(db, j, 'lock expired（worker が途中で止まった）', now);
    const job = db
      .prepare(`SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? ORDER BY run_after, id LIMIT 1`)
      .get(iso) as Job | undefined;
    if (!job) return null;
    db.prepare(`UPDATE jobs SET state = 'running', locked_at = ?, updated_at = ? WHERE id = ?`).run(iso, iso, job.id);
    return { ...job, state: 'running', locked_at: iso, updated_at: iso };
  });
}

export function complete(db: Db, id: number, now: Date = new Date()): void {
  const iso = now.toISOString();
  db.prepare(`UPDATE jobs SET state = 'done', locked_at = NULL, updated_at = ? WHERE id = ? AND state = 'running'`).run(iso, id);
}

export function fail(db: Db, id: number, error: string, now: Date = new Date()): void {
  tx(db, () => {
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ? AND state = 'running'`).get(id) as Job | undefined;
    if (job) recordFailure(db, job, error.slice(0, 2000), now);
  });
}

// 回数を数えずに runAfter まで待たせる。note は last_error に残す（理由と、待ちの開始時刻などをハンドラが読み返す）。
export function defer(db: Db, id: number, runAfter: Date, note: string, now: Date = new Date()): void {
  db.prepare(`UPDATE jobs SET state = 'queued', run_after = ?, locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND state = 'running'`).run(
    runAfter.toISOString(),
    note.slice(0, 2000),
    now.toISOString(),
    id,
  );
}

export function getJob(db: Db, id: number): Job | null {
  return (db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined) ?? null;
}
