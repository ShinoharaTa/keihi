// 対応表のエクスポート（docs/mvp-plan.md T4-7、legal.md §7 R13）。取引 ID ⇔ 証憑 ID ⇔ keihi の ID。
// 1 文書 1 行（documents と件数が一致する）。year を渡せば受領日（received_on）の年で絞る。
// - status は送信の状態（deals.state）。取引をまだ作っていない文書は空。
// - paper_status は paper.ts の計算値（discarded を含む）。
// - retain_until は keihi 側の保持期限（src/retention.ts。[retention] から計算）。
// - CSV は RFC 4180（CRLF、必要なときだけ二重引用符）。表計算ソフトの数式にならないよう、= + - @ で始まる値は先頭に ' を付ける。
import type { Db } from '../db/index.ts';
import type { Config } from '../config.ts';
import { retainUntil } from '../retention.ts';
import { computePaperStatus, discardAllowed, paperInputOf } from './paper.ts';

export const MAPPING_COLUMNS = ['document_id', 'sha256', 'received_on', 'uploaded_at', 'remote_receipt_id', 'remote_deal_id', 'status', 'paper_status', 'retain_until'] as const;

type Row = {
  document_id: string;
  sha256: string;
  received_on: string;
  uploaded_at: string | null;
  remote_receipt_id: string | null;
  remote_deal_id: string | null;
  status: string | null;
  kind: 'scan' | 'e_transaction';
  deadline_on: string;
  integrity_checked_at: string | null;
  paper_required: number;
  resolution_ok: number | null;
  paper_discarded_at: string | null;
};

export function csvField(v: string | number | null): string {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function mappingRows(db: Db, opts: { provider: string; retention: Config['retention']; year?: number; now?: Date }): Record<(typeof MAPPING_COLUMNS)[number], string | null>[] {
  const now = opts.now ?? new Date();
  const allowed = discardAllowed(db);
  const where = opts.year === undefined ? '' : `WHERE d.received_on >= ? AND d.received_on <= ?`;
  const args: (string | number)[] = [opts.provider, opts.provider];
  if (opts.year !== undefined) args.push(`${opts.year}-01-01`, `${opts.year}-12-31`);
  const rows = db
    .prepare(
      `SELECT d.id AS document_id, d.sha256, d.received_on, u.uploaded_at, u.remote_receipt_id, x.remote_deal_id, x.state AS status,
         d.kind, d.deadline_on, d.integrity_checked_at, d.paper_required, d.resolution_ok, d.paper_discarded_at
       FROM documents d
       LEFT JOIN provider_uploads u ON u.document_id = d.id AND u.provider = ?
       LEFT JOIN deals x ON x.document_id = d.id AND x.provider = ?
       ${where}
       ORDER BY d.received_on, d.id`,
    )
    .all(...args) as Row[];
  return rows.map((r) => ({
    document_id: r.document_id,
    sha256: r.sha256,
    received_on: r.received_on,
    uploaded_at: r.uploaded_at,
    remote_receipt_id: r.remote_receipt_id,
    remote_deal_id: r.remote_deal_id,
    status: r.status,
    paper_status: computePaperStatus(paperInputOf(r, now, allowed)).status,
    retain_until: retainUntil(r, opts),
  }));
}

export function mappingCsv(db: Db, opts: { provider: string; retention: Config['retention']; year?: number; now?: Date }): string {
  const lines = [MAPPING_COLUMNS.join(',')];
  for (const r of mappingRows(db, opts)) lines.push(MAPPING_COLUMNS.map((c) => csvField(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
