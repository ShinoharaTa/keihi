// reconcile_deals ジョブ（docs/mvp-plan.md T4-4）。keihi が作った取引を freee と照合する（src/deals/reconcile.ts）。
// 日次（keihi-daily）から積む想定。ref_id は使わない。Provider の失敗は例外を投げてジョブキューのバックオフに任せる。
// - Provider は呼び出し側が渡す（予算を通したもの）。worker/main.ts での配線は未実装。
import { appendAudit } from '../../audit.ts';
import { reconcileDeals } from '../../deals/reconcile.ts';
import type { Handler } from '../../jobs/worker.ts';
import type { Provider } from '../../providers/types.ts';
import { PROVIDER } from './send.ts';

export type ReconcileDeps = { provider: Pick<Provider, 'listDeals' | 'getDeal' | 'attachReceipts'> };

export function createReconcileHandler(getDeps: () => ReconcileDeps): Handler {
  return async (_job, ctx) => {
    const deps = getDeps();
    const s = await reconcileDeals(ctx.db, deps.provider, { providerName: PROVIDER, now: ctx.now });
    appendAudit(ctx.db, { actor: 'worker', action: 'deals.reconciled', entity: 'deal', payload: { provider: PROVIDER, ...s } }, ctx.now());
  };
}

// worker/main.ts の HANDLERS が使う既定のハンドラ。freee の Provider の配線は未実装なので失敗させる。
export const reconcileDealsHandler: Handler = createReconcileHandler(() => {
  throw new Error('reconcile_deals の Provider の配線が未実装（worker/main.ts で createReconcileHandler に freee の Provider を渡す）');
});
