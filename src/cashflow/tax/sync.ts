// 税金・保険料の見積もりの入力の保存と、予定台帳への同期（docs/cashflow.md §14.2）。
// 再計算: engine.ts の結果を scheduled_items（origin = estimate、recurrence = once）に estimate_key で突き合わせる。
//   key が無い → 作る / 同じ → 何もしない / 違う・pinned = 0 → その行を書き換える（id は変えない）/ pinned = 1 → 触らない（skipped_pinned）。
//   今回出なくなった key（期日が対象の期間にあるもの）: pinned = 0 → 止める / pinned = 1 → 触らず警告。
//   同じ category で ±45 日・±10% の manual / detected の有効な項目があれば possible_duplicate を出す（消さない）。
// 対象の期間: 今年の 1/1 〜 今日 + 39 か月（36 か月 + 3 か月）。過去の期日も作る（forecast が履歴から予定分を引く）。
// 台帳への書き込みは actor = system（監査の payload に run_id と reason）。1 回の再計算を tax_estimate_runs に 1 行残す。
// tax_profile・tax_years の更新は同じトランザクションで再計算する。監査は tax_profile.updated / tax_year.updated（変わった列の前後）。
import { appendAudit } from '../../audit.ts';
import { addDays, addMonths } from '../../calendar/businessDays.ts';
import { tx, type Db } from '../../db/index.ts';
import { ulid } from '../../db/ids.ts';
import { listScheduledItems, type ScheduledItemRow } from '../repo.ts';
import { SYSTEM_ACTOR, createItem, deactivateItem, nextDueDates, updateItem, type By } from '../schedule.ts';
import { estimate, nhiRatesOf, type Breakdown, type EstimateItem, type EstimateWarning, type EstimateWindow } from './engine.ts';
import { NHI_PRESETS, NHI_SEGMENTS } from './rates.ts';
import {
  BLUE_RETURNS,
  CONSUMPTION_MODES,
  PENSION_MODES,
  PROFILE_COLUMNS,
  RESIDENT_PAY_MODES,
  YEAR_KINDS,
  getTaxProfile,
  getTaxYear,
  insertTaxEstimateRun,
  latestItemsByEstimateKey,
  latestTaxEstimateRun,
  listTaxYears,
  upsertTaxProfile,
  upsertTaxYear,
  type TaxProfileRow,
  type TaxProfileValues,
  type TaxYearRow,
  type TaxYearValues,
} from './repo.ts';

export const WINDOW_MONTHS = 39;
export const ESTIMATE_NOTIFY_DAYS_BEFORE = 30;
export const DUPLICATE_DAYS = 45;
export const DUPLICATE_TOLERANCE_PCT = 10;
export const YEAR_MIN = 2000;
export const YEAR_MAX = 2100;

// PR1 の既定（docs/cashflow.md §14.1）。プロファイルが無いときの PUT はこれに body を重ねる。
export const DEFAULT_PROFILE: TaxProfileValues = {
  blue_return: '65',
  consumption_mode: 'unset',
  simplified_class: null,
  revenue_includes_tax: 1,
  biz_tax_rate: null,
  resident_pay_mode: 'ordinary4',
  nhi_preset: 'saitama-city-2026',
  nhi_members: 1,
  nhi_members_40_64: 0,
  nhi_installments: 8,
  nhi_first_month: 7,
  nhi_rates_json: null,
  pension_mode: 'monthly',
  pension_addon: 0,
  dependents: 0,
  spouse: 0,
  other_deductions: 0,
  payment_account_id: null,
};

