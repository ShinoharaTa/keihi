// sync_bank ジョブ（docs/mvp-plan-v3.md T104）。口座の明細と残高を取り込む（src/bank/sync.ts）。daily が 1 日 1 件、
// PWA の「今すぐ同期」（POST /api/bank/sync）が積む。
// - 予算が足りなくて途中で止まったときはジョブを完了にする（取れた分は保存済み。次の sync_bank が続きから取る）。
// - 再認可待ち（auth_invalid_grant、または settings.freee_reauth_required = 1）は upload_receipt と同じく、回数を数えずに
//   6 時間後へ延期する（jobs.last_error = "reauth_pending since=<ISO>: ..."）。
// - それ以外で一部の口座が失敗したら、最後に例外を投げてジョブの再試行に回す。
// - Provider は呼び出し側が渡す（予算を通したもの。worker/main.ts の HANDLERS）。用途は sync（budget.ts の DEFAULT_PURPOSES）。
// - 同期が返ったら（予算で止まった・一部の口座が失敗した場合も含む）振替を検出する（src/bank/transfers.ts、T110）。
//   範囲は「今回取った明細の最小の日付 − 2 × transferWindowDays 〜 今日」。取った明細が 0 件なら呼ばない。
//   作った組の数は監査ログ（transfers.detected）に残す。
import { appendAudit } from '../../audit.ts';
import { syncBank, type SyncBankProvider, type SyncBankResult } from '../../bank/sync.ts';
import { minTxnDateSeenAt, type AccountProvider } from '../../bank/repo.ts';
import { detectTransfers } from '../../bank/transfers.ts';
import { addDays, todayInTokyo } from '../../calendar/businessDays.ts';
import type { Db } from '../../db/index.ts';
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
  // [bank] transfer_window_days。
  transferWindowDays: number;
};

// 今回の同期で取った明細を含む範囲で振替を検出する。呼ばなかったら null。
export function detectTransfersAfterSync(db: Db, r: SyncBankResult, windowDays: number, now: Date): { from: string; to: string; created: number } | null {
  if (r.accounts.reduce((n, a) => n + a.fetched, 0) === 0) return null;
  const min = minTxnDateSeenAt(db, now.toISOString());
  if (min === null) return null;
  const from = addDays(min, -2 * windowDays);
  const to = todayInTokyo(now);
  const created = detectTransfers(db, { windowDays, now, from, to });
  const kinds: Record<string, number> = {};
  for (const l of created) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
  appendAudit(db, { actor: 'worker', action: 'transfers.detected', entity: 'transfer_link', payload: { from, to, created: created.length, kinds } }, now);
  return { from, to, created: created.length };
}

export function createSyncBankHandler(getDeps: () => SyncBankDeps): Handler {
  return async (job, ctx) => {
    const { db } = ctx;
    const now = ctx.now();
    try {
      if (isReauthRequired(db)) throw new ProviderError('auth_invalid_grant', 'freee の再認可が要る（keihi freee auth）。呼び出さない');
      const deps = getDeps();
      const r = await syncBank(db, { provider: deps.provider, providerKind: deps.providerKind, backfillFrom: deps.backfillFrom, now });
      detectTransfersAfterSync(db, r, deps.transferWindowDays, now);
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
