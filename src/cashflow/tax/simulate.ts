// 税の試算（docs/cashflow.md §14.5）。仮の売上・経費で 1 年分の税・社保・手取りを出す。何も保存しない。
// 定常状態: Y−3〜Y+1 に同じ行を入れて engine.ts の estimate() を呼び、Y 年の所得から決まる額を取り出す（所得税・消費税は Y 年分、
// 住民税・国保・事業税は Y+1 年度、国民年金は Y 年度）。engine.ts は変えず、台帳の見積もりと同じ計算で数字を揃える。
// 1 回の試算で estimate() を本体 1・限界 1・掛金なし 1（掛金があるときだけ）・方式の比較 9 回呼ぶ。
// parseSimBody は POST /api/tax/simulate の body の検査と既定（profile は DB の値か DEFAULT_PROFILE、売上・経費は tax_years）。
import type { Db } from '../../db/index.ts';
import { estimate, type BreakdownLine, type EstimateKind, type EstimateWarning, type EstimateYear } from './engine.ts';
import {
  BLUE_RETURN_DEDUCTION,
  CTAX_EXEMPT_THRESHOLD,
  CTAX_SIMPLIFIED_THRESHOLD,
  CTAX_SPECIAL20_LAST_YEAR,
  ratesLatestYears,
} from './rates.ts';
import { getTaxProfile, listTaxYears, type BlueReturn, type ConsumptionMode, type TaxProfileRow, type TaxProfileValues } from './repo.ts';
import { DEFAULT_PROFILE, TaxError, YEAR_MAX, YEAR_MIN, parseProfileBody } from './sync.ts';

export const SIM_MARGINAL_DELTA = 1_000_000;

export type SimSource = 'body' | 'default' | `tax_years:${number}`;
// 消費税の方式の出どころ。defaulted は profile の方式が Y 年に使えないので既定の方式に代えたもの。
export type SimModeSource = 'profile' | 'body' | 'defaulted';

// 円・整数。revenue と business_income の少なくとも一方が要る。
export type SimInput = {
  year: number;
  revenue: number | null;
  expenses: number;
  business_income: number | null;
  taxable_purchases: number; // 本則の課税仕入（税込/税抜は revenue と同じ）
  ideco: number; // 年額。profile.other_deductions に足す
  kyosai: number;
  marginal_delta: number;
  source?: { revenue: SimSource; expenses: SimSource; consumption_mode?: 'profile' | 'body' }; // 無ければ body（consumption_mode は profile）
};

export type SimAmount = { kind: EstimateKind; year: number; basis: 'year' | 'fiscal_year'; amount: number; lines: BreakdownLine[] };

export type CompareMode = Exclude<ConsumptionMode, 'unset'>;
export type CtaxUnavailable = 'revenue_missing' | 'over_10m' | 'over_50m' | 'special20_expired';
export type CtaxCompareRow = {
  mode: CompareMode;
  simplified_class: number | null;
  available: boolean;
  reason: CtaxUnavailable | null;
  tax: number | null;
  take_home: number | null;
  notes: ('exempt_requires_no_invoice' | 'standard_approx')[];
};

export type SimWarning =
  | EstimateWarning
  | { kind: 'selected_mode_unavailable'; mode: CompareMode; reason: CtaxUnavailable }
  | { kind: 'mode_defaulted'; from: CompareMode; to: 'simplified' | 'standard'; simplified_class: number | null }
  | { kind: 'rates_assumed'; year: number; latest: number; table: keyof ReturnType<typeof ratesLatestYears> }; // year はその表を引く年

export type SimResult = {
  year: number;
  inputs: {
    revenue: number | null;
    expenses: number;
    business_income: number | null;
    taxable_purchases: number;
    ideco: number;
    kyosai: number;
    other_deductions: number; // profile の値（掛金を足す前）
    revenue_includes_tax: boolean;
    blue_return: BlueReturn;
    consumption_mode: ConsumptionMode;
    simplified_class: number | null;
    source: { revenue: SimSource; expenses: SimSource; consumption_mode: SimModeSource };
  };
  income: { pre_blue: number; business_income: number };
  amounts: SimAmount[];
  total: number;
  cash_profit: number;
  take_home: number;
  free_cash: number;
  effective_rate: number | null;
  marginal: { delta: number; total_increase: number; take_home_increase: number; rate: number };
  deductions: { ideco: number; kyosai: number; saving: number };
  ctax_compare: CtaxCompareRow[];
  best: { mode: CompareMode; simplified_class: number | null } | null;
  warnings: SimWarning[];
  assumptions: ('steady_state' | 'pension_prepay24_as_prepay12')[];
};