export class TaxError extends Error {
  readonly code: string;
  readonly status: 400 | 404;
  constructor(code: string, status: 400 | 404 = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export type SkippedPinned = { key: string; item_id: string; computed: { amount: number; due: string }; current: { amount: number; due: string; active: 0 | 1 } };

export type SyncWarning =
  | EstimateWarning
  | { kind: 'tax_profile_missing' }
  | { kind: 'pinned_withdrawn'; key: string; item_id: string }
  | { kind: 'possible_duplicate'; key: string; item_ids: [string, string] };

export type RunSummary = { run_id: string; created: number; updated: number; deactivated: number; skipped_pinned: SkippedPinned[]; warnings: SyncWarning[] };

export function estimateWindow(today: string): EstimateWindow {
  return { from: `${today.slice(0, 4)}-01-01`, to: addMonths(today, WINDOW_MONTHS) };
}

// ±10%: 大きい方が小さい方の 110% 以下。
const near = (a: number, b: number) => Math.max(a, b) * 100 <= Math.min(a, b) * (100 + DUPLICATE_TOLERANCE_PCT);

function duplicates(others: ScheduledItemRow[], it: EstimateItem, id: string): SyncWarning[] {
  const from = addDays(it.due, -DUPLICATE_DAYS);
  const to = addDays(it.due, DUPLICATE_DAYS);
  return others
    .filter((o) => o.category === it.category && near(o.amount, it.amount) && nextDueDates(o, from, to).length > 0)
    .map((o) => ({ kind: 'possible_duplicate' as const, key: it.key, item_ids: [id, o.id] as [string, string] }));
}

// 再計算して台帳に同期する。呼ぶ側のトランザクションの中でも呼べる。
export function recalculate(db: Db, opts: { today: string; now: Date; actor: string; user?: string | null }): RunSummary {
  return tx(db, () => {
    const profile = getTaxProfile(db);
    const years = listTaxYears(db);
    const window = estimateWindow(opts.today);
    const res = profile
      ? estimate(profile, years, window)
      : { items: [] as EstimateItem[], warnings: [] as EstimateWarning[], breakdown: [] as Breakdown[] };
    const warnings: SyncWarning[] = profile ? [...res.warnings] : [{ kind: 'tax_profile_missing' }];
    const runId = ulid(opts.now.getTime());
    const system = (payload: Record<string, unknown>): By => ({ actor: SYSTEM_ACTOR, payload: { ...payload, run_id: runId } });
    const latest = latestItemsByEstimateKey(db);
    const others = listScheduledItems(db).filter((o) => o.origin === 'manual' || o.origin === 'detected');
    const skipped: SkippedPinned[] = [];
    let created = 0;
    let updated = 0;
    let deactivated = 0;

    for (const it of res.items) {
      const cur = latest.get(it.key);
      let id: string;
      if (cur && cur.pinned === 1) {
        skipped.push({ key: it.key, item_id: cur.id, computed: { amount: it.amount, due: it.due }, current: { amount: cur.amount, due: cur.anchor_date, active: cur.active } });
        if (cur.active === 0) continue;
        id = cur.id;
      } else if (!cur || cur.active === 0) {
        id = createItem(
          db,
          {
            name: it.name, amount: it.amount, direction: 'out', category: it.category, accountId: profile!.payment_account_id, recurrence: 'once',
            anchorDate: it.due, endDate: null, notifyDaysBefore: ESTIMATE_NOTIFY_DAYS_BEFORE, origin: 'estimate', estimateKey: it.key,
          },
          system({}),
          opts.now,
        ).id;
        created++;
      } else {
        id = cur.id;
        if (cur.amount !== it.amount || cur.anchor_date !== it.due) {
          updateItem(db, cur.id, { amount: it.amount, anchorDate: it.due }, system({ reason: 'tax_recalc' }), opts.now);
          updated++;
        }
      }
      warnings.push(...duplicates(others, it, id));
    }

    const keys = new Set(res.items.map((i) => i.key));
    for (const [key, row] of latest) {
      if (row.active === 0 || keys.has(key) || row.anchor_date < window.from || row.anchor_date > window.to) continue;
      if (row.pinned === 1) {
        warnings.push({ kind: 'pinned_withdrawn', key, item_id: row.id });
        continue;
      }
      deactivateItem(db, row.id, system({ reason: 'estimate_withdrawn' }), opts.now);
      deactivated++;
    }

    insertTaxEstimateRun(db, {
      id: runId,
      actor: opts.actor,
      inputs: { profile, years },
      results: { window, items: res.items, breakdown: res.breakdown, skipped_pinned: skipped },
      created,
      updated,
      deactivated,
      skippedPinned: skipped.length,
      warnings,
      now: opts.now.toISOString(),
    });
    return { run_id: runId, created, updated, deactivated, skipped_pinned: skipped, warnings };
  });
}

// ---- 入力の検査と保存 ----

// API で真偽値として受け渡す列。
const BOOL_COLUMNS = new Set<string>(['revenue_includes_tax', 'pension_addon', 'spouse']);
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isEnum = (xs: readonly string[], v: unknown) => typeof v === 'string' && xs.includes(v);

function checkNhiRates(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new TaxError('invalid_nhi_rates_json');
  const o = v as Record<string, unknown>;
  for (const [k, seg] of Object.entries(o)) {
    if (k === 'basic_deduction') {
      if (!isInt(seg, 0)) throw new TaxError('invalid_nhi_rates_json');
      continue;
    }
    if (!(NHI_SEGMENTS as readonly string[]).includes(k) || typeof seg !== 'object' || seg === null || Array.isArray(seg)) throw new TaxError('invalid_nhi_rates_json');
    for (const [f, x] of Object.entries(seg as Record<string, unknown>)) {
      const ok =
        f === 'rate' ? typeof x === 'number' && x >= 0 && x < 1
        : f === 'per_capita' || f === 'cap' ? isInt(x, 0)
        : f === 'per_household' ? x === null || isInt(x, 0)
        : false;
      if (!ok) throw new TaxError('invalid_nhi_rates_json');
    }
  }
  return JSON.stringify(o);
}

// PUT /api/tax/profile の body を base に重ねて検査する。知らないキーは 400。
export function parseProfileBody(body: Record<string, unknown>, base: TaxProfileValues): TaxProfileValues {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(body)) {
    if (!(PROFILE_COLUMNS as readonly string[]).includes(k)) throw new TaxError('invalid_field');
    const bad = () => new TaxError(`invalid_${k}`);
    if (BOOL_COLUMNS.has(k)) {
      if (typeof v !== 'boolean') throw bad();
      out[k] = v ? 1 : 0;
      continue;
    }
    const ok = (() => {
      switch (k) {
        case 'blue_return':
          return isEnum(BLUE_RETURNS, v);
        case 'consumption_mode':
          return isEnum(CONSUMPTION_MODES, v);
        case 'simplified_class':
          return v === null || isInt(v, 1, 6);
        case 'biz_tax_rate':
          return v === null || (typeof v === 'number' && v > 0 && v < 1);
        case 'resident_pay_mode':
          return isEnum(RESIDENT_PAY_MODES, v);
        case 'nhi_preset':
          return v === null || (typeof v === 'string' && Object.hasOwn(NHI_PRESETS, v));
        case 'nhi_members':
        case 'nhi_members_40_64':
        case 'dependents':
          return isInt(v, 0, 20);
        case 'nhi_installments':
        case 'nhi_first_month':
          return isInt(v, 1, 12);
        case 'pension_mode':
          return isEnum(PENSION_MODES, v);
        case 'other_deductions':
          return isInt(v, 0);
        case 'payment_account_id':
          return v === null || (typeof v === 'string' && v !== '');
        case 'nhi_rates_json':
          return true; // 下で確かめる
      }
      return false;
    })();
    if (!ok) throw bad();
    out[k] = k === 'nhi_rates_json' ? checkNhiRates(v) : v;
  }
  const p = out as TaxProfileValues;
  if (p.nhi_members_40_64 > p.nhi_members) throw new TaxError('invalid_nhi_members_40_64');
  if (p.nhi_preset === null && p.nhi_rates_json !== null && nhiRatesOf(p) === null) throw new TaxError('invalid_nhi_rates_json');
  return p;
}

const YEAR_BODY_KEYS = ['kind', 'revenue', 'expenses', 'business_income', 'social_insurance_paid', 'income_tax_final', 'consumption_tax_final', 'prepaid_income_tax'] as const;

// PUT /api/tax/years/:year の body を base（無ければ kind 必須）に重ねて検査する。source は manual（annualized は PR2）。
export function parseYearBody(body: Record<string, unknown>, base: TaxYearValues | null): TaxYearValues {
  const out: Record<string, unknown> = base
    ? { ...base }
    : { revenue: null, expenses: null, business_income: null, social_insurance_paid: null, income_tax_final: null, consumption_tax_final: null, prepaid_income_tax: null };
  for (const [k, v] of Object.entries(body)) {
    if (!(YEAR_BODY_KEYS as readonly string[]).includes(k)) throw new TaxError('invalid_field');
    const ok = k === 'kind' ? isEnum(YEAR_KINDS, v) : k === 'business_income' ? v === null || Number.isSafeInteger(v) : v === null || isInt(v, 0);
    if (!ok) throw new TaxError(`invalid_${k}`);
    out[k] = v;
  }
  if (out.kind === undefined) throw new TaxError('missing_kind');
  out.source = 'manual';
  return out as TaxYearValues;
}

export function parseYear(s: string): number {
  if (!/^\d{4}$/.test(s)) throw new TaxError('invalid_year');
  const y = Number(s);
  if (y < YEAR_MIN || y > YEAR_MAX) throw new TaxError('invalid_year');
  return y;
}

function diff<T extends Record<string, unknown>>(before: T | null, after: T, cols: readonly string[]): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const c of cols) {
    const from = before ? before[c] : null;
    if (from !== after[c]) changes[c] = { from, to: after[c] };
  }
  return changes;
}

