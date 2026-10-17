// 要対応（needs_attention）の一覧と解消（docs/mvp-plan.md T4-5）。文書（document_id）単位で扱う。
// - 理由は 2 か所にある: 文書の監査ログの最後の document.needs_attention（upload・extract・meta・backup）と、
//   deals.attention_reason（送信・照合）。新しい方（監査ログの seq が大きい方）を主な理由にし、両方を返す。
// - 解消は 2 通り:
//   retry   … 理由に応じたジョブを積み直し、documents.status を戻す（確定済みならその決定の状態、抽出済みなら needs_review、未抽出なら received）。
//             upload 系 → upload_receipt、extract 系 → extract、meta 系 → update_receipt_meta、deal 系 → send_deal。
//             同じ種類・同じ文書の queued のジョブがあれば積まずに run_after を今にする（running なら何もしない）。
//   dismiss … 人が freee 側などで対応したことを記録する（document.attention_dismissed）。状態は needs_attention のまま。
//             送信の要対応なら deals.attention_resolved_at も入れる（deal.attention_resolved。照合でも上書きしない）。
// - どちらも監査ログに残す（同じトランザクション）。
import { appendAudit } from '../audit.ts';
import { tx, type Db } from '../db/index.ts';
import { enqueue, type JobKind } from '../jobs/queue.ts';
import { STATUS_OF, type Decision } from './confirm.ts';
import { PROVIDER } from './fields.ts';

export const ATTENTION_ACTIONS = ['retry', 'dismiss'] as const;
export type AttentionAction = (typeof ATTENTION_ACTIONS)[number];
export type AttentionKind = 'upload' | 'extract' | 'meta' | 'deal';

const DOC_REASONS: Record<string, AttentionKind> = {
  upload_rejected: 'upload',
  upload_deadline_near: 'upload',
  upload_retries_exhausted: 'upload',
  ai_request_rejected: 'extract',
  ai_schema_invalid: 'extract',
  extract_retries_exhausted: 'extract',
  meta_deadline_passed: 'meta',
  meta_update_rejected: 'meta',
  meta_retries_exhausted: 'meta',
};
export const JOB_OF: Record<AttentionKind, JobKind> = { upload: 'upload_receipt', extract: 'extract', meta: 'update_receipt_meta', deal: 'send_deal' };

export type Attention = {
  document_id: string;
  status: string;
  received_on: string;
  deadline_on: string;
  source: 'document' | 'deal' | null;
  reason: string;
  kind: AttentionKind | null; // null は自動では直せない（backup の差分など）。dismiss だけ
  document_reason: string | null;
  deal_reason: string | null;
  deal_id: string | null;
  attention_at: string | null;
  detail: Record<string, unknown>;
  dismissed: boolean;
  actions: AttentionAction[];
};

type DocRow = { id: string; status: string; received_on: string; deadline_on: string };
type AuditRow = { seq: number; ts: string; payload_json: string };
type DealRow = { id: string; state: string; attention_reason: string | null; attention_detail_json: string | null; attention_at: string | null; attention_resolved_at: string | null };