// §14.5 の表: kind ごとに、どの年の breakdown を取るか（Y からの差）と basis。この順で出す。
const PICK: readonly { kind: EstimateKind; offset: number; basis: 'year' | 'fiscal_year' }[] = [
  { kind: 'income_tax', offset: 0, basis: 'year' },
  { kind: 'resident', offset: 1, basis: 'fiscal_year' },
  { kind: 'nhi', offset: 1, basis: 'fiscal_year' },
  { kind: 'pension', offset: 0, basis: 'fiscal_year' },
  { kind: 'biz_tax', offset: 1, basis: 'fiscal_year' },
  { kind: 'ctax', offset: 0, basis: 'year' },
];

// 比較表の行（この順）。
const COMPARE: readonly { mode: CompareMode; simplified_class: number | null }[] = [
  { mode: 'exempt', simplified_class: null },
  { mode: 'special20', simplified_class: null },
  ...[1, 2, 3, 4, 5, 6].map((c) => ({ mode: 'simplified' as const, simplified_class: c })),
  { mode: 'standard', simplified_class: null },
];

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

const exTaxOf = (profile: TaxProfileValues, x: number) => (profile.revenue_includes_tax ? Math.floor((x * 100) / 110) : x);

// 1 年分の額（定常状態）。
function annual(profile: TaxProfileValues, input: SimInput): { amounts: SimAmount[]; total: number; warnings: EstimateWarning[] } {
  const Y = input.year;
  const blue = BLUE_RETURN_DEDUCTION[profile.blue_return];
  const businessIncome = input.business_income ?? Math.max(0, input.revenue! - input.expenses - blue);
  const p = { ...profile, other_deductions: profile.other_deductions + input.ideco + input.kyosai };
  const years: EstimateYear[] = [];
  for (let y = Y - 3; y <= Y + 1; y++) {
    years.push({
      year: y, kind: 'estimate', revenue: input.revenue, expenses: input.taxable_purchases, business_income: businessIncome, social_insurance_paid: null,
      income_tax_final: null, consumption_tax_final: null, prepaid_income_tax: null, source: 'manual',
    });
  }
  const res = estimate(p, years, { from: `${Y - 1}-01-01`, to: `${Y + 2}-12-31` });
  const amounts = PICK.map(({ kind, offset, basis }) => {
    const b = res.breakdown.find((x) => x.kind === kind && x.year === Y + offset);
    return { kind, year: Y + offset, basis, amount: b?.total ?? 0, lines: b?.lines ?? [] };
  });
  return { amounts, total: amounts.reduce((s, a) => s + a.amount, 0), warnings: res.warnings };
}

// 事業の現金収支（税・社保を払う前）。
function cashProfit(profile: TaxProfileValues, input: SimInput): number {
  if (input.revenue === null) return input.business_income! + BLUE_RETURN_DEDUCTION[profile.blue_return];
  if (profile.revenue_includes_tax) return input.revenue - input.expenses;
  return input.revenue + Math.floor((input.revenue * 10) / 100) - input.expenses - Math.floor((input.taxable_purchases * 10) / 100);
}

// 方式が使えない理由（定常状態なので基準期間 = 同じ売上。判定は税抜売上の概算）。
function unavailable(profile: TaxProfileValues, input: SimInput, mode: CompareMode): CtaxUnavailable | null {
  if (input.revenue === null) return 'revenue_missing';
  const sales = exTaxOf(profile, input.revenue);
  if (mode === 'exempt') return sales > CTAX_EXEMPT_THRESHOLD ? 'over_10m' : null;
  if (mode === 'special20') return input.year > CTAX_SPECIAL20_LAST_YEAR ? 'special20_expired' : sales > CTAX_EXEMPT_THRESHOLD ? 'over_10m' : null;
  if (mode === 'simplified') return sales > CTAX_SIMPLIFIED_THRESHOLD ? 'over_50m' : null;
  return null;
}

