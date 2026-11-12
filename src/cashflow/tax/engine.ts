// 税金・保険料の見積もり（docs/cashflow.md §14）。純関数: 税プロファイルと年ごとの所得から、期日と額の一覧を出す。DB には触らない。
// 対象: 所得税（確定申告 + 予定納税）・住民税（普通徴収 4 期）・国民健康保険税・個人事業税（biz_tax_rate が NULL なら作らない）・国民年金・
// 消費税（確定申告 + 中間申告 1 回。consumption_mode が exempt なら作らず、unset なら警告だけ）。法定の数値は rates.ts。
// どの年の所得で決まるか: 所得税は Y、予定納税は Y−1 の申告納税額、住民税・国保・事業税（Y 年度）は Y−1。
// 消費税は Y の売上・経費（無ければ前の年で最も新しい売上を繰り越す）、中間申告は Y−1 年分の国税分。
// 国民年金の月払いは年度ごとに 1 項目（recurrence = monthly、5 月末〜翌 4 月末に 12 回）。社会保険料控除は月ごとの内訳で数える。
// 所得 = 合計所得 = 事業所得（青色申告特別控除の後）+ 給与所得（負なら 0）。事業所得は business_income があればそれ、無ければ
// revenue − expenses − 青色控除（負なら 0）。給与所得は salary_after_deduction があればそれ、無ければ salary_income から給与所得控除の表で。
// 入力が無い年: 事業所得は直近の前の年から繰り越す（carried_from）。給与は繰り越さない（その年の行に給与があれば事業は 0 で繰り越さない）。
// Y−1 がどこにも無ければ Y の所得で代える（assumed_prev_year。住民税・国保・事業税だけ）。事業税は事業所得だけ（給与は入れない）。
// 所得税の申告納税額は 年税額 − 給与の源泉徴収税額（負なら還付。項目は作らず警告 income_tax_refund）。
// 丸め: 課税所得は 1,000 円未満、税額・保険料は 100 円未満を切り捨て。分割は 2 期目以降を「総額 ÷ 期数」の 100 円未満切り捨てにし、端数は 1 期目。
// 期日: 名目の日（月末・3/15 など）が休日なら翌営業日（祝日データの無い年は土日だけ。src/calendar/businessDays.ts）。
import { addDays, addMonths, isBusinessDay } from '../../calendar/businessDays.ts';
import {
  BIZ_TAX_DEDUCTION,
  BIZ_TAX_SINGLE_PAYMENT_MAX,
  BLUE_RETURN_DEDUCTION,
  CTAX_DEEMED_PURCHASE_PCT,
  CTAX_INTERIM_THRESHOLD,
  CTAX_SPECIAL20_LAST_YEAR,
  INCOME_TAX_BASIC_DEDUCTION,
  INCOME_TAX_BRACKETS,
  INCOME_TAX_PERSONAL_DEDUCTION,
  NHI_PRESETS,
  NHI_SEGMENTS,
  PENSION_ADDON_MONTHLY,
  PENSION_RATES,
  PREPAY_FRACTION,
  PREPAY_THRESHOLD,
  RECONSTRUCTION_RATE,
  RESIDENT_DUE_MONTHS,
  RESIDENT_PERSONAL_DEDUCTION,
  RESIDENT_RATES,
  SALARY_DEDUCTION,
  ratesFor,
  type NhiRates,
  type NhiSegment,
  type Step,
} from './rates.ts';
import type { ConsumptionMode, TaxProfileValues, TaxYearValues } from './repo.ts';

export type EstimateKind = 'income_tax' | 'resident' | 'nhi' | 'biz_tax' | 'pension' | 'ctax';

export type EstimateItem = {
  key: string; // 'income_tax:2026:final' など（scheduled_items.estimate_key）
  kind: EstimateKind;
  year: number; // 所得税は年分、それ以外は年度
  name: string;
  amount: number;
  due: string; // 休日を翌営業日に寄せた期日（monthly は最初の回。休日に寄せない）
  recurrence: 'once' | 'monthly';
  end_date: string | null; // monthly の最後の回の上限（once は null）
  category: 'tax' | 'insurance';
  group: string; // breakdown の group
};

export type BreakdownLine = { label: string; amount: number };

export type Breakdown = {
  group: string; // 'income_tax:2026' など
  kind: EstimateKind;
  year: number;
  total: number;
  lines: BreakdownLine[];
  income_year?: number; // 所得を使った年（住民税・国保・事業税は通常 year − 1）
  assumed_prev_year?: true; // 前年の所得が無く、year の所得で代えた
  carried_from?: number; // 所得をこの年から繰り越した
  method?: Exclude<ConsumptionMode, 'unset' | 'exempt'>; // 消費税の方式
};