type SaveOpts = { by: { actor: string; user?: string | null }; today: string; now: Date };

// プロファイルを保存して再計算する（同じトランザクション）。
export function saveProfile(db: Db, body: Record<string, unknown>, o: SaveOpts): { profile: TaxProfileRow; run: RunSummary } {
  return tx(db, () => {
    const cur = getTaxProfile(db);
    const v = parseProfileBody(body, cur ?? DEFAULT_PROFILE);
    if (v.payment_account_id !== null && !db.prepare('SELECT 1 FROM money_accounts WHERE id = ?').get(v.payment_account_id)) throw new TaxError('unknown_account');
    const changes = diff(cur, v, PROFILE_COLUMNS);
    const profile = cur && Object.keys(changes).length === 0 ? cur : upsertTaxProfile(db, v, o.now.toISOString());
    if (Object.keys(changes).length > 0) {
      appendAudit(db, { actor: o.by.actor, action: 'tax_profile.updated', entity: 'tax_profile', entityId: 'default', payload: { changes, user: o.by.user ?? null } }, o.now);
    }
    return { profile, run: recalculate(db, { today: o.today, now: o.now, actor: o.by.actor, user: o.by.user }) };
  });
}

const YEAR_COLS = [...YEAR_BODY_KEYS, 'source'] as const;

