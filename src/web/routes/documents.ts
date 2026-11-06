// GET /api/documents（docs/mvp-plan.md T1-12 の送信済み一覧、T2-11 の一覧）。
//   ?status なし               → 新しい順に最大 50 件（送信済み一覧）
//   ?status=review             → 確認待ち。期限の近い順（2 営業日以内が先頭）
//   ?status=attention          → 要対応（needs_attention）。期限の近い順。理由は needs_attention_reason
//   ?status=<documents.status> → その状態のものを新しい順
//   → 200 {items: [{id, received_on, kind, status, deadline_on, paper_required, created_at, days_left, urgent, reviewed, needs_attention_reason}]}
//   → 400 status が不正
// GET /api/documents/counts → 200 {review, attention, urgent, upcoming}（PWA のバッジ用。upcoming は期日の通知の期間に入った予定の件数、T305）
// 一覧に要らない列（ファイル名・ハッシュ・保存先）は返さない。
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { todayInTokyo } from '../../calendar/businessDays.ts';
import { dueSoonCount } from '../../cashflow/upcoming.ts';
import { countDocuments, LIST_FILTERS, listDocuments, type ListFilter } from '../../review/list.ts';

const LIMIT = 50;
const FILTERED_LIMIT = 200;

export function documentsRoutes(deps: Pick<AppDeps, 'db' | 'config' | 'now'>): Hono {
  const r = new Hono();
  const now = () => (deps.now ? deps.now() : new Date());
  const calendar = () => ({ yearEndHolidays: deps.config.calendar.yearEndHolidays });
  r.get('/documents', (c) => {
    const s = c.req.query('status');
    if (s !== undefined && !(LIST_FILTERS as readonly string[]).includes(s)) return c.json({ reason: 'invalid_status' }, 400);
    const filter = (s ?? null) as ListFilter | null;
    const items = listDocuments(deps.db, filter, { now: now(), calendar: calendar(), limit: filter === null ? LIMIT : FILTERED_LIMIT });
    return c.json({ items });
  });
  r.get('/documents/counts', (c) => {
    const t = now();
    return c.json({ ...countDocuments(deps.db, { now: t, calendar: calendar() }), upcoming: dueSoonCount(deps.db, todayInTokyo(t)) });
  });
  return r;
}
