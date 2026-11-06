// 周期の検出（docs/mvp-plan-v3.md T302、requirements-v2.md D2・C11）。過去の明細から周期の支出を拾い、予定支出の候補にする。
// 同じ口座・同じ正規化摘要の支出（振替・カードの引き落とし・チャージと、active でない・資金繰りに入れない口座は除く）を、
// 金額の差が ±5% 以内のものでまとめ、隣り合う間隔で周期を決める。同じ日・同じ額の明細（2 回線など）は 1 件に畳む。
// 1 つのまとまりの中では最後の出現日が新しい列を採り、同じ日なら短い周期を採る。最後の出現が古い列（止まった支払い）は採らない。
// 候補（recurrence_candidates）は人が受け入れると台帳（scheduled_items、origin = detected）に入る。却下したものは同じ条件では出さない。
// 候補の amount・occurrences_json は 0006_cashflow.sql のトリガで更新できないので、金額が変わったら open の候補を dismissed にして作り直す。
import { appendAudit } from '../audit.ts';
import { excludedFromCashflow } from '../bank/transfers.ts';
import { addMonths } from '../calendar/businessDays.ts';
import { tx, type Db } from '../db/index.ts';
import {
  getRecurrenceCandidate,
  hasActiveScheduledItemLike,
  insertRecurrenceCandidate,
  listExpenseTxnsForDetect,
  listRecurrenceCandidatesFor,
  setRecurrenceCandidateState,
  type Category,
  type DetectTxnRow,
  type Interval,
  type RecurrenceCandidateRow,
  type ScheduledItemRow,
} from './repo.ts';
import { DEFAULT_NOTIFY_DAYS_BEFORE, ScheduleError, createItem, type By } from './schedule.ts';

export const DEFAULT_LOOKBACK_MONTHS = 26;
// 金額の差の許容（%）。大きい方が小さい方の 105% 以下なら同じ額とみなす。
export const AMOUNT_TOLERANCE_PCT = 5;

// 周期ごとの条件。短い順に並べる（最後の出現日が同じなら先のものを採る）。
// 最後の出現から today まで maxDays + floor(maxDays / 2) 日を超えた列は止まったとみなす。
export const RULES: readonly { interval: Interval; minDays: number; maxDays: number; minCount: number; months: number }[] = [
  { interval: 'monthly', minDays: 28, maxDays: 31, minCount: 3, months: 1 },
  { interval: 'bimonthly', minDays: 58, maxDays: 62, minCount: 3, months: 2 },
  { interval: 'quarterly', minDays: 85, maxDays: 97, minCount: 3, months: 3 },
  { interval: 'yearly', minDays: 350, maxDays: 380, minCount: 2, months: 12 },
  { interval: 'biennial', minDays: 715, maxDays: 745, minCount: 2, months: 24 },
];
type Rule = (typeof RULES)[number];

export type Occurrence = { date: string; amount: number; bank_txn_id: string };

export type Detected = { accountId: string; descriptionNorm: string; interval: Interval; amount: number; occurrences: Occurrence[] };

const dayNumber = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
const cmpDate = (a: DetectTxnRow, b: DetectTxnRow) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function sameAmount(a: number, b: number): boolean {
  return Math.max(a, b) * 100 <= Math.min(a, b) * (100 + AMOUNT_TOLERANCE_PCT);
}