const parse = (json: string | null): Record<string, unknown> => {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

function lastAudit(db: Db, sql: string, ...args: string[]): AuditRow | null {
  return (db.prepare(`${sql} ORDER BY seq DESC LIMIT 1`).get(...args) as AuditRow | undefined) ?? null;
}

// 再認可は upload と meta のどちらでも起きる。証憑がまだ freee に無ければ upload、あれば meta。
function reauthKind(db: Db, documentId: string): AttentionKind {
  const up = db.prepare(`SELECT 1 FROM provider_uploads WHERE document_id = ? AND provider = ? AND state = 'uploaded'`).get(documentId, PROVIDER);
  return up ? 'meta' : 'upload';
}

export function attentionOf(db: Db, documentId: string): Attention | null {
  const doc = db.prepare('SELECT id, status, received_on, deadline_on FROM documents WHERE id = ?').get(documentId) as DocRow | undefined;
  if (!doc) return null;
  const docEv = lastAudit(db, `SELECT seq, ts, payload_json FROM audit_log WHERE entity = 'document' AND entity_id = ? AND action = 'document.needs_attention'`, doc.id);
  const deal = db
    .prepare('SELECT id, state, attention_reason, attention_detail_json, attention_at, attention_resolved_at FROM deals WHERE document_id = ? AND provider = ?')
    .get(doc.id, PROVIDER) as DealRow | undefined;
  const dealOpen = deal?.state === 'needs_attention' ? deal : null;
  const dealEv = dealOpen ? lastAudit(db, `SELECT seq, ts, payload_json FROM audit_log WHERE entity = 'deal' AND entity_id = ? AND action = 'deal.needs_attention'`, dealOpen.id) : null;
  const dismissEv = lastAudit(db, `SELECT seq, ts, payload_json FROM audit_log WHERE entity = 'document' AND entity_id = ? AND action = 'document.attention_dismissed'`, doc.id);

  const docReason = docEv ? (parse(docEv.payload_json).reason as string | undefined) ?? null : null;
  const dealReason = dealOpen?.attention_reason ?? null;
  const useDeal = dealOpen !== null && (docEv === null || (dealEv?.seq ?? 0) > docEv.seq);
  const source: Attention['source'] = useDeal ? 'deal' : docEv ? 'document' : null;
  const reason = (useDeal ? dealReason : docReason) ?? 'unknown';
  let kind: AttentionKind | null = null;
  if (source === 'deal') kind = 'deal';
  else if (reason === 'freee_reauth_required') kind = reauthKind(db, doc.id);
  else kind = DOC_REASONS[reason] ?? null;

  const latestSeq = Math.max(docEv?.seq ?? 0, dealEv?.seq ?? 0);
  const dismissed = (dismissEv !== null && dismissEv.seq > latestSeq) || (useDeal && dealOpen?.attention_resolved_at !== null);
  const actions: AttentionAction[] = doc.status !== 'needs_attention' ? [] : kind ? ['retry', 'dismiss'] : ['dismiss'];
  if (dismissed) actions.splice(actions.indexOf('dismiss'), 1);
  return {
    document_id: doc.id,
    status: doc.status,
    received_on: doc.received_on,
    deadline_on: doc.deadline_on,
    source,
    reason,
    kind,
    document_reason: docReason,
    deal_reason: dealReason,
    deal_id: deal?.id ?? null,
    attention_at: useDeal ? (dealOpen?.attention_at ?? null) : (docEv?.ts ?? null),
    detail: useDeal ? parse(dealOpen?.attention_detail_json ?? null) : (() => {
      const { reason: _r, from: _f, ...rest } = parse(docEv?.payload_json ?? null);
      return rest;
    })(),
    dismissed,
    actions,
  };
}

// needs_attention の文書のうち、人がまだ dismiss していないもの。古い順。
export function listAttention(db: Db): Attention[] {
  const ids = db.prepare(`SELECT id FROM documents WHERE status = 'needs_attention' ORDER BY id`).all() as { id: string }[];
  return ids
    .map((r) => attentionOf(db, r.id))
    .filter((a): a is Attention => a !== null && !a.dismissed)
    .sort((a, b) => (a.attention_at ?? '').localeCompare(b.attention_at ?? '') || a.document_id.localeCompare(b.document_id));
}

// 戻す先の状態: 確定済みならその決定の状態、抽出済みなら needs_review、未抽出なら received。
export function restoredStatus(db: Db, documentId: string): string {
  const rv = db.prepare('SELECT decision FROM reviews WHERE document_id = ? ORDER BY version DESC LIMIT 1').get(documentId) as { decision: Decision } | undefined;
  if (rv && STATUS_OF[rv.decision]) return STATUS_OF[rv.decision];
  const ex = db.prepare('SELECT 1 FROM extractions WHERE document_id = ? LIMIT 1').get(documentId);
  return ex ? 'needs_review' : 'received';
}

function requeueJob(db: Db, kind: JobKind, documentId: string, now: Date): number {
  const cur = db
    .prepare(`SELECT id, state FROM jobs WHERE kind = ? AND ref_id = ? AND state IN ('queued', 'running') ORDER BY id DESC LIMIT 1`)
    .get(kind, documentId) as { id: number; state: string } | undefined;
  if (!cur) return enqueue(db, kind, documentId, { now });
  if (cur.state === 'queued') db.prepare('UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ?').run(now.toISOString(), now.toISOString(), cur.id);
  return cur.id;
}

export class AttentionError extends Error {
  readonly status: 404 | 409;
  readonly reason: string;
  constructor(status: 404 | 409, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

export type ResolveInput = { action: AttentionAction; note: string | null; user: string | null; now: Date };
export type ResolveResult = { document_id: string; action: AttentionAction; reason: string; status: string; job: { kind: JobKind; id: number } | null; resolved_at: string };

export function resolveAttention(db: Db, documentId: string, input: ResolveInput): ResolveResult {
  return tx(db, () => {
    const a = attentionOf(db, documentId);
    if (!a) throw new AttentionError(404, 'not_found');
    if (a.status !== 'needs_attention') throw new AttentionError(409, 'not_needs_attention');
    const iso = input.now.toISOString();
    const base = { reason: a.reason, source: a.source, kind: a.kind, deal_id: a.deal_id, note: input.note, user: input.user };

    if (input.action === 'dismiss') {
      if (a.dismissed) throw new AttentionError(409, 'already_dismissed');
      if (a.source === 'deal' && a.deal_id) {
        db.prepare('UPDATE deals SET attention_resolved_at = ?, updated_at = ? WHERE id = ?').run(iso, iso, a.deal_id);
        appendAudit(
          db,
          { actor: 'user', action: 'deal.attention_resolved', entity: 'deal', entityId: a.deal_id, payload: { document_id: a.document_id, reason: a.reason, note: input.note, user: input.user } },
          input.now,
        );
      }
      appendAudit(db, { actor: 'user', action: 'document.attention_dismissed', entity: 'document', entityId: a.document_id, payload: base }, input.now);
      return { document_id: a.document_id, action: 'dismiss', reason: a.reason, status: a.status, job: null, resolved_at: iso };
    }

    if (!a.kind) throw new AttentionError(409, 'not_retryable');
    const kind = JOB_OF[a.kind];
    // TODO: deals 行を needs_attention から戻す requeueDeal(db, documentId)（src/deals/stateMachine.ts、別担当）ができたら、
    // deal 系はそれを呼ぶ。いまは send_deal を積むだけ。
    const jobId = requeueJob(db, kind, a.document_id, input.now);
    const next = restoredStatus(db, a.document_id);
    db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(next, a.document_id);
    appendAudit(
      db,
      { actor: 'user', action: 'document.attention_retried', entity: 'document', entityId: a.document_id, payload: { ...base, job: { kind, id: jobId }, status: { from: a.status, to: next } } },
      input.now,
    );
    return { document_id: a.document_id, action: 'retry', reason: a.reason, status: next, job: { kind, id: jobId }, resolved_at: iso };
  });
}
