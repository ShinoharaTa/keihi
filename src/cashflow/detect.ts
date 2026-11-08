// 周期の検出（docs/mvp-plan-v3.md T302、requirements-v2.md D2・C11、docs/cashflow.md §7）。過去の明細から周期の支出を拾い、予定支出の候補にする。
// 同じ口座・同じ正規化摘要の支出（振替・カードの引き落とし・チャージと、active でない・資金繰りに入れない口座は除く）を見る。同じ日・同じ額の明細（2 回線など）は 1 件に畳む。
// 明細は「枠」（その周期の何月目か）に当てる。日の最頻値からのずれが −SHIFT_BEFORE〜+SHIFT_AFTER 日なら枠に入る（休日で前後する口座振替）。
// 枠の差がちょうど周期の月数で続くものを 1 本の列とし、2 段で判定する。
//   段 1: 金額を見ずに枠で列を作る。列の期間の明細のうち列に入った割合（純度）が PURITY_MIN 未満なら捨てる。金額の段（値上げ）が 2 つまでなら定額（額は最新）。
//   段 2: 段 1 で採った明細を除いた残りを金額 ±5% でまとめ、まとまりごとに枠で列を作る（定期購読と単発の買い物が同じ摘要に混ざる場合）。
// どちらも最後の出現日が新しい列を採り、同じ日なら短い周期を採る。止まった列（次の予定日から months × 15 + SHIFT_AFTER 日を過ぎた）は採らない。
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
  listRecurrenceCandidates,
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
// 日の最頻値からのずれの許容（日）。前営業日払い（土日 + 祝日 1）と翌営業日払い（年末年始 12/31〜1/3 + 土日）。
export const SHIFT_BEFORE = 3;
export const SHIFT_AFTER = 6;
// 段 1 の純度の下限。列の最初 −SHIFT_BEFORE 〜 最後 +SHIFT_AFTER 日にある同じ摘要の明細のうち、列に入った割合。
export const PURITY_MIN = 0.8;

// 周期ごとの条件。短い順に並べる（最後の出現日が同じなら先のものを採る）。
// minCountVariable は不定額（金額の段が 3 つ以上）の列に要る回数。null の周期は不定額を出さない。今は不定額を出さないので使わない。
export const RULES: readonly { interval: Interval; months: number; minCount: number; minCountVariable: number | null }[] = [
  { interval: 'monthly', months: 1, minCount: 3, minCountVariable: 4 },
  { interval: 'bimonthly', months: 2, minCount: 3, minCountVariable: 3 },
  { interval: 'quarterly', months: 3, minCount: 3, minCountVariable: null },
  { interval: 'yearly', months: 12, minCount: 2, minCountVariable: null },
  { interval: 'biennial', months: 24, minCount: 2, minCountVariable: null },
];
type Rule = (typeof RULES)[number];

export type Occurrence = { date: string; amount: number; bank_txn_id: string };

export type Detected = { accountId: string; descriptionNorm: string; interval: Interval; amount: number; occurrences: Occurrence[] };

const dayNumber = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
const cmpDate = (a: DetectTxnRow, b: DetectTxnRow) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function sameAmount(a: number, b: number): boolean {
  return Math.max(a, b) * 100 <= Math.min(a, b) * (100 + AMOUNT_TOLERANCE_PCT);
}

const MONTH_END = 32; // 「月末」の印（日の最頻値を数えるとき、その月の末日は日付によらずこれにまとめる）
const lastDayOfMonth = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const dayKey = (d: string) => (Number(d.slice(8, 10)) === lastDayOfMonth(d.slice(0, 7)) ? MONTH_END : Number(d.slice(8, 10)));
const withDay = (ym: string, day: number) => `${ym}-${String(Math.min(day, lastDayOfMonth(ym))).padStart(2, '0')}`;

// 日の最頻値（月末は MONTH_END にまとめる）。同数なら新しい日付の日。
function modeDay(dates: string[]): number {
  const occ = [...dates].sort().reverse();
  const counts = new Map<number, number>();
  let mode = dayKey(occ[0]);
  for (const d of occ) {
    const k = dayKey(d);
    const v = (counts.get(k) ?? 0) + 1;
    counts.set(k, v);
    if (v > (counts.get(mode) ?? 0)) mode = k;
  }
  return mode;
}

// 枠の番号 = 年 × 12 + 月（0 始まり）。
const slotOf = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const ymOfSlot = (s: number) => `${Math.floor(s / 12)}-${String((s % 12) + 1).padStart(2, '0')}`;