export function simulate(profile: TaxProfileValues, input: SimInput): SimResult {
  if (input.revenue === null && input.business_income === null) throw new TaxError('income_required');
  const assumptions: SimResult['assumptions'] = ['steady_state'];
  // 2 年前納は年額と社会保険料控除が年ごとに振れるので、試算では 1 年前納で代える。
  let prof: TaxProfileValues = profile.pension_mode === 'prepay24' ? { ...profile, pension_mode: 'prepay12' } : profile;
  if (profile.pension_mode === 'prepay24') assumptions.push('pension_prepay24_as_prepay12');
  // body で方式を指定せず、profile の方式が Y 年に使えない（2 割特例の期限切れ・売上 1,000 万超）なら、
  // 区分があれば簡易課税（その区分）、無ければ本則で計算する。簡易も使えない（5,000 万超）なら本則。
  let modeSource: SimModeSource = input.source?.consumption_mode ?? 'profile';
  let defaulted: SimWarning | null = null;
  const from = profile.consumption_mode;
  if (modeSource === 'profile' && from !== 'unset' && from !== 'simplified' && from !== 'standard') {
    const reason = unavailable(profile, input, from);
    if (reason === 'special20_expired' || reason === 'over_10m') {
      const cls = profile.simplified_class;
      const to = cls !== null && unavailable(profile, input, 'simplified') === null ? 'simplified' : 'standard';
      prof = { ...prof, consumption_mode: to };
      modeSource = 'defaulted';
      defaulted = { kind: 'mode_defaulted', from, to, simplified_class: to === 'simplified' ? cls : null };
    }
  }

  const main = annual(prof, input);
  const cash = cashProfit(prof, input);
  const takeHome = cash - main.total;
  const ctax = main.amounts.find((a) => a.kind === 'ctax')!.amount;

  const d = input.marginal_delta;
  const up: SimInput = {
    ...input,
    revenue: input.revenue === null ? null : input.revenue + d,
    business_income: input.business_income === null ? null : input.business_income + d,
  };
  const upTotal = annual(prof, up).total;
  const upTakeHome = cashProfit(prof, up) - upTotal;

  const saving = input.ideco + input.kyosai > 0 ? annual(prof, { ...input, ideco: 0, kyosai: 0 }).total - main.total : 0;

  const compare: CtaxCompareRow[] = COMPARE.map(({ mode, simplified_class }) => {
    const reason = unavailable(prof, input, mode);
    const notes: CtaxCompareRow['notes'] = mode === 'exempt' ? ['exempt_requires_no_invoice'] : mode === 'standard' ? ['standard_approx'] : [];
    if (reason) return { mode, simplified_class, available: false, reason, tax: null, take_home: null, notes };
    const tax = annual({ ...prof, consumption_mode: mode, simplified_class }, input).amounts.find((a) => a.kind === 'ctax')!.amount;
    return { mode, simplified_class, available: true, reason: null, tax, take_home: takeHome + ctax - tax, notes };
  });
  // exempt は参考なので選ばない。同額なら表の順（special20 → simplified → standard）。
  let best: CtaxCompareRow | null = null;
  for (const r of compare) if (r.mode !== 'exempt' && r.available && (best === null || r.tax! < best.tax!)) best = r;

  // エンジンは期間の中の他の年の分も警告するので、year を持つものは Y の分だけ残す。
  // special20_expired は台帳向けの文なので落とす（試算では比較表の reason と selected_mode_unavailable / mode_defaulted で伝える）。
  const warnings: SimWarning[] = main.warnings.filter((w) => w.kind !== 'special20_expired' && (!('year' in w) || w.year === input.year));
  if (defaulted) warnings.push(defaulted);
  const has = (kind: string) => warnings.some((w) => w.kind === kind);
  const mode = prof.consumption_mode;
  if (mode === 'unset' && !has('consumption_tax_mode_unset')) warnings.push({ kind: 'consumption_tax_mode_unset' });
  if (mode === 'simplified' && prof.simplified_class === null && !has('simplified_class_missing')) warnings.push({ kind: 'simplified_class_missing' });
  if (mode !== 'unset' && !(mode === 'simplified' && prof.simplified_class === null)) {
    const row = compare.find((r) => r.mode === mode && (mode !== 'simplified' || r.simplified_class === prof.simplified_class))!;
    if (row.reason) warnings.push({ kind: 'selected_mode_unavailable', mode, reason: row.reason });
  }
  // 表ごとに、その表を引く年（住民税は Y+1 年度、それ以外は Y）が表の最新年より先なら 1 件。
  const latest = ratesLatestYears();
  const lookup = { income_tax_basic_deduction: input.year, resident: input.year + 1, pension: input.year };
  for (const table of ['income_tax_basic_deduction', 'resident', 'pension'] as const) {
    if (lookup[table] > latest[table]) warnings.push({ kind: 'rates_assumed', year: lookup[table], latest: latest[table], table });
  }

  const blue = BLUE_RETURN_DEDUCTION[prof.blue_return];
  const preBlue = input.business_income !== null ? input.business_income + blue : input.revenue! - input.expenses;
  return {
    year: input.year,
    inputs: {
      revenue: input.revenue,
      expenses: input.expenses,
      business_income: input.business_income,
      taxable_purchases: input.taxable_purchases,
      ideco: input.ideco,
      kyosai: input.kyosai,
      other_deductions: profile.other_deductions,
      revenue_includes_tax: profile.revenue_includes_tax === 1,
      blue_return: profile.blue_return,
      consumption_mode: prof.consumption_mode,
      simplified_class: prof.simplified_class,
      source: { revenue: input.source?.revenue ?? 'body', expenses: input.source?.expenses ?? 'body', consumption_mode: modeSource },
    },
    income: { pre_blue: preBlue, business_income: input.business_income ?? Math.max(0, preBlue - blue) },
    amounts: main.amounts,
    total: main.total,
    cash_profit: cash,
    take_home: takeHome,
    free_cash: takeHome - input.ideco - input.kyosai,
    effective_rate: cash > 0 ? round4(main.total / cash) : null,
    marginal: { delta: d, total_increase: upTotal - main.total, take_home_increase: upTakeHome - takeHome, rate: round4((upTotal - main.total) / d) },
    deductions: { ideco: input.ideco, kyosai: input.kyosai, saving },
    ctax_compare: compare,
    best: best && { mode: best.mode, simplified_class: best.simplified_class },
    warnings,
    assumptions,
  };
}

