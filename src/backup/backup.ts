// 日次バックアップ（docs/mvp-plan-v0.1.md T5-2、architecture.md §3.4）。tools/backup/run.ts から呼ぶ。
// スナップショット → restic backup（最新のスナップショットと manifest、objects/）→ 前回の成功から check_interval_days 以上
// 経っていれば restic check → 古いローカルのスナップショットを消す（keep_snapshots 個残す）→ 結果を audit に記録。
// - restic の古いスナップショットは消さない（追記のみ。restic.ts の許可リスト）。
// - freee-token.json・gmail-token-<id>.json と secrets.env は対象に含めない（パスで確かめた上で、--exclude も付ける）。
// - 失敗しても例外にせず、結果（ok=false）を返して audit に残す。終了コードは呼び出し側が決める。
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { appendAudit } from '../audit.ts';
import type { Db } from '../db/index.ts';
import { parseBackupSummary, tail, type Restic } from './restic.ts';
import type { BackupSettings } from './settings.ts';
import { pruneSnapshots, takeSnapshot } from './snapshot.ts';

export const RESTIC_TAG = 'keihi';
export const EXCLUDES = ['freee-token.json', 'gmail-token-*.json', 'secrets.env', '*.env', '.tmp-*'];
const DAY_MS = 86_400_000;

export type CheckResult = 'ok' | 'failed' | 'skipped';

export type BackupResult = {
  ok: boolean;
  snapshot: string | null;
  resticSnapshotId: string | null;
  check: CheckResult;
  prunedLocal: number;
  error: string | null;
};

export type BackupOptions = {
  settings: BackupSettings;
  db: Db;
  restic: Restic;
  now?: () => Date;
  // true: 必ず check する / false: しない / 未指定: 前回の check 成功から間隔を見て決める。
  check?: boolean;
};

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function within(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 対象に含めてはいけないもの（トークン・設定ディレクトリ）が入っていないか。
export function assertSafeTargets(targets: string[], settings: Pick<BackupSettings, 'freeeTokenPath' | 'configDir' | 'secretsPath'>): void {
  for (const t of targets) {
    for (const bad of [settings.freeeTokenPath, settings.secretsPath, settings.configDir]) {
      if (within(bad, t) || within(t, bad)) throw new Error(`バックアップの対象 ${t} に ${bad} が重なる`);
    }
  }
}

export function backupArgs(targets: string[]): string[] {
  return ['--json', '--tag', RESTIC_TAG, ...EXCLUDES.flatMap((e) => ['--exclude', e]), ...targets];
}

// 最後に restic check が成功した時刻（backup.run の payload.check = ok）。
export function lastCheckOk(db: Db): Date | null {
  const r = db
    .prepare(`SELECT MAX(ts) AS ts FROM audit_log WHERE action = 'backup.run' AND json_extract(payload_json, '$.check') = 'ok'`)
    .get() as { ts: string | null };
  return r.ts ? new Date(r.ts) : null;
}

export function isCheckDue(db: Db, now: Date, intervalDays: number): boolean {
  const last = lastCheckOk(db);
  return last === null || now.getTime() - last.getTime() >= intervalDays * DAY_MS - 60 * 60_000; // timer の揺れを 1 時間見る
}

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const { settings, db, restic } = opts;
  const now = opts.now ?? (() => new Date());
  const started = now();
  const res: BackupResult = { ok: false, snapshot: null, resticSnapshotId: null, check: 'skipped', prunedLocal: 0, error: null };
  try {
    if (!settings.repository) throw new Error('restic の保存先が無い（config.toml の [backup] repository か secrets.env の RESTIC_REPOSITORY）');
    if (!settings.resticEnv.RESTIC_PASSWORD) throw new Error(`${settings.secretsPath} に RESTIC_PASSWORD が無い`);

    const snap = await takeSnapshot(db, settings.snapshotsDir, started);
    res.snapshot = path.basename(snap.dbPath);
    const targets = [snap.dbPath, snap.manifestPath];
    if (await exists(settings.objectsDir)) targets.push(settings.objectsDir);
    assertSafeTargets(targets, settings);

    const b = await restic.run('backup', backupArgs(targets));
    if (b.code !== 0) throw new Error(`restic backup が失敗（終了コード ${b.code}）: ${tail(b.stderr)}`);
    res.resticSnapshotId = parseBackupSummary(b.stdout).snapshotId;

    const doCheck = opts.check ?? isCheckDue(db, started, settings.checkIntervalDays);
    if (doCheck) {
      const c = await restic.run('check', []);
      res.check = c.code === 0 ? 'ok' : 'failed';
      if (c.code !== 0) throw new Error(`restic check が失敗（終了コード ${c.code}）: ${tail(c.stderr)}`);
    }
    res.prunedLocal = (await pruneSnapshots(settings.snapshotsDir, settings.keepSnapshots)).length;
    res.ok = true;
  } catch (e) {
    res.error = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
  }
  appendAudit(
    db,
    {
      actor: 'backup',
      action: 'backup.run',
      entity: 'backup',
      entityId: res.snapshot,
      payload: {
        ok: res.ok,
        snapshot: res.snapshot,
        restic_snapshot_id: res.resticSnapshotId,
        check: res.check,
        pruned_local: res.prunedLocal,
        error: res.error,
        started_at: started.toISOString(),
      },
    },
    now(),
  );
  return res;
}