// 明細の日付を枠に当てる: 前月・その月・翌月のうち、日 day を当てた日からのずれが −SHIFT_BEFORE〜+SHIFT_AFTER のもの（複数なら |ずれ| が小さい方）。
// どれにも入らなければ null（枠外）。
function assignSlot(date: string, day: number): { slot: number; shift: number } | null {
  const base = slotOf(date.slice(0, 7));
  let best: { slot: number; shift: number } | null = null;
  for (const slot of [base - 1, base, base + 1]) {
    const shift = dayNumber(date) - dayNumber(withDay(ymOfSlot(slot), day));
    if (shift < -SHIFT_BEFORE || shift > SHIFT_AFTER) continue;
    if (!best || Math.abs(shift) < Math.abs(best.shift)) best = { slot, shift };
  }
  return best;
}

type SlotRun = { run: DetectTxnRow[]; lastSlot: number; day: number };

// 日付順の列を枠に当て、枠の差がちょうど rule.months で続く部分のうち、minCount 回以上で最後の枠が最も新しいもの。無ければ null。
// 同じ枠に 2 件あれば |ずれ| が小さい方を入れ、もう 1 件は枠外とみなす。
function latestSlotRun(seq: DetectTxnRow[], rule: Rule): SlotRun | null {
  if (seq.length === 0) return null;
  const day = modeDay(seq.map((t) => t.txn_date));
  const bySlot = new Map<number, { t: DetectTxnRow; slot: number; shift: number }>();
  for (const t of seq) {
    const a = assignSlot(t.txn_date, day);
    if (!a) continue;
    const cur = bySlot.get(a.slot);
    if (!cur || Math.abs(a.shift) < Math.abs(cur.shift)) bySlot.set(a.slot, { t, ...a });
  }
  const slotted = [...bySlot.values()].sort((a, b) => a.slot - b.slot);
  let best: typeof slotted | null = null;
  let run: typeof slotted = [];
  for (const s of slotted) {
    if (run.length > 0 && s.slot - run[run.length - 1].slot !== rule.months) {
      if (run.length >= rule.minCount) best = run;
      run = [];
    }
    run.push(s);
  }
  if (run.length >= rule.minCount) best = run;
  return best ? { run: best.map((s) => s.t), lastSlot: best[best.length - 1].slot, day } : null;
}

// 止まった: 次の予定日（最後の枠 + months の月に日を当てた日）から months × 15 + SHIFT_AFTER 日を today が過ぎた。
const isStale = (r: SlotRun, today: string, rule: Rule) =>
  dayNumber(today) - dayNumber(withDay(ymOfSlot(r.lastSlot + rule.months), r.day)) > rule.months * 15 + SHIFT_AFTER;

// 純度: 列の最初 −SHIFT_BEFORE 〜 最後 +SHIFT_AFTER 日にある seq の明細のうち、列に入った割合。
function purity(run: DetectTxnRow[], seq: DetectTxnRow[]): number {
  const from = dayNumber(run[0].txn_date) - SHIFT_BEFORE;
  const to = dayNumber(run[run.length - 1].txn_date) + SHIFT_AFTER;
  return run.length / seq.filter((t) => dayNumber(t.txn_date) >= from && dayNumber(t.txn_date) <= to).length;
}

// 金額の段の数: 日付順に見て、段の先頭の額と ±5% で合わなくなったら次の段。
function countLevels(run: DetectTxnRow[]): number {
  let levels = 1;
  let head = run[0].amount;
  for (const t of run) {
    if (sameAmount(head, t.amount)) continue;
    levels++;
    head = t.amount;
  }
  return levels;
}

// 周期ごとに列を作り、ok を満たすもののうち最後の出現日が最も新しい列（同じなら短い周期）。止まった列は採らない。
function bestRun(seq: DetectTxnRow[], today: string, ok: (run: DetectTxnRow[]) => boolean): { rule: Rule; run: DetectTxnRow[] } | null {
  let best: { rule: Rule; run: DetectTxnRow[] } | null = null;
  for (const rule of RULES) {
    const r = latestSlotRun(seq, rule);
    if (!r || isStale(r, today, rule) || !ok(r.run)) continue;
    // 短い順に見ているので、最後の出現日が厳密に新しいときだけ入れ替える。
    if (!best || r.run[r.run.length - 1].txn_date > best.run[best.run.length - 1].txn_date) best = { rule, run: r.run };
  }
  return best;
}

