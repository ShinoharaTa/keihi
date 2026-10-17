// update_receipt_meta ジョブ（docs/mvp-plan.md T2-12、legal.md R11）。確定した日付・金額・取引先を freee の証憑に入れる。
// - ref_id は document_id。確定（reviews の最新の版）が approve のときだけ PUT /receipts/{id} を送る。
//   送るもの: 発行元（reviews.vendor）・発行日（txn_date）・金額（amount）・登録番号・qualified_invoice。
//   登録番号は reviews.invoice_reg_no（0003）を使い、null なら最新の extractions の登録番号（検証済み）を使う。
//   qualified_invoice は登録番号があれば qualified、無ければ unselected（不明のまま。not_qualified とは言い切らない）。
// - 版が変わるたびに再 PUT する（freee に履歴が残る [FR-EBOOK]）。送った版は監査ログ（receipt.meta_updated）に残し、
//   同じ版の 2 回目は送らない。
// - provider_uploads.meta_deadline_on（保存から 70 日）を過ぎていれば PUT せず needs_attention: meta_deadline_passed。
// - 証憑がまだ上がっていなければ失敗ではなく 10 分後へ延期する（回数を数えない）。上限は meta_deadline_on
//   （まだ無ければ受領日 + 70 日）で、過ぎたら needs_attention: meta_deadline_passed にして終える。
// - Provider の失敗は例外で再試行に回し、自動では直らない失敗と最後の試行は needs_attention にする。
import { describeError, markNeedsAttention } from '../../attention.ts';
import { appendAudit } from '../../audit.ts';
import { addDays, todayInTokyo } from '../../calendar/businessDays.ts';
import { tx, type Db } from '../../db/index.ts';
import { DeferJob, type Handler } from '../../jobs/worker.ts';
import { ProviderError, type Provider, type ReceiptMeta } from '../../providers/types.ts';
import { META_DEADLINE_DAYS, PROVIDER } from './uploadReceipt.ts';

export const UPLOAD_WAIT_MS = 10 * 60 * 1000;

export type UpdateReceiptMetaDeps = { provider: Pick<Provider, 'updateReceiptMeta'> };

type UploadRow = { id: string; state: string; remote_receipt_id: string | null; meta_deadline_on: string | null; meta_state: string };
type ReviewRow = {
  id: string;
  version: number;
  txn_date: string | null;
  amount: number | null;
  vendor: string | null;
  decision: string;
  invoice_reg_no: string | null;
  qualified_invoice: string | number | boolean | null;
};

const REG_NO = /^T\d{13}$/;
const QUALIFIED = new Set(['qualified', 'not_qualified', 'unselected']);

function lastSentVersion(db: Db, documentId: string): number | null {
  const r = db
    .prepare(`SELECT payload_json FROM audit_log WHERE entity = 'document' AND entity_id = ? AND action = 'receipt.meta_updated' ORDER BY seq DESC LIMIT 1`)
    .get(documentId) as { payload_json: string } | undefined;
  if (!r) return null;
  const v = (JSON.parse(r.payload_json) as { review_version?: unknown }).review_version;
  return typeof v === 'number' ? v : null;
}