export type EstimateWarning =
  | { kind: 'consumption_tax_mode_unset' }
  | { kind: 'simplified_class_missing' } // 簡易課税なのに事業区分が無い（消費税を作らない）
  | { kind: 'special20_expired'; year: number } // 2 割特例は 2026 年分まで（その年分の消費税を作らない）
  | { kind: 'revenue_missing'; year: number } // 消費税を作る方式なのに、その年分の売上がどの年にも無い（消費税を作らない）
  | { kind: 'income_tax_refund'; year: number; amount: number } // 所得税の還付の見込み（予定には入れない）
  | { kind: 'income_missing'; year: number };

export type EstimateWindow = { from: string; to: string }; // 両端を含む

export type EstimateYear = TaxYearValues & { year: number };

export type EstimateResult = { items: EstimateItem[]; warnings: EstimateWarning[]; breakdown: Breakdown[] };

const floorTo = (x: number, unit: number) => Math.floor(x / unit) * unit;
// 率を掛けて円未満を切り捨てる（0.0764 などの 2 進誤差で 1 円落ちないように少し足す）。
const mulFloor = (x: number, rate: number) => Math.floor(x * rate + 1e-6);
const step = (steps: readonly Step[], x: number) => steps.find((s) => x <= s.upTo)!.amount;
const pad2 = (n: number) => String(n).padStart(2, '0');

// 月末の日付（month は 1 始まり。13 以上は翌年に回す）。
function monthEnd(year: number, month: number): string {
  const first = `${year + Math.floor((month - 1) / 12)}-${pad2(((month - 1) % 12) + 1)}-01`;
  return addDays(addMonths(first, 1), -1);
}

// 休日なら翌営業日。
export function nextBusinessDay(d: string): string {
  let cur = d;
  while (!isBusinessDay(cur)) cur = addDays(cur, 1);
  return cur;
}

// total を n 期に分ける。2 期目以降は floor(total / n) の 100 円未満切り捨て、端数は 1 期目。
export function splitInstallments(total: number, n: number): number[] {
  const rest = floorTo(total / n, 100);
  return [total - rest * (n - 1), ...Array.from({ length: n - 1 }, () => rest)];
}

// 速算表で所得税（基準所得税額）。
export function baseIncomeTax(taxable: number): number {
  const b = INCOME_TAX_BRACKETS.find((x) => taxable <= x.upTo)!;
  return Math.max(0, mulFloor(taxable, b.rate) - b.minus);
}

// 給与所得（給与所得控除の後）。660 万未満は別表第五を A = 収入 ÷ 4 の千円未満切り捨て の式で概算する（rates.ts の SALARY_DEDUCTION）。
export function salaryIncomeOf(income: number, year: number): number {
  const d = ratesFor(SALARY_DEDUCTION, year);
  if (income <= d.flatUpTo) return Math.max(0, income - d.min);
  if (income < 6_600_000) {
    const a = floorTo(income / 4, 1000);
    return income < 3_600_000 ? Math.round(a * 2.8) - 80_000 : Math.round(a * 3.2) - 440_000;
  }
  if (income <= 8_500_000) return Math.floor(income * 0.9) - 1_100_000;
  return income - 1_950_000;
}

const isNonNegInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

// 国保の区分の料率（プリセットに nhi_rates_json を区分ごとに重ねる）。どちらも無いか、重ねた結果で 4 区分の
// rate・per_capita・cap が揃わなければ null（プリセットが無いときは nhi_rates_json に 4 区分すべてが要る）。
export function nhiRatesOf(p: Pick<TaxProfileValues, 'nhi_preset' | 'nhi_rates_json'>): NhiRates | null {
  const preset = p.nhi_preset !== null ? NHI_PRESETS[p.nhi_preset]?.rates ?? null : null;
  const over = p.nhi_rates_json !== null ? (JSON.parse(p.nhi_rates_json) as Partial<Record<string, Partial<NhiSegment>>> & { basic_deduction?: number }) : null;
  if (!preset && !over) return null;
  const out: Record<string, unknown> = { basic_deduction: over?.basic_deduction ?? preset?.basic_deduction ?? 430_000 };
  for (const s of NHI_SEGMENTS) {
    const seg = { per_household: null, ...(preset?.[s] ?? {}), ...(over?.[s] ?? {}) } as Partial<NhiSegment>;
    const ok =
      typeof seg.rate === 'number' && Number.isFinite(seg.rate) && seg.rate >= 0 && seg.rate < 1 &&
      isNonNegInt(seg.per_capita) && isNonNegInt(seg.cap) && (seg.per_household === null || isNonNegInt(seg.per_household));
    if (!ok) return null;
    out[s] = seg;
  }
  if (!isNonNegInt(out.basic_deduction)) return null;
  return out as NhiRates;
}

