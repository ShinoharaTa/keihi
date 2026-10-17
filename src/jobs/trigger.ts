// worker の起動（docs/mvp-plan-v0.1.md T1-8）。`systemctl --user start --no-block keihi-worker.service`。
// 既に動いていれば systemd 側で二重起動しない（oneshot）。失敗しても取り込みは止めない（timer が拾う）。
import { spawn as nodeSpawn } from 'node:child_process';

export const WORKER_UNIT = 'keihi-worker.service';
export const TRIGGER_ARGS = ['--user', 'start', '--no-block', WORKER_UNIT] as const;

export type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'ignore'; detached: boolean }) => { unref(): void; on(ev: 'error', fn: (e: Error) => void): unknown };

export function triggerWorker(spawn: SpawnLike = nodeSpawn as unknown as SpawnLike): void {
  const p = spawn('systemctl', [...TRIGGER_ARGS], { stdio: 'ignore', detached: true });
  p.on('error', () => {});
  p.unref();
}
