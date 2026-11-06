// 取引の送信の状態機械（docs/mvp-plan.md T4-2、architecture.md §3.3）。
//   queued → sending → deal_created → receipt_linked → verified
//   どこからでも needs_attention（4xx・再試行の上限・照合の差分）。verified も照合の差分で needs_attention に戻る。
//   needs_attention → queued: freee にまだ取引が無い（remote_deal_id が NULL）ものだけ。要対応の再送（requeueDeal）か、
//   新しい確定版が来たとき（ensureDealRow）。
// - 冪等キーが freee に無いので、POST /deals を 2 回目以降に試す前に、発生日の範囲で listDeals を取り、
//   ref_number を手元で照合する（GET に ref_number の絞り込みは無い）。見つかればそれを採用して送らない。
// - 再送の間隔はジョブキューのバックオフ（1 → 5 → 30 → 120 分、最大 6 回。src/jobs/queue.ts）に任せる。
// - 状態を変えるたびに監査ログに残す（同じトランザクション）。documents.status も合わせる（sent / verified / needs_attention）。
import { createHash } from 'node:crypto';
import { appendAudit, canonicalJson } from '../audit.ts';
import { tx, type Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';
import type { Deal, Provider } from '../providers/types.ts';
import type { DealDraft } from './builder.ts';

export const DEAL_STATES = ['queued', 'sending', 'deal_created', 'receipt_linked', 'verified', 'needs_attention'] as const;
export type DealState = (typeof DEAL_STATES)[number];

const NEXT: Record<DealState, readonly DealState[]> = {
  queued: ['sending', 'needs_attention'],
  sending: ['sending', 'deal_created', 'receipt_linked', 'needs_attention'],
  deal_created: ['receipt_linked', 'needs_attention'],
  receipt_linked: ['verified', 'needs_attention'],
  verified: ['verified', 'needs_attention'],
  needs_attention: ['queued'],
};

export function canTransition(from: DealState, to: DealState): boolean {
  return NEXT[from].includes(to);
}

// 送信状態 → documents.status。
const DOCUMENT_STATUS: Partial<Record<DealState, string>> = {
  queued: 'approved', // needs_attention から戻したとき（送る前の確定版は approve）
  deal_created: 'sent',
  receipt_linked: 'sent',
  verified: 'verified',
  needs_attention: 'needs_attention',
};

export type AttentionReason =
  | 'send_rejected' // 4xx（再送しない）
  | 'freee_reauth_required' // 401 invalid_grant
  | 'send_retries_exhausted'
  | 'build_failed' // 確定版から取引を作れない（科目・税区分の対応など）
  | 'review_changed_after_send' // 送った後に確定版が変わった
  | 'duplicate_deals' // 同じ ref_number の取引が freee に複数ある
  | 'deal_missing' // 照合: 取引が消えた
  | 'receipt_detached' // 照合: 証憑が外れた
  | 'amount_changed' // 照合: 金額が変わった
  | 'account_changed'; // 照合: 科目が変わった

export type DealRow = {
  id: string;
  document_id: string;
  review_id: string;
  provider: string;
  ref_number: string;
  state: DealState;
  issue_date: string;
  draft_json: string;
  draft_sha256: string;
  remote_deal_id: string | null;
  attempts: number;
  last_error: string | null;
  attention_reason: string | null;
  attention_detail_json: string | null;
  attention_at: string | null;
  attention_resolved_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

export function draftOf(row: DealRow): DealDraft {
  return JSON.parse(row.draft_json) as DealDraft;
}

export function getDealRow(db: Db, id: string): DealRow | null {
  return (db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as DealRow | undefined) ?? null;
}

export function dealRowForDocument(db: Db, documentId: string, provider: string): DealRow | null {
  return (db.prepare('SELECT * FROM deals WHERE document_id = ? AND provider = ?').get(documentId, provider) as DealRow | undefined) ?? null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// 文書の送信行を作る（既にあれば何もしない）。queued のままなら確定版の変更を下書きに反映する。
// - needs_attention で freee にまだ取引が無い行に新しい確定版が来たら、新しい下書きで queued に戻す。
// - 送った後（sending 以降）に確定版が変わったら、上書きせず下書きを比べる。同じ（memo だけの変更など、送る内容が
//   変わらない）なら何もしない。違えば needs_attention（review_changed_after_send）にする。
//   証憑（receiptIds）は下書きを作った時点のアップロードの状態で変わるので、比べるときは送った下書きの値に揃える。
export function ensureDealRow(db: Db, input: { documentId: string; reviewId: string; provider: string; draft: DealDraft }, now: Date): DealRow {
  return tx(db, () => {
    const json = canonicalJson(input.draft);
    const sha = sha256(json);
    const iso = now.toISOString();
    const cur = dealRowForDocument(db, input.documentId, input.provider);
    if (!cur) {
      const id = ulid(now.getTime());
      db.prepare(
        `INSERT INTO deals (id, document_id, review_id, provider, ref_number, state, issue_date, draft_json, draft_sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      ).run(id, input.documentId, input.reviewId, input.provider, input.draft.refNumber, input.draft.issueDate, json, sha, iso, iso);
      appendAudit(db, { actor: 'worker', action: 'deal.queued', entity: 'deal', entityId: id, payload: { document_id: input.documentId, review_id: input.reviewId, ref_number: input.draft.refNumber, draft_sha256: sha } }, now);
      return getDealRow(db, id)!;
    }
    const updateDraft = () =>
      db.prepare('UPDATE deals SET review_id = ?, issue_date = ?, draft_json = ?, draft_sha256 = ?, updated_at = ? WHERE id = ?').run(
        input.reviewId,
        input.draft.issueDate,
        json,
        sha,
        iso,
        cur.id,
      );
    if (cur.state === 'queued') {
      // 同じ確定版でも下書きが変わることがある（build_failed の後にマスタを直して再送したときなど）。
      if (cur.review_id === input.reviewId && cur.draft_sha256 === sha) return cur;
      updateDraft();
      appendAudit(db, { actor: 'worker', action: 'deal.draft_updated', entity: 'deal', entityId: cur.id, payload: { review_id: input.reviewId, draft_sha256: sha } }, now);
      return getDealRow(db, cur.id)!;
    }
    if (cur.review_id === input.reviewId) return cur;
    if (cur.state === 'needs_attention' && cur.remote_deal_id === null) {
      updateDraft();
      return transition(db, cur.id, 'queued', {}, now, { reason: 'review_changed', review_id: input.reviewId, draft_sha256: sha });
    }
    if (sha256(canonicalJson({ ...input.draft, receiptIds: draftOf(cur).receiptIds })) === cur.draft_sha256) return cur;
    if (cur.state !== 'needs_attention') {
      markNeedsAttention(db, cur.id, 'review_changed_after_send', { sent_review_id: cur.review_id, new_review_id: input.reviewId }, now);
    }
    return getDealRow(db, cur.id)!;
  });
}

// 要対応の再送（POST /api/documents/:id/attention/resolve）。needs_attention の行を queued に戻す（下書きは次の send_deal で作り直す）。
// freee に取引がある（remote_deal_id がある）行は戻せない（再送の前の照合で既存の取引を採用してしまうため）。
// needs_attention の行が無ければ null。send_deal を積むのは呼び出し側。
export function requeueDeal(db: Db, documentId: string, opts: { reason: string; now?: Date }): DealRow | null {
  const now = opts.now ?? new Date();
  return tx(db, () => {
    const row = db.prepare(`SELECT * FROM deals WHERE document_id = ? AND state = 'needs_attention' ORDER BY id LIMIT 1`).get(documentId) as DealRow | undefined;
    if (!row) return null;
    if (row.remote_deal_id !== null) throw new Error(`deal ${row.id}: freee に取引（${row.remote_deal_id}）があるので queued に戻せない`);
    return transition(db, row.id, 'queued', {}, now, { reason: opts.reason, attention_reason: row.attention_reason });
  });
}

export type TransitionPatch = { remoteDealId?: number; lastError?: string | null; verifiedAt?: string };

// 状態を進める。許されない遷移は投げる。同じ状態への遷移（sending → sending など）も監査に残す。
export function transition(db: Db, id: string, to: DealState, patch: TransitionPatch, now: Date, payload: Record<string, unknown> = {}): DealRow {
  return tx(db, () => {
    const cur = getDealRow(db, id);
    if (!cur) throw new Error(`deal ${id} が無い`);
    if (!canTransition(cur.state, to)) throw new Error(`deal ${id}: ${cur.state} → ${to} には進めない`);
    const iso = now.toISOString();
    db.prepare(
      `UPDATE deals SET state = ?, remote_deal_id = COALESCE(?, remote_deal_id), last_error = ?, verified_at = COALESCE(?, verified_at), updated_at = ? WHERE id = ?`,
    ).run(to, patch.remoteDealId === undefined ? null : String(patch.remoteDealId), patch.lastError === undefined ? cur.last_error : patch.lastError, patch.verifiedAt ?? null, iso, id);
    if (to !== cur.state) {
      setDocumentStatus(db, cur.document_id, to, now);
      appendAudit(db, { actor: 'worker', action: `deal.${to}`, entity: 'deal', entityId: id, payload: { from: cur.state, document_id: cur.document_id, ...payload, ...(patch.remoteDealId !== undefined ? { remote_deal_id: patch.remoteDealId } : {}) } }, now);
    }
    return getDealRow(db, id)!;
  });
}

function setDocumentStatus(db: Db, documentId: string, state: DealState, now: Date): void {
  const status = DOCUMENT_STATUS[state];
  if (!status) return;
  const cur = db.prepare('SELECT status FROM documents WHERE id = ?').get(documentId) as { status: string } | undefined;
  if (!cur || cur.status === status) return;
  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(status, documentId);
  appendAudit(db, { actor: 'worker', action: 'document.status', entity: 'document', entityId: documentId, payload: { from: cur.status, to: status } }, now);
}

// needs_attention にする（どの状態からでも。既に needs_attention なら何もしない）。
export function markNeedsAttention(db: Db, id: string, reason: AttentionReason, detail: Record<string, unknown>, now: Date): DealRow {
  return tx(db, () => {
    const cur = getDealRow(db, id);
    if (!cur) throw new Error(`deal ${id} が無い`);
    if (cur.state === 'needs_attention') return cur;
    const iso = now.toISOString();
    db.prepare(
      `UPDATE deals SET state = 'needs_attention', attention_reason = ?, attention_detail_json = ?, attention_at = ?, attention_resolved_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(reason, canonicalJson(detail), iso, iso, id);
    setDocumentStatus(db, cur.document_id, 'needs_attention', now);
    appendAudit(db, { actor: 'worker', action: 'deal.needs_attention', entity: 'deal', entityId: id, payload: { from: cur.state, reason, document_id: cur.document_id, ...detail } }, now);
    return getDealRow(db, id)!;
  });
}

// POST /deals を試みる直前に数える（応答の前に落ちても、次は照合から始める）。
export function countAttempt(db: Db, id: string, now: Date): void {
  db.prepare('UPDATE deals SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(now.toISOString(), id);
}

export function recordError(db: Db, id: string, error: string, now: Date): void {
  db.prepare('UPDATE deals SET last_error = ?, updated_at = ? WHERE id = ?').run(error.slice(0, 1000), now.toISOString(), id);
}

// 発生日の範囲で一覧を取り、ref_number を手元で照合する。複数あれば ID の小さい順。
export async function findDealsByRef(provider: Pick<Provider, 'listDeals'>, refNumber: string, issueDate: string): Promise<Deal[]> {
  const all = await provider.listDeals({ startIssueDate: issueDate, endIssueDate: issueDate });
  return all.filter((d) => d.refNumber === refNumber).sort((a, b) => a.id - b.id);
}

// アップロード済みの証憑の ID（provider_uploads.remote_receipt_id）。まだなら空。
export function uploadedReceiptIds(db: Db, documentId: string, provider: string): number[] {
  const row = db.prepare(`SELECT remote_receipt_id FROM provider_uploads WHERE document_id = ? AND provider = ? AND state = 'uploaded'`).get(documentId, provider) as
    | { remote_receipt_id: string | null }
    | undefined;
  return row?.remote_receipt_id ? [Number(row.remote_receipt_id)] : [];
}

// deal_created の取引に、アップロード済みの証憑を付ける。付けたら receipt_linked。まだ証憑が無ければ何もしない。
// 例外（Provider の失敗）は呼び出し側に任せる。
export async function linkReceiptsIfReady(db: Db, provider: Pick<Provider, 'attachReceipts'>, row: DealRow, now: Date): Promise<DealRow> {
  if (row.state !== 'deal_created' || row.remote_deal_id === null) return row;
  const ids = uploadedReceiptIds(db, row.document_id, row.provider);
  if (ids.length === 0) return row;
  const deal = await provider.attachReceipts(Number(row.remote_deal_id), ids);
  return transition(db, row.id, 'receipt_linked', { lastError: null }, now, { remote_receipt_ids: deal.receiptIds, via: 'attach' });
}