export function metaFromReview(db: Db, documentId: string, review: ReviewRow): ReceiptMeta {
  const meta: ReceiptMeta = {};
  if (review.vendor) meta.partnerName = review.vendor;
  if (review.txn_date) meta.issueDate = review.txn_date;
  if (review.amount !== null) meta.amount = review.amount;
  // 登録番号: reviews（0003 で追加された列。人が確定した値）を優先し、null なら最新の extractions にフォールバック。
  let reg: string | null = review.invoice_reg_no ?? null;
  if (reg === null) {
    const ex = db.prepare('SELECT invoice_reg_no FROM extractions WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(documentId) as
      | { invoice_reg_no: string | null }
      | undefined;
    reg = ex?.invoice_reg_no ?? null;
  }
  if (reg && REG_NO.test(reg)) meta.invoiceRegistrationNumber = reg;
  // qualified_invoice: reviews では INTEGER 0/1（0003）。文字列（将来の列）も受ける。未設定なら登録番号の有無から決める。
  const q = review.qualified_invoice;
  if (q === 1 || q === true || q === 'qualified') meta.qualifiedInvoice = 'qualified';
  else if (q === 0 || q === false || q === 'not_qualified') meta.qualifiedInvoice = 'not_qualified';
  else if (typeof q === 'string' && QUALIFIED.has(q)) meta.qualifiedInvoice = q as ReceiptMeta['qualifiedInvoice'];
  else meta.qualifiedInvoice = meta.invoiceRegistrationNumber ? 'qualified' : 'unselected';
  return meta;
}

export function createUpdateReceiptMetaHandler(getDeps: () => UpdateReceiptMetaDeps): Handler {
  return async (job, ctx) => {
    const { db } = ctx;
    const now = ctx.now();
    if (!job.ref_id) throw new Error('update_receipt_meta に document_id が無い');
    const documentId = job.ref_id;
    const doc = db.prepare('SELECT received_on FROM documents WHERE id = ?').get(documentId) as { received_on: string } | undefined;
    if (!doc) throw new Error(`document ${documentId} が無い`);

    const review = db
      .prepare(`SELECT id, version, txn_date, amount, vendor, decision, invoice_reg_no, qualified_invoice FROM reviews WHERE document_id = ? ORDER BY version DESC LIMIT 1`)
      .get(documentId) as ReviewRow | undefined;
    if (!review) throw new Error(`document ${documentId} に確定（reviews）が無い`);
    if (review.decision !== 'approve') {
      appendAudit(db, { actor: 'worker', action: 'receipt.meta_skipped', entity: 'document', entityId: documentId, payload: { review_version: review.version, decision: review.decision } }, now);
      return;
    }
    if (lastSentVersion(db, documentId) === review.version) return; // 同じ版は送り済み

    const up = db.prepare('SELECT id, state, remote_receipt_id, meta_deadline_on, meta_state FROM provider_uploads WHERE document_id = ? AND provider = ?').get(documentId, PROVIDER) as
      | UploadRow
      | undefined;
    const today = todayInTokyo(now);
    const deadline = up?.meta_deadline_on ?? addDays(doc.received_on, META_DEADLINE_DAYS);
    if (today > deadline) {
      markNeedsAttention(db, documentId, 'meta_deadline_passed', { meta_deadline_on: deadline, review_version: review.version }, { now });
      return;
    }
    if (!up || up.state !== 'uploaded' || !up.remote_receipt_id) {
      throw new DeferJob(new Date(now.getTime() + UPLOAD_WAIT_MS), `upload_pending: document ${documentId} の証憑がまだ freee に上がっていない`);
    }

    const meta = metaFromReview(db, documentId, review);
    const isLastAttempt = job.attempts + 1 >= job.max_attempts;
    try {
      await getDeps().provider.updateReceiptMeta(Number(up.remote_receipt_id), meta);
    } catch (e) {
      const msg = describeError(e).slice(0, 1000);
      db.prepare('UPDATE provider_uploads SET last_error = ? WHERE id = ?').run(msg, up.id);
      const reason =
        e instanceof ProviderError && !e.retryable ? (e.kind === 'auth_invalid_grant' ? 'freee_reauth_required' : 'meta_update_rejected') : isLastAttempt ? 'meta_retries_exhausted' : null;
      if (reason) markNeedsAttention(db, documentId, reason, { review_version: review.version, error: msg }, { now });
      throw e;
    }
    tx(db, () => {
      db.prepare(`UPDATE provider_uploads SET meta_state = 'sent', last_error = NULL WHERE id = ?`).run(up.id);
      appendAudit(
        db,
        {
          actor: 'worker',
          action: 'receipt.meta_updated',
          entity: 'document',
          entityId: documentId,
          payload: { provider: PROVIDER, remote_receipt_id: up.remote_receipt_id, review_id: review.id, review_version: review.version, meta },
        },
        now,
      );
    });
  };
}
