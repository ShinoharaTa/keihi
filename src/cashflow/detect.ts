// 周期の検出（docs/mvp-plan-v3.md T302、requirements-v2.md D2・C11）。過去の明細から周期の支出を拾い、予定支出の候補にする。
// 同じ口座・同じ正規化摘要の支出（振替・カードの引き落とし・チャージは除く）を、金額の差が ±5% 以内のものでまとめ、
// 隣り合う間隔で周期を決める。同じ列が複数の周期に当たるときは短い周期を優先する。
// 候補（recurrence_candidates）は人が受け入れると台帳（scheduled_items、origin = detected）に入る。却下したものは同じ条件では出さない。
// 候補の amount・occurrences_json は 0006_cashflow.sql のトリガで更新できないので、既にある open の候補はそのままにする。
import { appendAudit } from '../audit.ts';
import { excludedFromCashflow } from '../bank/transfers.ts';
import { addMonths } from '../calendar/businessDays.ts';
import { tx, type Db } from '../db/index.ts';
import {
  getRecurrenceCandidate,
  hasActiveScheduledItemNamed,
  hasLiveRecurrenceCandidate,
  insertRecurrenceCandidate,
  latestRecurrenceCandidate,
  listExpenseTxnsForDetect,
  setRecurrenceCandidateState,
  type Category,
  type DetectTxnRow,
  type Interval,
  type RecurrenceCandidateRow,
  type ScheduledItemRow,
} from './repo.ts';
import { DEFAULT_NOTIFY_DAYS_BEFORE, ScheduleError, createItem, type By } from './schedule.ts';

export const DEFAULT_LOOKBACK_MONTHS = 26;
// 金額の差の許容（%）。まとめた中で最大が最小の 105% 以下。
export const AMOUNT_TOLERANCE_PCT = 5;

// 周期ごとの条件。短い順に並べる（先に当たったものを採る）。
export const RULES: readonly { interval: Interval; minDays: number; maxDays: number; minCount: number; months: number }[] = [
  { interval: 'monthly', minDays: 28, maxDays: 31, minCount: 3, months: 1 },
  { interval: 'bimonthly', minDays: 58, maxDays: 62, minCount: 3, months: 2 },
  { interval: 'yearly', minDays: 350, maxDays: 380, minCount: 2, months: 12 },
  { interval: 'biennial', minDays: 715, maxDays: 745, minCount: 2, months: 24 },
];

export type Occurrence = { date: string; amount: number; bank_txn_id: string };

export type Detected = { accountId: string; descriptionNorm: string; interval: Interval; amount: number; occurrences: Occurrence[] };

const dayNumber = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;

// 金額でまとめる（金額の昇順に見て、まとまりの最小の 105% を超えたら次のまとまり）。各まとまりは日付順。
function clusterByAmount(txns: DetectTxnRow[]): DetectTxnRow[][] {
  const sorted = [...txns].sort((a, b) => a.amount - b.amount || (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : 0));
  const out: DetectTxnRow[][] = [];
  let cur: DetectTxnRow[] = [];
  for (const t of sorted) {
    if (cur.length > 0 && t.amount * 100 > cur[0].amount * (100 + AMOUNT_TOLERANCE_PCT)) {
      out.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length > 0) out.push(cur);
  return out.map((c) => c.sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.id < b.id ? -1 : 1)));
}

// 日付順の列から、隣り合う間隔がすべて minDays〜maxDays に入る連続した部分のうち、minCount 回以上で最も新しいもの。無ければ null。
function latestRun(seq: DetectTxnRow[], rule: (typeof RULES)[number]): DetectTxnRow[] | null {
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

// 明細から周期を見つける（DB には書かない）。today から lookbackMonths か月前〜today の支出を見る。
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
      for (const rule of RULES) {
        const run = latestRun(cluster, rule);
        if (!run) continue;
        const last = run[run.length - 1];
        out.push({
          accountId: last.account_id,
          descriptionNorm: last.description_norm,
          interval: rule.interval,
          amount: last.amount,
          occurrences: run.map((t) => ({ date: t.txn_date, amount: t.amount, bank_txn_id: t.id })),
        });
        break;
      }
    }
  }
  return out;
}

// 検出して候補にする。daily から呼ぶ口。
// 作らないもの: 同じ口座・摘要・周期で open / accepted の候補がある、いちばん新しい候補が dismissed、
// 同じ口座・同じ名前（= 正規化摘要）の active な予定項目がある。
// updated は既にある open の候補を更新した数だが、候補の amount・occurrences_json は更新できない（0006 のトリガ）ので常に 0。
export function detectRecurrences(db: Db, opts: { today: string; lookbackMonths?: number; now?: Date }): { created: number; updated: number } {
  const now = (opts.now ?? new Date()).toISOString();
  return tx(db, () => {
    let created = 0;
    for (const d of findRecurrences(db, opts)) {
      if (hasLiveRecurrenceCandidate(db, d.accountId, d.descriptionNorm, d.interval)) continue;
      if (latestRecurrenceCandidate(db, d.accountId, d.descriptionNorm, d.interval)?.state === 'dismissed') continue;
      if (hasActiveScheduledItemNamed(db, d.accountId, d.descriptionNorm)) continue;
      insertRecurrenceCandidate(db, { ...d, now });
      created++;
    }
    return { created, updated: 0 };
  });
}

const STEP_MONTHS: Record<Interval, number> = Object.fromEntries(RULES.map((r) => [r.interval, r.months])) as Record<Interval, number>;

export function parseOccurrences(c: RecurrenceCandidateRow): Occurrence[] {
  return JSON.parse(c.occurrences_json) as Occurrence[];
}

// 次の期日 = 最後の出現日に周期を 1 回足した日（応当日が無い月は月末）。
export function nextDueFromCandidate(c: RecurrenceCandidateRow): string {
  const occ = parseOccurrences(c);
  const last = occ.reduce((m, o) => (o.date > m ? o.date : m), occ[0].date);
  return addMonths(last, STEP_MONTHS[c.interval]);
}

export type AcceptOverrides = { category?: Category; name?: string };

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
        amount: cur.amount,
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