// 金額でまとめる（金額の昇順に見て、まとまりの最小の 105% を超えたら次のまとまり）。各まとまりは日付順。
// まとまりは最後の出現日が新しい順に返す。
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
  for (const c of out) c.sort(cmpDate);
  const lastDate = (c: DetectTxnRow[]) => c[c.length - 1].txn_date;
  return out.sort((a, b) => (lastDate(a) > lastDate(b) ? -1 : lastDate(a) < lastDate(b) ? 1 : 0));
}

function toDetected(rule: Rule, run: DetectTxnRow[]): Detected {
  const last = run[run.length - 1];
  return {
    accountId: last.account_id,
    descriptionNorm: last.description_norm,
    interval: rule.interval,
    amount: last.amount,
    occurrences: run.map((t) => ({ date: t.txn_date, amount: t.amount, bank_txn_id: t.id })),
  };
}

// 明細から周期を見つける（DB には書かない）。today から lookbackMonths か月前〜today の支出を見る。
// 同じ口座・摘要の中では、段 1 の列を先に、続けて段 2 の列を最後の出現日が新しいまとまりから順に並べる。
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
    // 日付順。同じ日・同じ額は 1 件に畳む。
    const seq = [...txns]
      .sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.amount - b.amount || cmpDate(a, b)))
      .filter((t, i, xs) => i === 0 || xs[i - 1].txn_date !== t.txn_date || xs[i - 1].amount !== t.amount);
    // 段 1: 金額を見ずに枠で列を作る。金額の段が 3 つ以上（不定額）の列は今は出さない。
    const first = bestRun(seq, opts.today, (run) => purity(run, seq) >= PURITY_MIN && countLevels(run) <= 2);
    let rest = seq;
    if (first) {
      out.push(toDetected(first.rule, first.run));
      const taken = new Set(first.run.map((t) => t.id));
      rest = seq.filter((t) => !taken.has(t.id));
    }
    // 段 2: 残りを金額でまとめ、まとまりごとに枠で列を作る。純度は見ない。
    for (const cluster of clusterByAmount(rest)) {
      const best = bestRun(cluster, opts.today, () => true);
      if (best) out.push(toDetected(best.rule, best.run));
    }
  }
  return out;
}

const SUPERSEDE_ACTOR = 'system';

// 検出して候補にする。daily から呼ぶ口。
// 作らないもの: 同じ口座・摘要・周期で金額が ±5% 以内の候補がある（open / accepted、または dismissed）、
// 同じ口座の active な予定項目に、同じ名前（= 正規化摘要）か、同じ周期で金額が ±5% 以内のものがある。
// 新しい候補を作ったとき、次の open の候補を dismissed にする（actor = system、payload {reason: 'superseded', by}）。updated はその件数。
//   - 同じ口座・摘要・周期で、今回の検出のどの列とも金額が合わないもの（値上げ前など）
//   - 周期によらず、occurrences の明細（bank_txn_id）が新しい候補と 1 件でも重なるもの
// 人が dismissed にしたもの・accepted のものには触らない。
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
      const ids = new Set(d.occurrences.map((o) => o.bank_txn_id));
      const superseded = new Set(existing.filter((c) => c.state === 'open' && !siblings.some((x) => sameAmount(x.amount, c.amount))).map((c) => c.id));
      for (const c of listRecurrenceCandidates(db, { state: 'open', accountId: d.accountId })) {
        if (c.id !== row.id && parseOccurrences(c).some((o) => ids.has(o.bank_txn_id))) superseded.add(c.id);
      }
      for (const id of superseded) {
        setRecurrenceCandidateState(db, id, 'dismissed', null, now);
        appendAudit(
          db,
          { actor: SUPERSEDE_ACTOR, action: 'recurrence_candidate.dismissed', entity: 'recurrence_candidate', entityId: id, payload: { reason: 'superseded', by: row.id } },
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

// 次の期日: 出現の「日」の最頻値（月末が多ければ月末。同数なら新しい出現の日）を、最後の出現の月に当てて周期を 1 回足した日。
export function nextDueFromCandidate(c: RecurrenceCandidateRow): string {
  const occ = parseOccurrences(c)
    .map((o) => o.date)
    .sort()
    .reverse();
  const nextYm = addMonths(`${occ[0].slice(0, 7)}-01`, STEP_MONTHS[c.interval]).slice(0, 7);
  return withDay(nextYm, modeDay(occ));
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