// ---- POST /api/tax/simulate の body ----

const SIM_KEYS = ['year', 'revenue', 'expenses', 'business_income', 'taxable_purchases', 'ideco', 'kyosai', 'marginal_delta', 'profile'] as const;
const isNonNegInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const valuesOf = (row: TaxProfileRow): TaxProfileValues => {
  const { id: _id, updated_at: _u, ...v } = row;
  return v;
};

// body を検査し、無いキーを既定で埋める（docs/cashflow.md §14.5）。today は JST の暦日。誤りは TaxError（400）。
export function parseSimBody(db: Db, body: unknown, today: string): { profile: TaxProfileValues; input: SimInput } {
  if (!isObject(body)) throw new TaxError('invalid_body');
  for (const k of Object.keys(body)) if (!(SIM_KEYS as readonly string[]).includes(k)) throw new TaxError('invalid_field');
  const bad = (k: string) => new TaxError(`invalid_${k}`);
  const int = (k: string, min: number, fallback: number): number => {
    if (body[k] === undefined) return fallback;
    if (!Number.isSafeInteger(body[k]) || (body[k] as number) < min) throw bad(k);
    return body[k] as number;
  };
  const intOrNull = (k: string): number | null | undefined => {
    const v = body[k];
    if (v === undefined || v === null) return v;
    if (!isNonNegInt(v)) throw bad(k);
    return v as number;
  };

  const year = int('year', YEAR_MIN, Number(today.slice(0, 4)) + 1);
  if (year > YEAR_MAX) throw bad('year');
  if (body.profile !== undefined && !isObject(body.profile)) throw bad('profile');
  const cur = getTaxProfile(db);
  const profile = parseProfileBody((body.profile ?? {}) as Record<string, unknown>, cur ? valuesOf(cur) : DEFAULT_PROFILE);

  // 売上の既定: year の行 → 無ければ year 以前で最も新しい revenue の行。経費はその行のもの（無ければ 0）。
  let revenue = intOrNull('revenue');
  const source: { revenue: SimSource; expenses: SimSource; consumption_mode: 'profile' | 'body' } = {
    revenue: 'body',
    expenses: 'body',
    consumption_mode: isObject(body.profile) && body.profile.consumption_mode !== undefined ? 'body' : 'profile',
  };
  let row: { year: number; expenses: number | null } | null = null;
  if (revenue === undefined) {
    const r = listTaxYears(db).filter((y) => y.year <= year && y.revenue !== null).at(-1) ?? null;
    revenue = r ? r.revenue : null;
    source.revenue = r ? `tax_years:${r.year}` : 'default';
    row = r;
  }
  const expenses = int('expenses', 0, row?.expenses ?? 0);
  if (body.expenses === undefined) source.expenses = row && row.expenses !== null ? `tax_years:${row.year}` : 'default';
  const businessIncome = intOrNull('business_income') ?? null;
  if (revenue === null && businessIncome === null) throw new TaxError('income_required');
  return {
    profile,
    input: {
      year,
      revenue,
      expenses,
      business_income: businessIncome,
      taxable_purchases: int('taxable_purchases', 0, expenses),
      ideco: int('ideco', 0, 0),
      kyosai: int('kyosai', 0, 0),
      marginal_delta: int('marginal_delta', 1, SIM_MARGINAL_DELTA),
      source,
    },
  };
}
