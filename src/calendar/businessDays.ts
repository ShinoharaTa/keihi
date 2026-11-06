// 営業日カレンダーと入力期限（docs/mvp-plan-v0.1.md T1-7、legal.md R6）。日付は Asia/Tokyo の暦日 'YYYY-MM-DD'（D10）。
// - 休業日: 土日 + 国民の祝日・休日（holidays.json。内閣府 CSV から tools/update-holidays.ts で生成）
//   + 設定で年末年始（12/29〜1/3）。年末年始の既定は「含めない」（期限が短い方に倒す）。
// - early: 受領日から 7 営業日目。cycle: 受領日 + 2 か月（応当日が無ければその月の末日）を起点に 7 営業日目。
// - 数え始め（countFrom）の既定は receipt_day = 起点が営業日ならその日を 1 日目（休日なら次の営業日が 1 日目）。
//   next_day は起点の翌日から数える（初日不算入）。この期限は内部の警告用で、早い方を既定にしている。
//   税理士確認 #3（入力期限の数え方）の結果で既定を変える前提。
// - 祝日データの無い年にかかるときは warnings を返す（祝日を営業日として数えるので、期限は早くなる側にずれる）。
import holidaysFile from './holidays.json' with { type: 'json' };

export type DeadlineMode = 'early' | 'cycle';
export type CountFrom = 'receipt_day' | 'next_day';
export type CalendarOptions = { yearEndHolidays?: boolean; countFrom?: CountFrom };

export const BUSINESS_DAYS = 7;
export const CYCLE_MONTHS = 2;

const HOLIDAYS: Record<string, string> = holidaysFile.holidays;
const FIRST_YEAR = holidaysFile.first_year;
const LAST_YEAR = holidaysFile.last_year;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(d: string): Date {
  const m = DATE_RE.exec(d);
  if (!m) throw new Error(`日付は YYYY-MM-DD: ${d}`);
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (fmt(t) !== d) throw new Error(`存在しない日付: ${d}`);
  return t;
}

function fmt(t: Date): string {
  return t.toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  const t = parse(d);
  t.setUTCDate(t.getUTCDate() + n);
  return fmt(t);
}

// 月を足す。応当日が無ければその月の末日（例: 12-31 + 2 か月 → 02-28）。
export function addMonths(d: string, n: number): string {
  const t = parse(d);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(y, m, Math.min(t.getUTCDate(), last))));
}

// Asia/Tokyo の今日（R5 の受領日の既定）。
export function todayInTokyo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function holidayName(d: string): string | null {
  parse(d);
  return HOLIDAYS[d] ?? null;
}

export function hasHolidayData(year: number): boolean {
  return year >= FIRST_YEAR && year <= LAST_YEAR;
}

export function isBusinessDay(d: string, opts: CalendarOptions = {}): boolean {
  const t = parse(d);
  const dow = t.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (HOLIDAYS[d]) return false;
  if (opts.yearEndHolidays) {
    const md = d.slice(5);
    if (md >= '12-29' || md <= '01-03') return false;
  }
  return true;
}

// start から数えて n 営業日目（countFrom に従う）。
export function nthBusinessDay(start: string, n: number, opts: CalendarOptions = {}): string {
  if (!Number.isInteger(n) || n < 1) throw new Error('n は 1 以上の整数');
  let d = (opts.countFrom ?? 'receipt_day') === 'next_day' ? addDays(start, 1) : start;
  let count = 0;
  for (;;) {
    if (isBusinessDay(d, opts)) count++;
    if (count === n) return d;
    d = addDays(d, 1);
  }
}

// d より前の n 営業日目（R7 の「期限の 2 営業日前」など）。d 自体は数えない。
export function subtractBusinessDays(d: string, n: number, opts: CalendarOptions = {}): string {
  let cur = d;
  for (let count = 0; count < n; ) {
    cur = addDays(cur, -1);
    if (isBusinessDay(cur, opts)) count++;
  }
  return cur;
}

export type Deadline = { deadlineOn: string; mode: DeadlineMode; warnings: string[] };

export function deadline(receivedOn: string, mode: DeadlineMode, opts: CalendarOptions = {}): Deadline {
  if (mode !== 'early' && mode !== 'cycle') throw new Error(`mode は early か cycle: ${String(mode)}`);
  const start = mode === 'cycle' ? addMonths(receivedOn, CYCLE_MONTHS) : receivedOn;
  const deadlineOn = nthBusinessDay(start, BUSINESS_DAYS, opts);
  const warnings: string[] = [];
  for (let y = Number(receivedOn.slice(0, 4)); y <= Number(deadlineOn.slice(0, 4)); y++) {
    if (!hasHolidayData(y)) warnings.push(`holidays_missing:${y}`);
  }
  return { deadlineOn, mode, warnings };
}
