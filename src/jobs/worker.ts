// ワンショット worker の本体（docs/mvp-plan-v0.1.md T1-8）。キューの実行可能なジョブが無くなるまで 1 件ずつ処理して返る。
import type { Db } from '../db/index.ts';
import { claim, complete, fail, type Job } from './queue.ts';

export type HandlerContext = { db: Db; now: () => Date };
export type Handler = (job: Job, ctx: HandlerContext) => Promise<void>;
export type Handlers = Record<string, Handler>;

export type RunSummary = { done: number; failed: number };

export async function runUntilEmpty(db: Db, handlers: Handlers, opts: { now?: () => Date; log?: (s: string) => void } = {}): Promise<RunSummary> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const summary: RunSummary = { done: 0, failed: 0 };
  for (;;) {
    const job = claim(db, now());
    if (!job) return summary;
    const h = handlers[job.kind];
    try {
      if (!h) throw new Error(`知らないジョブの種類: ${job.kind}`);
      await h(job, { db, now });
      complete(db, job.id, now());
      summary.done++;
      log(`job ${job.id} ${job.kind}: done`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fail(db, job.id, msg, now());
      summary.failed++;
      log(`job ${job.id} ${job.kind}: 失敗（attempts=${job.attempts + 1}）: ${msg}`);
    }
  }
}
