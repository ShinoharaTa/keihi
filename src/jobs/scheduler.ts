// worker の起動の制御（[worker] mode）。web のプロセスが持つ。
// - systemd（既定）: 今までどおり。trigger は `systemctl --user start --no-block keihi-worker.service`（trigger.ts）、
//   定期・daily は keihi-worker.timer / keihi-daily.timer。stop は何もしない。
// - spawn: web のプロセスが worker を子プロセスで動かす（コンテナ用。systemd が無い）。timer の代わりもここで持つ。
//   - 子は同時に 1 本だけ。動作中の trigger は pending にして、子が終わったら直ちにもう一度起動する
//     （systemd の「動作中の start は畳まれる」での取りこぼしの対策と同じ）。
//   - 定期: 作ってから bootDelayMs 後に 1 回、以後は子が終わってから idleIntervalMs 後（OnBootSec=1min / OnUnitInactiveSec=2min）。
//     定期の起動は、子が動いていれば何もしない（終わったときに次を数え直す）。
//   - daily: 毎日 JST 03:30（= UTC 18:30。タイムゾーンの設定に頼らない）に enqueueDaily → trigger。
//     作ったときの補填（Persistent=true 相当）: daily のジョブの最新の created_at が直近の予定時刻より前なら、すぐ積んで起動する。
//     daily のジョブが 1 件も無い DB では補填しない（次の 03:30 を待つ）。
//   - stop: タイマーを全部止め、子がいれば SIGTERM を送って終了を待つ（stopTimeoutMs を過ぎたら SIGKILL）。以後の trigger は何もしない。
// - none: 何もしない（検証用。ジョブは積まれるが処理されない）。
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import { log as processLog } from '../log.ts';
import { enqueueDaily, triggerWorker, type SpawnLike } from './trigger.ts';

export type WorkerMode = 'systemd' | 'spawn' | 'none';
export type WorkerControl = { trigger(): void; stop(): Promise<void> };

export type ControlLog = {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
};

export type ChildLike = {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(ev: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(ev: 'error', fn: (e: Error) => void): unknown;
};
export type WorkerSpawn = (cmd: string, args: string[], opts: { stdio: 'inherit' }) => ChildLike;

export type SetTimer = (fn: () => void, ms: number) => unknown;
export type ClearTimer = (t: unknown) => void;

export const DAILY_UTC_HOUR = 18; // JST 03:30
export const DAILY_UTC_MINUTE = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// SIGKILL を送ってから終了の通知を待つ上限。
const KILL_WAIT_MS = 2_000;

// now 以前で最も新しい daily の予定時刻（ちょうど 18:30:00 UTC なら now そのもの）。
export function latestDailyAt(now: Date): Date {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_UTC_HOUR, DAILY_UTC_MINUTE));
  return t.getTime() <= now.getTime() ? t : new Date(t.getTime() - DAY_MS);
}

// now より後で最も早い daily の予定時刻（ちょうど 18:30:00 UTC なら翌日）。
export function nextDailyAt(now: Date): Date {
  return new Date(latestDailyAt(now).getTime() + DAY_MS);
}

