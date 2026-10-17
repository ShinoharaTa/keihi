// worker の起動（docs/mvp-plan-v0.1.md T1-8）。`systemctl --user start --no-block keihi-worker.service`。
// 既に動いていれば systemd 側で二重起動しない（oneshot）。失敗しても取り込みは止めない（timer が拾う）。
// daily（docs/mvp-plan.md §4.4 keihi-daily）: keihi-daily.service が `node src/jobs/trigger.ts daily` で daily ジョブを 1 件積み、
// worker を起動する。まだ実行されていない daily ジョブ（queued / running）があれば積み増さない。
//
//   node src/jobs/trigger.ts daily [--db /path/to.db]
import { spawn as nodeSpawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { openDb, type Db } from '../db/index.ts';
import { enqueue } from './queue.ts';

export const WORKER_UNIT = 'keihi-worker.service';
export const TRIGGER_ARGS = ['--user', 'start', '--no-block', WORKER_UNIT] as const;

export type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'ignore'; detached: boolean }) => { unref(): void; on(ev: 'error', fn: (e: Error) => void): unknown };

export function triggerWorker(spawn: SpawnLike = nodeSpawn as unknown as SpawnLike): void {
  const p = spawn('systemctl', [...TRIGGER_ARGS], { stdio: 'ignore', detached: true });
  p.on('error', () => {});
  p.unref();
}

// daily ジョブを積む。未実行のものがあればその id を返す（積み増さない）。
export function enqueueDaily(db: Db, now: Date = new Date()): { id: number; created: boolean } {
  const cur = db.prepare(`SELECT id FROM jobs WHERE kind = 'daily' AND state IN ('queued', 'running') ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
  if (cur) return { id: cur.id, created: false };
  return { id: enqueue(db, 'daily', null, { now }), created: true };
}

export function main(argv: string[], deps: { spawn?: SpawnLike; log?: (s: string) => void } = {}): number {
  const log = deps.log ?? ((s: string) => console.log(s));
  const { values, positionals } = parseArgs({ args: argv, options: { db: { type: 'string' } }, allowPositionals: true });
  if (positionals.length !== 1 || positionals[0] !== 'daily') {
    log('使い方: node src/jobs/trigger.ts daily [--db /path/to.db]');
    return 2;
  }
  const db = openDb(values.db ?? loadConfig().dbPath);
  try {
    const r = enqueueDaily(db);
    log(`daily: job ${r.id}${r.created ? '' : '（既にある）'}`);
  } finally {
    db.close();
  }
  triggerWorker(deps.spawn);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