// 金額でまとめる（金額の昇順に見て、まとまりの最小の 105% を超えたら次のまとまり）。
// 各まとまりは日付順で、同じ日・同じ額は 1 件に畳む。まとまりは最後の出現日が新しい順に返す。
function clusterByAmount(txns: DetectTxnRow[]): DetectTxnRow[][] {
  const sorted = [...txns].sort((a, b) => a.amount - b.amount || cmpDate(a, b));
  const out: DetectTxnRow[][] = [];
  let cur: DetectTxnRow[] = [];
  for (const t of sorted) {
    if (cur.length > 0 && !sameAmount(cur[0].amount, t.amount)) {
      out.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length > 0) out.push(cur);
  const folded = out.map((c) =>
    c.sort(cmpDate).filter((t, i, xs) => i === 0 || xs[i - 1].txn_date !== t.txn_date || xs[i - 1].amount !== t.amount),
  );
  const lastDate = (c: DetectTxnRow[]) => c[c.length - 1].txn_date;
  return folded.sort((a, b) => (lastDate(a) > lastDate(b) ? -1 : lastDate(a) < lastDate(b) ? 1 : 0));
}

// 日付順の列から、隣り合う間隔がすべて minDays〜maxDays に入る連続した部分のうち、minCount 回以上で最も新しいもの。無ければ null。
function latestRun(seq: DetectTxnRow[], rule: Rule): DetectTxnRow[] | null {
  let best: DetectTxnRow[] | null = null;
  let run: DetectTxnRow[] = [];
  for (const t of seq) {
    if (run.length > 0) {
      const gap = dayNumber(t.txn_date) - dayNumber(run[run.length - 1].txn_date);
      if (gap < rule.minDays || gap > rule.maxDays) {
        if (run.length >= rule.minCount) best = run;
        run = [];
      }
    }
    run.push(t);
  }
  if (run.length >= rule.minCount) best = run;
  return best;
}

const isStale = (lastDate: string, today: string, rule: Rule) => dayNumber(today) - dayNumber(lastDate) > rule.maxDays + Math.floor(rule.maxDays / 2);

// 明細から周期を見つける（DB には書かない）。today から lookbackMonths か月前〜today の支出を見る。
// 同じ口座・摘要の中では、最後の出現日が新しいまとまりから順に並べる。
export function findRecurrences(db: Db, opts: { today: string; lookbackMonths?: number }): Detected[] {
  const from = addMonths(opts.today, -(opts.lookbackMonths ?? DEFAULT_LOOKBACK_MONTHS));
  const excluded = excludedFromCashflow(db);
  const groups = new Map<string, DetectTxnRow[]>();
  for (const t of listExpenseTxnsForDetect(db, from, opts.today)) {
    if (excluded.has(t.id)) continue;
    const k = JSON.stringify([t.account_id, t.description_norm]);
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  const out: Detected[] = [];
  for (const txns of groups.values()) {
    for (const cluster of clusterByAmount(txns)) {
      let best: { rule: Rule; run: DetectTxnRow[] } | null = null;
      for (const rule of RULES) {
        const run = latestRun(cluster, rule);
        if (!run || isStale(run[run.length - 1].txn_date, opts.today, rule)) continue;
        // 短い順に見ているので、最後の出現日が厳密に新しいときだけ入れ替える。
        if (!best || run[run.length - 1].txn_date > best.run[best.run.length - 1].txn_date) best = { rule, run };
      }
      if (!best) continue;
      const last = best.run[best.run.length - 1];
      out.push({
        accountId: last.account_id,
        descriptionNorm: last.description_norm,
        interval: best.rule.interval,
        amount: last.amount,
        occurrences: best.run.map((t) => ({ date: t.txn_date, amount: t.amount, bank_txn_id: t.id })),
      });
    }
  }
  return out;
}

const SUPERSEDE_ACTOR = 'system';

// 検出して候補にする。daily から呼ぶ口。
// 作らないもの: 同じ口座・摘要・周期で金額が ±5% 以内の候補がある（open / accepted、または dismissed）、
// 同じ口座の active な予定項目に、同じ名前（= 正規化摘要）か、同じ周期で金額が ±5% 以内のものがある。
// 新しい候補を作ったとき、同じ口座・摘要・周期の open の候補のうち、今回の検出のどの列とも金額が合わないもの（値上げ前など）は
// dismissed にする（actor = system、payload {reason: 'superseded', by}）。updated はその件数。人が dismissed にしたものには触らない。
export function detectRecurrences(db: Db, opts: { today: string; lookbackMonths?: number; now?: Date }): { created: number; updated: number } {
  const nowDate = opts.now ?? new Date();
  const now = nowDate.toISOString();
  return tx(db, () => {
    let created = 0;
    let updated = 0;
    const found = findRecurrences(db, opts);
    const keyOf = (d: { accountId: string; descriptionNorm: string; interval: Interval }) => JSON.stringify([d.accountId, d.descriptionNorm, d.interval]);
    const foundByKey = new Map<string, Detected[]>();
    for (const d of found) foundByKey.set(keyOf(d), [...(foundByKey.get(keyOf(d)) ?? []), d]);
    for (const d of found) {
      const existing = listRecurrenceCandidatesFor(db, d.accountId, d.descriptionNorm, d.interval);
      if (existing.some((c) => sameAmount(c.amount, d.amount))) continue;
      if (hasActiveScheduledItemLike(db, { accountId: d.accountId, name: d.descriptionNorm, recurrence: d.interval, amount: d.amount, tolerancePct: AMOUNT_TOLERANCE_PCT })) {
        continue;
      }
      const row = insertRecurrenceCandidate(db, { ...d, now });
      created++;
      const siblings = foundByKey.get(keyOf(d))!;
      for (const c of existing) {
        if (c.state !== 'open' || siblings.some((x) => sameAmount(x.amount, c.amount))) continue;
        setRecurrenceCandidateState(db, c.id, 'dismissed', null, now);
        appendAudit(
          db,
          { actor: SUPERSEDE_ACTOR, action: 'recurrence_candidate.dismissed', entity: 'recurrence_candidate', entityId: c.id, payload: { reason: 'superseded', by: row.id } },
          nowDate,
        );
        updated++;
      }
    }
    return { created, updated };
  });
}

const STEP_MONTHS: Record<Interval, number> = Object.fromEntries(RULES.map((r) => [r.interval, r.months])) as Record<Interval, number>;

export function parseOccurrences(c: RecurrenceCandidateRow): Occurrence[] {
  return JSON.parse(c.occurrences_json) as Occurrence[];
}

const MONTH_END = 32; // 「月末」の印（日の最頻値を数えるとき、その月の末日は日付によらずこれにまとめる）
const lastDayOfMonth = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const dayKey = (d: string) => (Number(d.slice(8, 10)) === lastDayOfMonth(d.slice(0, 7)) ? MONTH_END : Number(d.slice(8, 10)));
const withDay = (ym: string, day: number) => `${ym}-${String(Math.min(day, lastDayOfMonth(ym))).padStart(2, '0')}`;

// 次の期日: 出現の「日」の最頻値（月末が多ければ月末。同数なら新しい出現の日）を、最後の出現の月に当てて周期を 1 回足した日。
export function nextDueFromCandidate(c: RecurrenceCandidateRow): string {
  const occ = parseOccurrences(c)
    .map((o) => o.date)
    .sort()
    .reverse();
  const counts = new Map<number, number>();
  let mode = dayKey(occ[0]);
  for (const d of occ) {
    const k = dayKey(d);
    const v = (counts.get(k) ?? 0) + 1;
    counts.set(k, v);
    if (v > (counts.get(mode) ?? 0)) mode = k;
  }
  const nextYm = addMonths(`${occ[0].slice(0, 7)}-01`, STEP_MONTHS[c.interval]).slice(0, 7);
  return withDay(nextYm, mode);
}

export type AcceptOverrides = { category?: Category; name?: string; amount?: number };

// 受け入れる: 台帳の項目を作り（createItem が値を確かめ、監査に残す）、候補を accepted にして結ぶ。open のときだけ。
export function acceptCandidate(
  db: Db,
  id: string,
  by: By,
  overrides: AcceptOverrides = {},
  now: Date = new Date(),
): { candidate: RecurrenceCandidateRow; item: ScheduledItemRow } {
  return tx(db, () => {
    const cur = getRecurrenceCandidate(db, id);
    if (!cur) throw new ScheduleError('not_found', 404);
    if (cur.state !== 'open') throw new ScheduleError('not_open');
    const item = createItem(
      db,
      {
        name: overrides.name ?? cur.description_norm,
        amount: overrides.amount ?? cur.amount,
        direction: 'out',
        category: overrides.category ?? 'other',
        accountId: cur.account_id,
        recurrence: cur.interval,
        anchorDate: nextDueFromCandidate(cur),
        endDate: null,
        notifyDaysBefore: DEFAULT_NOTIFY_DAYS_BEFORE,
        origin: 'detected',
      },
      by,
      now,
    );
    const candidate = setRecurrenceCandidateState(db, id, 'accepted', item.id, now.toISOString())!;
    appendAudit(
      db,
      { actor: by.actor, action: 'recurrence_candidate.accepted', entity: 'recurrence_candidate', entityId: id, payload: { scheduled_item_id: item.id, user: by.user ?? null } },
      now,
    );
    return { candidate, item };
  });
}

// 却下する: dismissed にする。既に dismissed ならそのまま返す（監査ログは書かない）。accepted は却下できない。
export function dismissCandidate(db: Db, id: string, by: By, now: Date = new Date()): RecurrenceCandidateRow {
  return tx(db, () => {
    const cur = getRecurrenceCandidate(db, id);
    if (!cur) throw new ScheduleError('not_found', 404);
    if (cur.state === 'dismissed') return cur;
    if (cur.state !== 'open') throw new ScheduleError('not_open');
    const row = setRecurrenceCandidateState(db, id, 'dismissed', null, now.toISOString())!;
    appendAudit(db, { actor: by.actor, action: 'recurrence_candidate.dismissed', entity: 'recurrence_candidate', entityId: id, payload: { user: by.user ?? null } }, now);
    return row;
  });
}