export function createWorkerControl(opts: {
  mode: WorkerMode;
  db: Db;
  spawn?: WorkerSpawn;
  // systemd の方式の trigger の spawn（テスト用。既定は node:child_process の spawn で systemctl を呼ぶ）。
  systemdSpawn?: SpawnLike;
  now?: () => Date;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  log?: ControlLog;
  workerEntry?: string;
  bootDelayMs?: number;
  idleIntervalMs?: number;
  stopTimeoutMs?: number;
}): WorkerControl {
  if (opts.mode === 'none') return { trigger: () => {}, stop: async () => {} };
  if (opts.mode === 'systemd') {
    const systemdSpawn = opts.systemdSpawn;
    return { trigger: () => triggerWorker(systemdSpawn), stop: async () => {} };
  }

  const db = opts.db;
  const spawn = opts.spawn ?? (nodeSpawn as unknown as WorkerSpawn);
  const now = opts.now ?? (() => new Date());
  const setTimer: SetTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: ClearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  const log = opts.log ?? processLog;
  const workerEntry = opts.workerEntry ?? path.resolve(import.meta.dirname, '../worker/main.ts');
  const bootDelayMs = opts.bootDelayMs ?? 60_000;
  const idleIntervalMs = opts.idleIntervalMs ?? 120_000;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 5_000;

  let stopped = false;
  let child: ChildLike | null = null;
  let exited: Promise<void> | null = null;
  let pending = false;
  let periodicTimer: unknown = null;
  let dailyTimer: unknown = null;

  const arm = (fn: () => void, ms: number): unknown => {
    const t = setTimer(fn, ms);
    (t as { unref?: () => void } | null)?.unref?.();
    return t;
  };
  const schedulePeriodic = (ms: number) => {
    if (periodicTimer !== null) clearTimer(periodicTimer);
    periodicTimer = arm(() => {
      periodicTimer = null;
      if (!child) start();
    }, ms);
  };

  function start(): void {
    if (stopped) return;
    pending = false;
    let c: ChildLike;
    try {
      c = spawn(process.execPath, [workerEntry], { stdio: 'inherit' });
    } catch (e) {
      log.error('worker: 起動できない', { err: e });
      schedulePeriodic(idleIntervalMs);
      return;
    }
    child = c;
    let done = false;
    let resolveExit!: () => void;
    exited = new Promise<void>((r) => (resolveExit = r));
    const finish = () => {
      if (done) return;
      done = true;
      child = null;
      exited = null;
      resolveExit();
      if (stopped) return;
      if (pending) start();
      else schedulePeriodic(idleIntervalMs);
    };
    c.on('exit', (code, signal) => {
      if (code !== 0) log.warn(`worker: 終了コード ${code ?? signal}`, { code, signal });
      finish();
    });
    c.on('error', (e) => {
      log.error('worker: 子プロセスのエラー', { err: e });
      // 起動そのものに失敗したとき（pid が無い）は exit が来ないことがあるので、終わったものとして扱う。
      if (c.pid === undefined) finish();
    });
  }

  function trigger(): void {
    if (stopped) return;
    if (child) pending = true;
    else start();
  }

  function runDaily(): void {
    const r = enqueueDaily(db, now());
    log.info(`daily: job ${r.id}${r.created ? '' : '（既にある）'}`);
    trigger();
  }

  function scheduleDaily(after: Date): void {
    const at = nextDailyAt(after);
    dailyTimer = arm(() => {
      dailyTimer = null;
      if (stopped) return;
      runDaily();
      // タイマーが早めに来ても同じ予定時刻を二度数えない。
      const t = now();
      scheduleDaily(t.getTime() < at.getTime() ? at : t);
    }, Math.max(0, at.getTime() - now().getTime()));
  }

  // 補填（Persistent=true 相当）。daily のジョブが 1 件も無い DB では補填しない。
  const t0 = now();
  const last = (db.prepare(`SELECT MAX(created_at) AS m FROM jobs WHERE kind = 'daily'`).get() as { m: string | null }).m;
  if (last !== null && last < latestDailyAt(t0).toISOString()) {
    log.info('daily: 止まっていた間の分を積む');
    runDaily();
  }
  scheduleDaily(t0);
  if (!child) schedulePeriodic(bootDelayMs);

  async function stop(): Promise<void> {
    if (stopped) return exited ?? undefined;
    stopped = true;
    pending = false;
    if (periodicTimer !== null) clearTimer(periodicTimer);
    if (dailyTimer !== null) clearTimer(dailyTimer);
    periodicTimer = dailyTimer = null;
    const c = child;
    const wait = exited;
    if (!c || !wait) return;
    c.kill('SIGTERM');
    // SIGKILL の後も終わりを知らせて来なければ、少しだけ（KILL_WAIT_MS まで）待って諦める（web の停止を止めない）。
    const timeout = (ms: number) =>
      new Promise<'timeout'>((r) => {
        arm(() => r('timeout'), ms);
      });
    if ((await Promise.race([wait.then(() => 'exited' as const), timeout(stopTimeoutMs)])) === 'exited') return;
    log.warn('worker: SIGTERM で止まらないので SIGKILL を送る');
    c.kill('SIGKILL');
    await Promise.race([wait, timeout(Math.min(stopTimeoutMs, KILL_WAIT_MS))]);
  }

  return { trigger, stop };
}
