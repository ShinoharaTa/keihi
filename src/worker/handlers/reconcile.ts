// reconcile_deals ジョブ（docs/mvp-plan.md T4-4）。keihi が作った取引を freee と照合する（src/deals/reconcile.ts）。
// 日次（keihi-daily）から積む想定。ref_id は使わない。再試行できる失敗（一覧の取得、または取引ごとの 5xx など）は
// 例外を投げてジョブキューのバックオフに任せる。取引ごとの失敗のときも、照合できた分の結果は監査ログに残す。
// - Provider は呼び出し側が渡す（予算を通したもの。worker/main.ts の HANDLERS）。
// - verifiedLookbackDays・maxListPages は config.toml の [reconcile]（worker/main.ts が渡す。省略時は reconcile.ts の既定）。
import { appendAudit } from '../../audit.ts';
import { ReconcileIncompleteError, reconcileDeals } from '../../deals/reconcile.ts';
import type { Handler } from '../../jobs/worker.ts';
import type { Provider } from '../../providers/types.ts';
import { PROVIDER } from './send.ts';

export type ReconcileDeps = { provider: Pick<Provider, 'listDeals' | 'getDeal' | 'attachReceipts'>; verifiedLookbackDays?: number; maxListPages?: number };

export function createReconcileHandler(getDeps: () => ReconcileDeps): Handler {
  return async (_job, ctx) => {
    const deps = getDeps();
    try {
      const s = await reconcileDeals(ctx.db, deps.provider, { providerName: PROVIDER, now: ctx.now, verifiedLookbackDays: deps.verifiedLookbackDays, maxPages: deps.maxListPages });
      appendAudit(ctx.db, { actor: 'worker', action: 'deals.reconciled', entity: 'deal', payload: { provider: PROVIDER, ...s } }, ctx.now());
    } catch (e) {
      if (e instanceof ReconcileIncompleteError) {
        appendAudit(ctx.db, { actor: 'worker', action: 'deals.reconciled', entity: 'deal', payload: { provider: PROVIDER, ...e.summary, errors: e.errors } }, ctx.now());
      }
      throw e;
    }
  };
}

