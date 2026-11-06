// ワンショット worker の本体（docs/mvp-plan-v0.1.md T1-8）。キューの実行可能なジョブが無くなるまで 1 件ずつ処理して返る。
// - キューが空と判断したら lingerMs（[worker] linger_ms）だけ待ってもう一度 claim し、それでも無ければ返る。
//   `systemctl --user start --no-block` は動作中（activating）の oneshot に畳まれるので、最後の claim の直後に積まれた
//   ジョブを取りこぼさないための猶予。取りこぼしても keihi-worker.timer（2 分ごと）が拾う。
import type { Db } from '../db/index.ts';
import { claim, complete, defer, fail, type Job } from './queue.ts';

export type HandlerContext = { db: Db; now: () => Date };
export type Handler = (job: Job, ctx: HandlerContext) => Promise<void>;
export type Handlers = Record<string, Handler>;

// ハンドラが投げると、失敗として数えずに runAfter まで待たせる（queue.ts の defer）。RunSummary には数えない。
export class DeferJob extends Error {
  readonly runAfter: Date;
  constructor(runAfter: Date, note: string) {
    super(note);
    this.name = 'DeferJob';
    this.runAfter = runAfter;
  }
}

export type RunSummary = { done: number; failed: number };

export type RunOptions = { now?: () => Date; log?: (s: string) => void; lingerMs?: number; sleep?: (ms: number) => Promise<void> };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runUntilEmpty(db: Db, handlers: Handlers, opts: RunOptions = {}): Promise<RunSummary> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const lingerMs = opts.lingerMs ?? 0;
  const sleep = opts.sleep ?? defaultSleep;
  const summary: RunSummary = { done: 0, failed: 0 };
  let lingered = false;
  for (;;) {
    const job = claim(db, now());
    if (!job) {
      if (lingered || lingerMs <= 0) return summary;
      lingered = true;
      await sleep(lingerMs);
      continue;
    }
    lingered = false;
    const h = handlers[job.kind];
    try {
      if (!h) throw new Error(`知らないジョブの種類: ${job.kind}`);
      await h(job, { db, now });
      complete(db, job.id, now());
      summary.done++;
      log(`job ${job.id} ${job.kind}: done`);
    } catch (e) {
      if (e instanceof DeferJob) {
        defer(db, job.id, e.runAfter, e.message, now());
        log(`job ${job.id} ${job.kind}: 延期（${e.runAfter.toISOString()} まで）: ${e.message}`);
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      fail(db, job.id, msg, now());
      summary.failed++;
      log(`job ${job.id} ${job.kind}: 失敗（attempts=${job.attempts + 1}）: ${msg}`);
    }
  }
}
