// send_deal ジョブ（docs/mvp-plan.md T4-3、T4-2）。ref_id は document_id。確定版の review から取引を作って freee に送る。
// - 送る対象は decision='approve' の version 最大の版（最新の版が approve でなければ送らない）。
// - 証憑がアップロード済みなら createExpenseDeal に receipt_ids を付けて作る（→ receipt_linked）。
//   まだなら取引を先に作り（→ deal_created）、アップロード済みになった後で attachReceipts（PUT /deals/{id} で details を
//   全部送り直す。F9）で付ける。後から付けるのは、このジョブの再実行か日次の照合（reconcile_deals）。
// - 2 回目以降の POST の前に、発生日の範囲で一覧を取り ref_number を照合する（stateMachine.ts）。
// - 4xx（自動で直らない失敗）は再送せず needs_attention にして、ジョブは完了させる。
//   それ以外の失敗は例外を投げてジョブキューのバックオフに任せる。最後の試行で失敗したら needs_attention にする。
// - Provider は呼び出し側が渡す（予算を通したもの。worker/main.ts の HANDLERS）。
import { appendAudit } from '../../audit.ts';
import type { Db } from '../../db/index.ts';
import type { Handler } from '../../jobs/worker.ts';
import { BudgetExceededError } from '../../providers/freee/budget.ts';
import { ProviderError, type Deal, type Provider } from '../../providers/types.ts';
import {
  buildDeal,
  DealBuildError,
  latestApprovedReview,
  resolveBuildOptions,
  reviewForDeal,
  taxResolver,
  type DealDraft,
  type TaxResolver,
} from '../../deals/builder.ts';
import {
  countAttempt,
  draftOf,
  ensureDealRow,
  findDealsByRef,
  getDealRow,
  linkReceiptsIfReady,
  markNeedsAttention,
  recordError,
  transition,
  uploadedReceiptIds,
  type DealRow,
} from '../../deals/stateMachine.ts';

export const PROVIDER = 'freee';

export type DealProvider = Pick<Provider, 'createExpenseDeal' | 'attachReceipts' | 'listDeals' | 'getDeal'>;

export type SendDealDeps = {
  provider: DealProvider;
  // 税率の区分 → 税区分コード。省略時は対応表と同期済みのマスタ（builder.ts taxResolver）。
  resolveTax?: TaxResolver;
};

export function describeError(e: unknown): string {
  if (e instanceof ProviderError) return `${e.kind}${e.status ? `(${e.status})` : ''}: ${e.message}`;
  if (e instanceof BudgetExceededError) return `budget: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// 自動の再試行では直らない失敗。
function humanReason(e: unknown): 'send_rejected' | 'freee_reauth_required' | null {
  if (e instanceof ProviderError && !e.retryable) return e.kind === 'auth_invalid_grant' ? 'freee_reauth_required' : 'send_rejected';
  return null;
}

function afterCreate(db: Db, row: DealRow, deal: Deal, expectedReceipts: number[], now: Date, adopted: boolean): DealRow {
  const linked = expectedReceipts.length > 0 && expectedReceipts.every((r) => deal.receiptIds.includes(r));
  const payload = { remote_receipt_ids: deal.receiptIds, adopted };
  if (row.state === 'queued') row = transition(db, row.id, 'sending', {}, now);
  row = transition(db, row.id, 'deal_created', { remoteDealId: deal.id, lastError: null }, now, payload);
  if (linked) row = transition(db, row.id, 'receipt_linked', {}, now, { remote_receipt_ids: deal.receiptIds, via: 'create' });
  return row;
}

export function createSendDealHandler(getDeps: () => SendDealDeps): Handler {
  return async (job, ctx) => {
    const { db } = ctx;
    const now = ctx.now();
    if (!job.ref_id) throw new Error('send_deal に document_id が無い');
    const documentId = job.ref_id;
    const deps = getDeps();
    const review = latestApprovedReview(db, documentId);
    if (!review) {
      appendAudit(db, { actor: 'worker', action: 'deal.skipped', entity: 'document', entityId: documentId, payload: { reason: 'no_approved_review' } }, now);
      return;
    }

    const receiptIds = uploadedReceiptIds(db, documentId, PROVIDER);
    let draft: DealDraft;
    try {
      const resolveTax = deps.resolveTax ?? taxResolver(db, PROVIDER);
      const input = reviewForDeal(review, receiptIds, resolveTax);
      draft = buildDeal(input, resolveBuildOptions(db, PROVIDER, resolveTax, input.txnDate, input.payment));
    } catch (e) {
      if (!(e instanceof DealBuildError)) throw e;
      // 行が無いと要対応に出せないので、内容の無い下書きで行を作ってから needs_attention にする。
      const row = ensureDealRow(db, { documentId, reviewId: review.id, provider: PROVIDER, draft: { refNumber: `kh-${documentId}`, issueDate: review.txn_date ?? '', details: [], receiptIds: [], payment: { kind: 'cash' } } }, now);
      markNeedsAttention(db, row.id, 'build_failed', { error: e.message, review_id: review.id }, now);
      return;
    }

    let row = ensureDealRow(db, { documentId, reviewId: review.id, provider: PROVIDER, draft }, now);
    const isLastAttempt = job.attempts + 1 >= job.max_attempts;
    try {
      if (row.state === 'queued' || row.state === 'sending') {
        const sendDraft = draftOf(row);
        // 送るときの証憑は今の状態で決める（下書きを作った後にアップロードが終わっていることがある）。
        const nowReceipts = uploadedReceiptIds(db, documentId, PROVIDER);
        let deal: Deal | null = null;
        let adopted = false;
        let duplicate = false;
        if (row.attempts > 0) {
          const hits = await findDealsByRef(deps.provider, row.ref_number, row.issue_date);
          if (hits.length > 0) {
            deal = hits[0];
            adopted = true;
            if (hits.length > 1) {
              duplicate = true;
              appendAudit(db, { actor: 'worker', action: 'deal.duplicate_found', entity: 'deal', entityId: row.id, payload: { ref_number: row.ref_number, remote_deal_ids: hits.map((h) => h.id) } }, now);
            }
          }
        }
        if (!deal) {
          if (row.state === 'queued') row = transition(db, row.id, 'sending', {}, now);
          countAttempt(db, row.id, now);
          deal = await deps.provider.createExpenseDeal({
            issueDate: sendDraft.issueDate,
            refNumber: sendDraft.refNumber,
            details: sendDraft.details,
            partnerName: sendDraft.partnerName,
            receiptIds: nowReceipts.length ? nowReceipts : undefined,
            payments: sendDraft.payments,
          });
        }
        row = afterCreate(db, getDealRow(db, row.id)!, deal, nowReceipts, now, adopted);
        if (duplicate) {
          // 二重計上の恐れ。最小の ID を採用したうえで要対応に出す（freee 側の削除は人が行う）。
          markNeedsAttention(db, row.id, 'duplicate_deals', { ref_number: row.ref_number }, now);
          return;
        }
      }
      if (row.state === 'deal_created') row = await linkReceiptsIfReady(db, deps.provider, row, now);
    } catch (e) {
      const msg = describeError(e);
      recordError(db, row.id, msg, now);
      const reason = humanReason(e);
      if (reason) {
        markNeedsAttention(db, row.id, reason, { error: msg, status: e instanceof ProviderError ? e.status : null }, now);
        return; // 再送しない
      }
      if (isLastAttempt) markNeedsAttention(db, row.id, 'send_retries_exhausted', { error: msg, attempts: job.attempts + 1 }, now);
      throw e;
    }
  };
}

