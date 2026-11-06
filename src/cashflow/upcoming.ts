// 期日の通知（docs/mvp-plan-v3.md T305、V4）。プッシュ通知はしない。PWA のバッジ（GET /api/documents/counts の upcoming）と MCP の list_upcoming 用。
// today は呼ぶ側が Asia/Tokyo の暦日で渡す。
import { addDays } from '../calendar/businessDays.ts';
import type { Db } from '../db/index.ts';
import { listScheduledItems } from './repo.ts';
import { nextDue, upcoming, type Upcoming } from './schedule.ts';

export const UPCOMING_DEFAULT_DAYS = 30;

// 今日〜今日 + days 日（両端を含む）の期日。
export function upcomingItems(db: Db, opts: { today: string; days?: number }): { from: string; to: string; items: Upcoming[] } {
  return upcoming(db, opts.today, opts.days ?? UPCOMING_DEFAULT_DAYS);
}

// active な項目のうち、次の期日（今日を含む）の notify_days_before 日前から期日の当日までに入るものの件数。
export function dueSoonCount(db: Db, today: string): number {
  let n = 0;
  for (const it of listScheduledItems(db)) {
    const due = nextDue(it, today);
    if (due !== null && addDays(due, -it.notify_days_before) <= today) n++;
  }
  return n;
}