// 1 年分を保存して再計算する（同じトランザクション）。
export function saveYear(db: Db, year: number, body: Record<string, unknown>, o: SaveOpts): { year: TaxYearRow; run: RunSummary } {
  return tx(db, () => {
    const cur = getTaxYear(db, year);
    const v = parseYearBody(body, cur);
    const changes = diff(cur, v, YEAR_COLS);
    const row = cur && Object.keys(changes).length === 0 ? cur : upsertTaxYear(db, year, v, o.now.toISOString());
    if (Object.keys(changes).length > 0) {
      appendAudit(db, { actor: o.by.actor, action: 'tax_year.updated', entity: 'tax_year', entityId: String(year), payload: { year, changes, user: o.by.user ?? null } }, o.now);
    }
    return { year: row, run: recalculate(db, { today: o.today, now: o.now, actor: o.by.actor, user: o.by.user }) };
  });
}

// ---- 読み出し ----

// API に出すプロファイル（真偽値の列は boolean、nhi_rates_json はオブジェクト）。
export function profileView(p: TaxProfileRow) {
  return {
    ...p,
    revenue_includes_tax: p.revenue_includes_tax === 1,
    pension_addon: p.pension_addon === 1,
    spouse: p.spouse === 1,
    nhi_rates_json: p.nhi_rates_json === null ? null : (JSON.parse(p.nhi_rates_json) as unknown),
  };
}

// 計算に足りない入力（GET /api/tax/profile の missing）。
export function missingInputs(db: Db, today: string): string[] {
  const p = getTaxProfile(db);
  if (!p) return ['profile'];
  const y = Number(today.slice(0, 4));
  const out: string[] = [];
  if (getTaxYear(db, y - 1)?.kind !== 'actual') out.push(`actual:${y - 1}`);
  if (!getTaxYear(db, y)) out.push(`estimate:${y}`);
  if (p.consumption_mode === 'unset') out.push('consumption_mode');
  return out;
}

export function presets(): { id: string; label: string }[] {
  return Object.entries(NHI_PRESETS).map(([id, x]) => ({ id, label: x.label }));
}

// 最新の再計算の結果（項目ごとに内訳の行を付ける）。まだ無ければ null。
export function latestEstimates(db: Db) {
  const run = latestTaxEstimateRun(db);
  if (!run) return null;
  const r = JSON.parse(run.results_json) as { window: EstimateWindow; items: EstimateItem[]; breakdown: Breakdown[]; skipped_pinned: SkippedPinned[] };
  const groups = new Map(r.breakdown.map((b) => [b.group, b]));
  return {
    run_id: run.id,
    created_at: run.created_at,
    window: r.window,
    items: r.items.map((i) => {
      const b = groups.get(i.group);
      return { ...i, lines: b?.lines ?? [], income_year: b?.income_year ?? null, assumed_prev_year: b?.assumed_prev_year ?? false, carried_from: b?.carried_from ?? null };
    }),
    breakdown: r.breakdown,
    skipped_pinned: r.skipped_pinned,
    warnings: JSON.parse(run.warnings_json) as SyncWarning[],
  };
}

// GET /api/cashflow の warnings に足すもの。
export function cashflowTaxWarnings(db: Db): ({ kind: 'tax_profile_missing' } | { kind: 'consumption_tax_mode_unset' })[] {
  const p = getTaxProfile(db);
  if (!p) return [{ kind: 'tax_profile_missing' }];
  return p.consumption_mode === 'unset' ? [{ kind: 'consumption_tax_mode_unset' }] : [];
}