// business = 事業所得（青色控除後）、preBlue = 事業の青色控除前、salary = 給与所得（無ければ null）、total = 合計所得。
type Resolved = { business: number; preBlue: number; salary: number | null; total: number; carriedFrom?: number; incomeYear: number; assumed?: true };

type Due = { key: string; name: string; amount: number; nominal: string; due: string; recurrence?: 'monthly'; end?: string };

// 台帳に出す項目（emit）が内訳の期（dues）と違うとき（国民年金の月払い）は emit を使う。
type Group = { dues: Due[]; b: Breakdown | null; emit?: Due[] };

export function estimate(profile: TaxProfileValues, years: EstimateYear[], window: EstimateWindow): EstimateResult {
  const blue = BLUE_RETURN_DEDUCTION[profile.blue_return];
  const rows = new Map(years.map((y) => [y.year, y]));
  const sortedYears = [...rows.keys()].sort((a, b) => a - b);
  const personal = profile.spouse + profile.dependents;
  const warnings: EstimateWarning[] = [];
  // 所得が出せなかった年（期間より前の年は、期間の中の期日に効かないので数えない）。
  const missing = new Set<number>();
  const y0 = Number(window.from.slice(0, 4)) - 1;
  const y1 = Number(window.to.slice(0, 4));
  const noteMissing = (year: number) => {
    if (year >= y0) missing.add(year);
  };

  // その年の行から事業所得（青色控除後）と控除前の所得。出せなければ null。
  const incomeOfRow = (y: EstimateYear): { income: number; preBlue: number } | null => {
    if (y.business_income !== null) return { income: y.business_income, preBlue: y.business_income + blue };
    if (y.revenue !== null && y.expenses !== null) {
      const pre = y.revenue - y.expenses;
      return { income: Math.max(0, pre - blue), preBlue: pre };
    }
    return null;
  };

  // その年の行の給与所得。無ければ null。
  const salaryOfRow = (y: EstimateYear | undefined): number | null => {
    if (!y) return null;
    if (y.salary_after_deduction !== null) return y.salary_after_deduction;
    return y.salary_income !== null ? salaryIncomeOf(y.salary_income, y.year) : null;
  };
  const totalOf = (business: number, salary: number | null) => Math.max(0, business + (salary ?? 0));
  // Y の所得。事業は Y に無ければ前の年で最も新しいものを繰り越す（Y に給与があれば事業 0 で繰り越さない）。給与は繰り越さない。
  const resolve = (year: number): Resolved | null => {
    const row = rows.get(year);
    const salary = salaryOfRow(row);
    const own = row ? incomeOfRow(row) : null;
    if (own) return { business: own.income, preBlue: own.preBlue, salary, total: totalOf(own.income, salary), incomeYear: year };
    if (salary !== null) return { business: 0, preBlue: 0, salary, total: totalOf(0, salary), incomeYear: year };
    for (let i = sortedYears.length - 1; i >= 0; i--) {
      const y = sortedYears[i];
      if (y >= year) continue;
      const r = incomeOfRow(rows.get(y)!);
      if (r) return { business: r.income, preBlue: r.preBlue, salary: null, total: totalOf(r.income, null), incomeYear: y, carriedFrom: y };
    }
    return null;
  };
  // Y 年度の前年の所得。前年がどこにも無ければ Y の所得で代える。
  const resolvePrev = (year: number): Resolved | null => {
    const r = resolve(year - 1);
    if (r) return r;
    const a = resolve(year);
    if (a) return { ...a, assumed: true };
    noteMissing(year - 1);
    return null;
  };
  const actual = (year: number) => {
    const r = rows.get(year);
    return r && r.kind === 'actual' ? r : null;
  };
  const meta = (r: Resolved) => ({
    income_year: r.incomeYear,
    ...(r.assumed ? { assumed_prev_year: true as const } : {}),
    ...(r.carriedFrom !== undefined ? { carried_from: r.carriedFrom } : {}),
  });

  // 内訳の所得の行（事業所得・給与所得（あれば）・合計所得）。給与は繰り越さないので incomeYear の行のもの。
  const incomeLines = (r: Resolved): BreakdownLine[] => [
    { label: `${r.incomeYear} 年の事業所得`, amount: r.business },
    ...(r.salary !== null ? [{ label: `${r.incomeYear} 年の給与所得`, amount: r.salary }] : []),
    { label: '合計所得', amount: r.total },
  ];

  const memo = new Map<string, unknown>();
  const cached = <T>(k: string, f: () => T): T => {
    if (!memo.has(k)) memo.set(k, f());
    return memo.get(k) as T;
  };

  // ---- 国民年金（F 年度 = F 年 4 月〜F+1 年 3 月） ----
  const pension = (f: number): Group =>
    cached(`pension:${f}`, () => {
      if (profile.pension_mode === 'none') return { dues: [], b: null };
      const r = ratesFor(PENSION_RATES, f);
      const addon = profile.pension_addon ? PENSION_ADDON_MONTHLY : 0;
      const dues: Due[] = [];
      const lines: BreakdownLine[] = [];
      const push = (month: number, amount: number, label: string) => {
        const nominal = monthEnd(f, month);
        const mm = pad2(((month - 1) % 12) + 1);
        dues.push({ key: `pension:${f}:${mm}`, name: `国民年金 ${f} 年度 ${label}（見積）`, amount, nominal, due: nextBusinessDay(nominal) });
      };
      if (profile.pension_mode === 'monthly') {
        lines.push({ label: '月額', amount: r.monthly }, ...(addon ? [{ label: '付加保険料（月）', amount: addon }] : []));
        for (let m = 4; m <= 15; m++) push(m, r.monthly + addon, `${((m - 1) % 12) + 1} 月分`);
      } else if (profile.pension_mode === 'prepay6') {
        lines.push({ label: '6 か月前納', amount: r.prepay6 }, ...(addon ? [{ label: '付加保険料（6 か月）', amount: addon * 6 }] : []));
        push(4, r.prepay6 + addon * 6, '6 か月前納（4〜9 月分）');
        push(10, r.prepay6 + addon * 6, '6 か月前納（10〜3 月分）');
      } else if (profile.pension_mode === 'prepay12') {
        lines.push({ label: '1 年前納', amount: r.prepay12 }, ...(addon ? [{ label: '付加保険料（12 か月）', amount: addon * 12 }] : []));
        push(4, r.prepay12 + addon * 12, '1 年前納');
      } else if (f % 2 === 0) {
        // 2 年前納は偶数の年度の 4 月に 2 年分。
        lines.push({ label: '2 年前納', amount: r.prepay24 }, ...(addon ? [{ label: '付加保険料（24 か月）', amount: addon * 24 }] : []));
        push(4, r.prepay24 + addon * 24, '2 年前納');
      }
      const total = dues.reduce((s, d) => s + d.amount, 0);
      const b: Breakdown | null = dues.length ? { group: `pension:${f}`, kind: 'pension', year: f, total, lines: [...lines, { label: '年度の合計', amount: total }] } : null;
      if (profile.pension_mode !== 'monthly') return { dues, b };
      // 月払いは各月分を翌月末に納める: 5 月末を起点に毎月、翌 4 月末まで（月ごとの dues は社会保険料控除の計算だけに使う）。
      const anchor = monthEnd(f, 5);
      const emit: Due[] = [
        { key: `pension:${f}:monthly`, name: `国民年金 ${f} 年度 月払い（見積）`, amount: r.monthly + addon, nominal: anchor, due: anchor, recurrence: 'monthly', end: monthEnd(f, 16) },
      ];
      return { dues, b, emit };
    });

  // ---- 国民健康保険税（F 年度。F−1 年の所得） ----
  const nhi = (f: number): { dues: Due[]; b: Breakdown | null } =>
    cached(`nhi:${f}`, () => {
      const rates = nhiRatesOf(profile);
      if (!rates || profile.nhi_members < 1) return { dues: [], b: null };
      const r = resolvePrev(f);
      if (!r) return { dues: [], b: null };
      const base = Math.max(0, r.total - rates.basic_deduction);
      const lines: BreakdownLine[] = [...incomeLines(r), { label: '課税標準（所得 − 基礎控除）', amount: base }];
      const labels = { medical: '医療分', support: '後期高齢者支援金分', care: '介護分', children: '子ども・子育て支援金分' } as const;
      let total = 0;
      for (const s of NHI_SEGMENTS) {
        const seg = rates[s];
        const members = s === 'care' ? profile.nhi_members_40_64 : profile.nhi_members;
        if (members < 1) continue;
        const amount = Math.min(seg.cap, floorTo(mulFloor(base, seg.rate) + seg.per_capita * members + (seg.per_household ?? 0), 100));
        lines.push({ label: labels[s], amount });
        total += amount;
      }
      lines.push({ label: '年税額', amount: total });
      const n = profile.nhi_installments;
      const parts = splitInstallments(total, n);
      const dues = parts.map((amount, i) => {
        const nominal = monthEnd(f, profile.nhi_first_month + i);
        return { key: `nhi:${f}:p${i + 1}`, name: `国民健康保険税 ${f} 年度 第 ${i + 1} 期（見積）`, amount, nominal, due: nextBusinessDay(nominal) };
      });
      return { dues, b: { group: `nhi:${f}`, kind: 'nhi', year: f, total, lines, ...meta(r) } };
    });

  // Y 年に払った社会保険料 = 給与天引き分 + 自分で払った分。
  // 給与天引き分は Y の行の salary_social_insurance（r が Y の給与所得を足したときだけ。繰り越した年には足さない）。
  // 自分で払った分は Y の行の social_insurance_paid（actual・estimate を問わない）。無ければ年金 + 国保の見積もりで、名目の期日が Y 年のもの。
  const selfPaidSocial = (year: number): number =>
    cached(`social:${year}`, () => {
      const row = rows.get(year);
      if (row && row.social_insurance_paid !== null) return row.social_insurance_paid;
      let s = 0;
      for (const f of [year - 1, year]) {
        for (const d of [...pension(f).dues, ...nhi(f).dues]) if (d.nominal.startsWith(`${year}-`)) s += d.amount;
      }
      return s;
    });
  const social = (year: number, r: Resolved): number => {
    const withheld = r.carriedFrom === undefined && r.salary !== null && r.incomeYear === year ? rows.get(year)?.salary_social_insurance ?? 0 : 0;
    return withheld + selfPaidSocial(year);
  };

  // ---- 所得税（Y 年分の申告納税額。予定納税を引く前。負なら還付） ----
  const incomeTax = (year: number): { tax: number; lines: BreakdownLine[]; r: Resolved | null } | null =>
    cached(`it:${year}`, () => {
      // 確定値（申告書の申告納税額）は源泉徴収を引いた後なので、ここからは引かない。
      const a = actual(year);
      if (a && a.income_tax_final !== null) return { tax: a.income_tax_final, lines: [{ label: '申告納税額（確定値）', amount: a.income_tax_final }], r: null };
      const r = resolve(year);
      if (!r) {
        noteMissing(year);
        return null;
      }
      const soc = social(year, r);
      const basic = step(ratesFor(INCOME_TAX_BASIC_DEDUCTION, year), r.total);
      const pers = INCOME_TAX_PERSONAL_DEDUCTION * personal;
      const taxable = floorTo(Math.max(0, r.total - soc - profile.other_deductions - basic - pers), 1000);
      const base = baseIncomeTax(taxable);
      // 年税額は円未満切り捨て（100 円では丸めない）。源泉徴収を引いた後が 0 以上なら 100 円未満切り捨て、負なら還付（円単位）。
      const annual = base + mulFloor(base, RECONSTRUCTION_RATE);
      const withheld = rows.get(year)?.salary_withheld_tax ?? 0;
      const net = annual - withheld;
      const tax = net >= 0 ? floorTo(net, 100) : net;
      const lines: BreakdownLine[] = [
        ...incomeLines(r),
        { label: '社会保険料控除', amount: soc },
        ...(profile.other_deductions ? [{ label: 'その他の控除（iDeCo 等）', amount: profile.other_deductions }] : []),
        { label: '基礎控除', amount: basic },
        ...(pers ? [{ label: '配偶者・扶養控除', amount: pers }] : []),
        { label: '課税所得', amount: taxable },
        { label: '所得税（速算表）', amount: base },
        { label: '年税額（復興特別所得税を含む）', amount: annual },
        ...(withheld ? [{ label: '給与の源泉徴収税額', amount: withheld }] : []),
        { label: '申告納税額', amount: tax },
      ];
      return { tax, lines, r };
    });

  // Y 年分の予定納税（Y−1 年分の申告納税額が基準）。
  const prepay = (year: number): { dues: Due[]; basis: number | null } =>
    cached(`prepay:${year}`, () => {
      const prev = incomeTax(year - 1);
      // 基準額は申告納税額（還付なら 0）。
      const basis = prev ? Math.max(0, prev.tax) : null;
      if (basis === null || basis < PREPAY_THRESHOLD) return { dues: [], basis };
      const each = floorTo(basis / PREPAY_FRACTION, 100);
      const dues = ([[1, 7], [2, 11]] as const).map(([i, m]) => {
        const nominal = monthEnd(year, m);
        return { key: `income_tax:${year}:prepay${i}`, name: `所得税 ${year} 年分 予定納税 第 ${i} 期（見積）`, amount: each, nominal, due: nextBusinessDay(nominal) };
      });
      return { dues, basis };
    });

  const incomeTaxGroup = (year: number): { dues: Due[]; b: Breakdown | null; refund?: number } => {
    const it = incomeTax(year);
    const pre = prepay(year);
    const dues: Due[] = [...pre.dues];
    const lines: BreakdownLine[] = [];
    if (pre.basis !== null) lines.push({ label: `予定納税の基準額（${year - 1} 年分）`, amount: pre.basis });
    if (pre.dues.length) lines.push({ label: '予定納税（各期）', amount: pre.dues[0].amount });
    const total = it ? Math.max(0, it.tax) : pre.dues.reduce((s, d) => s + d.amount, 0);
    let refund: number | undefined;
    if (it) {
      const a = actual(year);
      const prepaid = a && a.prepaid_income_tax !== null ? a.prepaid_income_tax : pre.dues.reduce((s, d) => s + d.amount, 0);
      const final = it.tax - prepaid;
      lines.push(...it.lines, { label: '納めた予定納税', amount: prepaid }, { label: '確定申告で納める額', amount: Math.max(0, final) });
      if (final < 0) {
        // 還付は入金日が読めないので予定に入れない（警告と内訳の行だけ）。
        refund = -final;
        lines.push({ label: '還付見込み', amount: refund });
      }
      if (final > 0) {
        const nominal = `${year + 1}-03-15`;
        dues.push({ key: `income_tax:${year}:final`, name: `所得税 ${year} 年分 確定申告（見積）`, amount: final, nominal, due: nextBusinessDay(nominal) });
      }
    }
    const r = refund !== undefined ? { refund } : {};
    if (dues.length === 0) return { dues, b: null, ...r };
    return { dues, b: { group: `income_tax:${year}`, kind: 'income_tax', year, total, lines, ...(it?.r ? meta(it.r) : {}) }, ...r };
  };

  // ---- 住民税（F 年度。F−1 年の所得） ----
  const resident = (f: number): { dues: Due[]; b: Breakdown | null } => {
    const r = resolvePrev(f);
    if (!r) return { dues: [], b: null };
    const rates = ratesFor(RESIDENT_RATES, f);
    const soc = social(r.incomeYear, r);
    const pers = RESIDENT_PERSONAL_DEDUCTION * personal;
    const taxable = floorTo(Math.max(0, r.total - soc - profile.other_deductions - rates.basicDeduction - pers), 1000);
    const incomeLevy = floorTo(Math.max(0, mulFloor(taxable, rates.rate) - rates.adjustmentCredit), 100);
    const total = incomeLevy + rates.perCapita;
    const lines: BreakdownLine[] = [
      ...incomeLines(r),
      { label: '社会保険料控除', amount: soc },
      ...(profile.other_deductions ? [{ label: 'その他の控除（iDeCo 等）', amount: profile.other_deductions }] : []),
      { label: '基礎控除', amount: rates.basicDeduction },
      ...(pers ? [{ label: '配偶者・扶養控除', amount: pers }] : []),
      { label: '課税所得', amount: taxable },
      { label: '所得割（調整控除の後）', amount: incomeLevy },
      { label: '均等割', amount: rates.perCapita },
      { label: '年税額', amount: total },
    ];
    const dues = splitInstallments(total, RESIDENT_DUE_MONTHS.length).map((amount, i) => {
      const nominal = monthEnd(f, RESIDENT_DUE_MONTHS[i]);
      return { key: `resident:${f}:q${i + 1}`, name: `住民税 ${f} 年度 第 ${i + 1} 期（見積）`, amount, nominal, due: nextBusinessDay(nominal) };
    });
    return { dues, b: { group: `resident:${f}`, kind: 'resident', year: f, total, lines, ...meta(r) } };
  };

  // ---- 個人事業税（F 年度。F−1 年の事業所得 + 青色控除 − 事業主控除。給与は入れない） ----
  const bizTax = (f: number): { dues: Due[]; b: Breakdown | null } => {
    if (profile.biz_tax_rate === null) return { dues: [], b: null };
    const r = resolvePrev(f);
    if (!r) return { dues: [], b: null };
    const base = r.preBlue - BIZ_TAX_DEDUCTION;
    const lines: BreakdownLine[] = [
      { label: `${r.incomeYear} 年の事業所得（青色控除の前）`, amount: r.preBlue },
      { label: '事業主控除', amount: BIZ_TAX_DEDUCTION },
    ];
    if (base <= 0) return { dues: [], b: null };
    const total = floorTo(mulFloor(base, profile.biz_tax_rate), 100);
    if (total <= 0) return { dues: [], b: null };
    lines.push({ label: '課税標準', amount: base }, { label: '年税額', amount: total });
    const parts = total <= BIZ_TAX_SINGLE_PAYMENT_MAX ? [total] : splitInstallments(total, 2);
    const dues = parts.map((amount, i) => {
      const nominal = monthEnd(f, i === 0 ? 8 : 11);
      return { key: `biz_tax:${f}:${i + 1}`, name: `個人事業税 ${f} 年度 第 ${i + 1} 期（見積）`, amount, nominal, due: nextBusinessDay(nominal) };
    });
    return { dues, b: { group: `biz_tax:${f}`, kind: 'biz_tax', year: f, total, lines, ...meta(r) } };
  };

  // ---- 消費税（Y 年分。Y の売上・経費。中間申告は Y−1 年分の国税分） ----
  const mode = profile.consumption_mode;
  const ctaxOn = mode === 'special20' || mode === 'simplified' || mode === 'standard';
  const exTax = (x: number) => (profile.revenue_includes_tax ? Math.floor((x * 100) / 110) : x);
  // Y の売上のある行。Y に無ければ前の年で最も新しいものを繰り越す。
  const ctaxRow = (year: number): { row: EstimateYear; carriedFrom?: number } | null => {
    for (let i = sortedYears.length - 1; i >= 0; i--) {
      const y = sortedYears[i];
      if (y > year) continue;
      const row = rows.get(y)!;
      if (row.revenue !== null) return { row, ...(y !== year ? { carriedFrom: y } : {}) };
    }
    return null;
  };
  // Y 年分の年税額（国税 + 地方消費税。中間申告を引く前）。
  const ctaxAnnual = (year: number): { tax: number; lines: BreakdownLine[]; incomeYear: number; carriedFrom?: number } | null =>
    cached(`ctax:${year}`, () => {
      if (!ctaxOn) return null;
      if (mode === 'special20' && year > CTAX_SPECIAL20_LAST_YEAR) return null;
      if (mode === 'simplified' && profile.simplified_class === null) return null;
      const src = ctaxRow(year);
      if (!src) return null;
      const sales = exTax(src.row.revenue!);
      const salesTax = Math.floor((sales * 10) / 100);
      const lines: BreakdownLine[] = [{ label: `${src.row.year} 年の売上（税抜）`, amount: sales }, { label: '売上税額（10%）', amount: salesTax }];
      let tax: number;
      if (mode === 'special20') {
        tax = Math.floor((salesTax * 20) / 100);
        lines.push({ label: '控除（2 割特例: 売上税額の 80%）', amount: salesTax - tax });
      } else if (mode === 'simplified') {
        const pct = CTAX_DEEMED_PURCHASE_PCT[profile.simplified_class!];
        tax = Math.floor((salesTax * (100 - pct)) / 100);
        lines.push({ label: `控除（簡易課税 第 ${profile.simplified_class} 種: みなし仕入率 ${pct}%）`, amount: salesTax - tax });
      } else {
        // 本則（概算）: 経費を全額課税仕入とみなす。
        const purchase = exTax(src.row.expenses ?? 0);
        const credit = Math.floor((purchase * 10) / 100);
        tax = Math.max(0, salesTax - credit);
        lines.push({ label: `${src.row.year} 年の経費（税抜）`, amount: purchase }, { label: '控除（本則・概算: 税抜経費 × 10%）', amount: credit });
      }
      const total = floorTo(tax, 100);
      lines.push({ label: '年税額（国税 + 地方消費税）', amount: total });
      return { tax: total, lines, incomeYear: src.row.year, ...(src.carriedFrom !== undefined ? { carriedFrom: src.carriedFrom } : {}) };
    });
  // Y 年分の中間申告（年 1 回）。Y−1 年分の国税分が 48 万円超のとき。
  const ctaxInterim = (year: number): { due: Due; lines: BreakdownLine[] } | null => {
    if (!ctaxOn) return null;
    // 2 割特例の期限が切れた年分は確定申告と同じく作らない。
    if (mode === 'special20' && year > CTAX_SPECIAL20_LAST_YEAR) return null;
    const a = actual(year - 1);
    let national: number;
    let label: string;
    if (a && a.consumption_tax_final !== null) {
      national = a.consumption_tax_final;
      label = `中間申告の基準（${year - 1} 年分の国税分）`;
    } else {
      const prev = ctaxAnnual(year - 1);
      if (!prev) return null;
      national = Math.floor((prev.tax * 78) / 100);
      label = `中間申告の基準（${year - 1} 年分の見積もり × 78/100 を国税分とみなす）`;
    }
    if (national <= CTAX_INTERIM_THRESHOLD) return null;
    const nat = floorTo((national * 6) / 12, 100);
    const local = floorTo(Math.floor((nat * 22) / 78), 100);
    const nominal = `${year}-08-31`;
    return {
      due: { key: `ctax:${year}:interim1`, name: `消費税 ${year} 年分 中間申告（見積）`, amount: nat + local, nominal, due: nextBusinessDay(nominal) },
      lines: [
        { label, amount: national },
        { label: '中間申告 国税分（6/12）', amount: nat },
        { label: '中間申告 地方消費税（国税分 × 22/78）', amount: local },
        { label: '中間申告', amount: nat + local },
      ],
    };
  };
  const ctaxGroup = (year: number): Group => {
    const an = ctaxAnnual(year);
    const it = ctaxInterim(year);
    if (!an && !it) return { dues: [], b: null };
    const dues: Due[] = it ? [it.due] : [];
    const lines: BreakdownLine[] = it ? [...it.lines] : [];
    if (an) {
      const paid = it ? it.due.amount : 0;
      const final = an.tax - paid;
      lines.push(...an.lines, { label: '中間申告で納めた額', amount: paid }, { label: '確定申告で納める額', amount: Math.max(0, final) });
      if (final > 0) {
        const nominal = `${year + 1}-03-31`;
        dues.push({ key: `ctax:${year}:final`, name: `消費税 ${year} 年分 確定申告（見積）`, amount: final, nominal, due: nextBusinessDay(nominal) });
      }
    }
    const b: Breakdown = {
      group: `ctax:${year}`,
      kind: 'ctax',
      year,
      total: an ? an.tax : it!.due.amount,
      lines,
      method: mode as Exclude<ConsumptionMode, 'unset' | 'exempt'>,
      ...(an ? { income_year: an.incomeYear, ...(an.carriedFrom !== undefined ? { carried_from: an.carriedFrom } : {}) } : {}),
    };
    return { dues, b };
  };

  const items: EstimateItem[] = [];
  const breakdown: Breakdown[] = [];
  const add = (kind: EstimateKind, year: number, g: Group) => {
    // 0 円以下の期（上限 0 の上書きなど）は作らない。monthly は最初の回〜end_date が期間に掛かれば出す。
    const inWindow = (g.emit ?? g.dues).filter((d) => d.amount > 0 && (d.end ?? d.due) >= window.from && d.due <= window.to);
    if (!inWindow.length || !g.b) return;
    const category = kind === 'nhi' || kind === 'pension' ? 'insurance' : 'tax';
    for (const d of inWindow) {
      items.push({ key: d.key, kind, year, name: d.name, amount: d.amount, due: d.due, recurrence: d.recurrence ?? 'once', end_date: d.end ?? null, category, group: g.b.group });
    }
    breakdown.push(g.b);
  };
  const special20Expired: number[] = [];
  const revenueMissing: number[] = [];
  const refunds: { year: number; amount: number }[] = [];
  for (let y = y0; y <= y1; y++) {
    const itg = incomeTaxGroup(y);
    add('income_tax', y, itg);
    // 還付は、その年分の確定申告の期日が期間に入る年だけ数える。
    const itDue = nextBusinessDay(`${y + 1}-03-15`);
    if (itg.refund !== undefined && itDue >= window.from && itDue <= window.to) refunds.push({ year: y, amount: itg.refund });
    add('resident', y, resident(y));
    add('nhi', y, nhi(y));
    add('biz_tax', y, bizTax(y));
    add('pension', y, pension(y));
    add('ctax', y, ctaxGroup(y));
    // 2 割特例の期限切れは、その年分の確定申告の期日が期間に入る年だけ数える。
    const finalDue = nextBusinessDay(`${y + 1}-03-31`);
    if (mode === 'special20' && y > CTAX_SPECIAL20_LAST_YEAR && finalDue >= window.from && finalDue <= window.to) special20Expired.push(y);
    // 売上がどの年にも無い（所得だけ入れた年）なら作らず警告する。方式の設定で作らない年は数えない。
    const ctaxBlocked = (mode === 'special20' && y > CTAX_SPECIAL20_LAST_YEAR) || (mode === 'simplified' && profile.simplified_class === null);
    if (ctaxOn && !ctaxBlocked && !ctaxRow(y) && finalDue >= window.from && finalDue <= window.to) revenueMissing.push(y);
  }
  items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.key < b.key ? -1 : 1));

  if (mode === 'unset') warnings.push({ kind: 'consumption_tax_mode_unset' });
  if (mode === 'simplified' && profile.simplified_class === null) warnings.push({ kind: 'simplified_class_missing' });
  for (const year of special20Expired) warnings.push({ kind: 'special20_expired', year });
  for (const year of revenueMissing) warnings.push({ kind: 'revenue_missing', year });
  for (const x of refunds) warnings.push({ kind: 'income_tax_refund', ...x });
  for (const year of [...missing].sort((a, b) => a - b)) warnings.push({ kind: 'income_missing', year });
  return { items, warnings, breakdown };
}
