// 紙原本のステータス（docs/mvp-plan.md T4-6、legal.md §7 R8・R9）。
//   keep_required（保管要）/ discard_ok（廃棄可）/ discarded（廃棄済）/ unknown（まだ決まらない）
// - discard_ok は「期限（deadline_on）までに保存完了（freee へのアップロード）」+「期限までに同等確認済み
//   （integrity_checked_at）」のときだけ（R9）。
// - 期限を過ぎてもどちらかが済んでいなければ keep_required（R8）。済んだ日は後から変わらないので以後 discard_ok にならない。
// - 要件を満たさず受理した（force 受理・解像度不足。paper_required = 1 / resolution_ok = 0）は keep_required。
// - 税理士 #1（API で上げたスマホ画像がスキャナ保存として有効か）の回答までは紙原本を全件保管する（mvp-plan.md §3.3）。
//   settings の paper_discard_allowed が true になるまで、discard_ok は keep_required に置き換える。
// - 電子取引（kind = e_transaction）は紙原本が無いので unknown のまま（判定しない）。
// - discarded は documents.paper_discarded_at（0004_deals.sql）で持つ。0001 の paper_status の CHECK に無いため。
import { getSetting } from '../attention.ts';
import { appendAudit } from '../audit.ts';
import { todayInTokyo } from '../calendar/businessDays.ts';
import { tx, type Db } from '../db/index.ts';

export type StoredPaperStatus = 'keep_required' | 'discard_ok' | 'unknown';
export type PaperStatus = StoredPaperStatus | 'discarded';

export type PaperInput = {
  kind: 'scan' | 'e_transaction';
  deadlineOn: string; // YYYY-MM-DD
  uploadedOn: string | null; // 保存完了の日（JST）
  integrityCheckedOn: string | null; // 同等確認の日（JST）
  paperRequired: boolean; // force 受理など
  resolutionOk: boolean | null; // false = 解像度不足
  discardedAt: string | null;
  today: string; // JST
  discardAllowed: boolean; // 税理士 #1 の回答後に true
};

export type PaperResult = { status: PaperStatus; reasons: string[] };

export function computePaperStatus(p: PaperInput): PaperResult {
  if (p.discardedAt) return { status: 'discarded', reasons: [] };
  if (p.kind === 'e_transaction') return { status: 'unknown', reasons: ['e_transaction'] };
  const reasons: string[] = [];
  if (p.paperRequired) reasons.push('accepted_with_force');
  if (p.resolutionOk === false) reasons.push('resolution_insufficient');
  const uploadedInTime = p.uploadedOn !== null && p.uploadedOn <= p.deadlineOn;
  const checkedInTime = p.integrityCheckedOn !== null && p.integrityCheckedOn <= p.deadlineOn;
  if (p.today > p.deadlineOn) {
    if (!uploadedInTime) reasons.push('upload_after_deadline');
    if (!checkedInTime) reasons.push('integrity_check_after_deadline');
  }
  if (reasons.length) return { status: 'keep_required', reasons };
  if (uploadedInTime && checkedInTime) {
    if (!p.discardAllowed) return { status: 'keep_required', reasons: ['tax_advisor_pending'] };
    return { status: 'discard_ok', reasons: [] };
  }
  return { status: 'unknown', reasons: [] };
}

export const DISCARD_ALLOWED_KEY = 'paper_discard_allowed';

export function discardAllowed(db: Db): boolean {
  return getSetting(db, DISCARD_ALLOWED_KEY) === true;
}

export type PaperRow = {
  id: string;
  kind: 'scan' | 'e_transaction';
  deadline_on: string;
  integrity_checked_at: string | null;
  paper_required: number;
  resolution_ok: number | null;
  paper_status: StoredPaperStatus;
  paper_discarded_at: string | null;
  uploaded_at: string | null;
};

const SELECT = `SELECT d.id, d.kind, d.deadline_on, d.integrity_checked_at, d.paper_required, d.resolution_ok, d.paper_status, d.paper_discarded_at,
  (SELECT min(u.uploaded_at) FROM provider_uploads u WHERE u.document_id = d.id AND u.state = 'uploaded') AS uploaded_at
  FROM documents d`;

const jstDay = (iso: string | null) => (iso ? todayInTokyo(new Date(iso)) : null);

export function paperInputOf(r: Omit<PaperRow, 'id' | 'paper_status'>, now: Date, allowed: boolean): PaperInput {
  return {
    kind: r.kind,
    deadlineOn: r.deadline_on,
    uploadedOn: jstDay(r.uploaded_at),
    integrityCheckedOn: jstDay(r.integrity_checked_at),
    paperRequired: r.paper_required === 1,
    resolutionOk: r.resolution_ok === null ? null : r.resolution_ok === 1,
    discardedAt: r.paper_discarded_at,
    today: todayInTokyo(now),
    discardAllowed: allowed,
  };
}

// 1 件のステータスを計算する（書き込まない）。無ければ null。
export function paperStatusOf(db: Db, documentId: string, now: Date = new Date()): PaperResult | null {
  const r = db.prepare(`${SELECT} WHERE d.id = ?`).get(documentId) as PaperRow | undefined;
  return r ? computePaperStatus(paperInputOf(r, now, discardAllowed(db))) : null;
}

// documents.paper_status を計算し直して保存する（変わったものだけ。監査ログに残す）。documentId を省けば全件。
// 日次（worker/handlers/daily.ts）から呼ぶ。
export function refreshPaperStatuses(db: Db, now: Date = new Date(), documentId?: string): number {
  return tx(db, () => {
    const allowed = discardAllowed(db);
    const rows = (documentId ? db.prepare(`${SELECT} WHERE d.id = ?`).all(documentId) : db.prepare(SELECT).all()) as PaperRow[];
    let changed = 0;
    for (const r of rows) {
      const res = computePaperStatus(paperInputOf(r, now, allowed));
      if (res.status === 'discarded' || res.status === r.paper_status) continue;
      db.prepare('UPDATE documents SET paper_status = ? WHERE id = ?').run(res.status, r.id);
      appendAudit(db, { actor: 'worker', action: 'document.paper_status', entity: 'document', entityId: r.id, payload: { from: r.paper_status, to: res.status, reasons: res.reasons } }, now);
      changed++;
    }
    return changed;
  });
}

export type DiscardResult = { ok: true; status: 'discarded'; already: boolean } | { ok: false; status: PaperStatus | null; reasons: string[] };

// 人が紙原本を廃棄した（POST /api/documents/:id/paper）。discard_ok のときだけ受け付ける。
export function markPaperDiscarded(db: Db, documentId: string, by: { actor: string; user?: string | null }, now: Date = new Date()): DiscardResult {
  return tx(db, () => {
    const res = paperStatusOf(db, documentId, now);
    if (!res) return { ok: false, status: null, reasons: ['not_found'] };
    if (res.status === 'discarded') return { ok: true, status: 'discarded', already: true };
    if (res.status !== 'discard_ok') return { ok: false, status: res.status, reasons: res.reasons };
    db.prepare('UPDATE documents SET paper_discarded_at = ? WHERE id = ?').run(now.toISOString(), documentId);
    appendAudit(db, { actor: by.actor, action: 'document.paper_discarded', entity: 'document', entityId: documentId, payload: { from: 'discard_ok', user: by.user ?? null } }, now);
    return { ok: true, status: 'discarded', already: false };
  });
}
