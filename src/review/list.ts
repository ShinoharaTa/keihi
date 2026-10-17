// 一覧（docs/mvp-plan.md T2-11、mvp-plan-v0.1.md T2-11）。確認待ち・要対応・期限までの残り営業日。
// - 確認待ち（review）: 確定の版（reviews）がまだ無く、needs_attention でもないもの。期限の近い順（2 営業日以内が先頭に来る）。
// - 要対応（attention）: status = needs_attention。理由は監査ログの最後の document.needs_attention の reason。
// - 残り営業日（days_left）: 今日の翌日〜期限日の営業日の数。期限が今日なら 0、過ぎていれば負（過ぎた営業日の数）。
import { addDays, isBusinessDay, todayInTokyo, type CalendarOptions } from '../calendar/businessDays.ts';
import type { Db } from '../db/index.ts';

export const URGENT_BUSINESS_DAYS = 2;
export const LIST_FILTERS = ['review', 'attention', 'needs_review', 'approved', 'personal', 'duplicate', 'rejected', 'received'] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];
const MAX_SPAN_DAYS = 800; // 数え上げの上限（壊れた日付で回り続けない）

export function businessDaysLeft(today: string, deadlineOn: string, opts: CalendarOptions = {}): number {
  if (deadlineOn === today) return 0;
  const forward = deadlineOn > today;
  let [from, to] = forward ? [today, deadlineOn] : [deadlineOn, today];
  let n = 0;
  for (let i = 0; i < MAX_SPAN_DAYS && from < to; i++) {
    from = addDays(from, 1);
    if (isBusinessDay(from, opts)) n++;
  }
  return forward ? n : -n;
}

export type ListItem = {
  id: string;
  received_on: string;
  kind: string;
  status: string;
  deadline_on: string;
  paper_required: boolean;
  created_at: string;
  days_left: number;
  urgent: boolean;
  reviewed: boolean;
  needs_attention_reason: string | null;
};

type Row = {
  id: string;
  received_on: string;
  kind: string;
  status: string;
  deadline_on: string;
  paper_required: number;
  created_at: string;
  reviewed: number;
  reason: string | null;
};

const SELECT = `SELECT d.id, d.received_on, d.kind, d.status, d.deadline_on, d.paper_required, d.created_at,
  EXISTS (SELECT 1 FROM reviews r WHERE r.document_id = d.id) AS reviewed,
  CASE WHEN d.status = 'needs_attention' THEN (
    SELECT json_extract(a.payload_json, '$.reason') FROM audit_log a
    WHERE a.entity = 'document' AND a.entity_id = d.id AND a.action = 'document.needs_attention'
    ORDER BY a.seq DESC LIMIT 1) END AS reason
  FROM documents d`;

export const REVIEW_WHERE = `NOT EXISTS (SELECT 1 FROM reviews r WHERE r.document_id = d.id) AND d.status <> 'needs_attention'`;

export type ListOptions = { now: Date; calendar?: CalendarOptions; limit: number };

function toItem(r: Row, today: string, cal: CalendarOptions): ListItem {
  const days = businessDaysLeft(today, r.deadline_on, cal);
  return {
    id: r.id,
    received_on: r.received_on,
    kind: r.kind,
    status: r.status,
    deadline_on: r.deadline_on,
    paper_required: r.paper_required === 1,
    created_at: r.created_at,
    days_left: days,
    urgent: days <= URGENT_BUSINESS_DAYS,
    reviewed: r.reviewed === 1,
    needs_attention_reason: typeof r.reason === 'string' ? r.reason : null,
  };
}

// filter なし: 新しい順（送信済み一覧。T1-12 のまま）。review・attention: 期限の近い順。それ以外: status が一致するものを新しい順。
export function listDocuments(db: Db, filter: ListFilter | null, opts: ListOptions): ListItem[] {
  const today = todayInTokyo(opts.now);
  const cal = opts.calendar ?? {};
  let sql: string;
  const args: (string | number)[] = [];
  if (filter === null) sql = `${SELECT} ORDER BY d.id DESC LIMIT ?`;
  else if (filter === 'review') sql = `${SELECT} WHERE ${REVIEW_WHERE} ORDER BY d.deadline_on, d.id LIMIT ?`;
  else if (filter === 'attention') sql = `${SELECT} WHERE d.status = 'needs_attention' ORDER BY d.deadline_on, d.id LIMIT ?`;
  else {
    sql = `${SELECT} WHERE d.status = ? ORDER BY d.id DESC LIMIT ?`;
    args.push(filter);
  }
  args.push(opts.limit);
  return (db.prepare(sql).all(...args) as Row[]).map((r) => toItem(r, today, cal));
}

// バッジ用の件数。urgent は確認待ちのうち残り 2 営業日以内。
export function countDocuments(db: Db, opts: Omit<ListOptions, 'limit'>): { review: number; attention: number; urgent: number } {
  const today = todayInTokyo(opts.now);
  const cal = opts.calendar ?? {};
  const pending = db.prepare(`SELECT d.deadline_on FROM documents d WHERE ${REVIEW_WHERE}`).all() as { deadline_on: string }[];
  const attention = (db.prepare(`SELECT count(*) n FROM documents WHERE status = 'needs_attention'`).get() as { n: number }).n;
  const urgent = pending.filter((r) => businessDaysLeft(today, r.deadline_on, cal) <= URGENT_BUSINESS_DAYS).length;
  return { review: pending.length, attention, urgent };
}
