// sync_bank ジョブ（docs/mvp-plan-v3.md T104）。口座の明細と残高を取り込む（src/bank/sync.ts）。daily が 1 日 1 件、
// PWA の「今すぐ同期」（POST /api/bank/sync）が積む。
// - 予算が足りなくて途中で止まったときはジョブを完了にする（取れた分は保存済み。次の sync_bank が続きから取る）。
// - 再認可待ち（auth_invalid_grant、または settings.freee_reauth_required = 1）は upload_receipt と同じく、回数を数えずに
//   6 時間後へ延期する（jobs.last_error = "reauth_pending since=<ISO>: ..."）。
// - それ以外で一部の口座が失敗したら、最後に例外を投げてジョブの再試行に回す。
// - Provider は呼び出し側が渡す（予算を通したもの。worker/main.ts の HANDLERS）。用途は sync（budget.ts の DEFAULT_PURPOSES）。
import { syncBank, type SyncBankProvider } from '../../bank/sync.ts';
import type { AccountProvider } from '../../bank/repo.ts';
import { DeferJob, type Handler } from '../../jobs/worker.ts';
import { isReauthRequired } from '../../providers/freee/state.ts';
import { ProviderError } from '../../providers/types.ts';
import { REAUTH_PENDING, REAUTH_RETRY_MS, reauthSince } from './uploadReceipt.ts';

export type SyncBankDeps = {
  provider: SyncBankProvider;
  // [provider] kind（money_accounts.provider）。
  providerKind: AccountProvider;
  // [bank] backfill_from。
  backfillFrom: string;
};

export function createSyncBankHandler(getDeps: () => SyncBankDeps): Handler {
  return async (job, ctx) => {
    const { db } = ctx;
    const now = ctx.now();
    try {
      if (isReauthRequired(db)) throw new ProviderError('auth_invalid_grant', 'freee の再認可が要る（keihi freee auth）。呼び出さない');
      const deps = getDeps();
      const r = await syncBank(db, { provider: deps.provider, providerKind: deps.providerKind, backfillFrom: deps.backfillFrom, now });
      if (r.errors.length) throw new Error(`sync_bank の一部が失敗: ${r.errors.map((x) => `${x.account_id ?? 'balances'}: ${x.error}`).join(' / ')}`);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'auth_invalid_grant') {
        const since = reauthSince(job.last_error) ?? now;
        throw new DeferJob(new Date(now.getTime() + REAUTH_RETRY_MS), `${REAUTH_PENDING} since=${since.toISOString()}: ${e.message}`.slice(0, 1000));
      }
      throw e;
    }
  };
}
