// 税金・保険料の見積もり（docs/cashflow.md §14）。純関数: 税プロファイルと年ごとの所得から、期日と額の一覧を出す。DB には触らない。
// 対象: 所得税（確定申告 + 予定納税）・住民税（普通徴収 4 期）・国民健康保険税・個人事業税（biz_tax_rate が NULL なら作らない）・国民年金。
// 消費税は作らない（PR2。consumption_mode = 'unset' なら警告だけ出す）。法定の数値は rates.ts。
// どの年の所得で決まるか: 所得税は Y、予定納税は Y−1 の申告納税額、住民税・国保・事業税（Y 年度）は Y−1。
// 所得 = 事業所得（青色申告特別控除の後）。business_income があればそれ、無ければ revenue − expenses − 青色控除（負なら 0）。
// 入力が無い年: 直近の前の年の所得を繰り越す（carried_from）。Y−1 がどこにも無ければ Y の所得で代える（assumed_prev_year。住民税・国保・事業税だけ）。
// 丸め: 課税所得は 1,000 円未満、税額・保険料は 100 円未満を切り捨て。分割は 2 期目以降を「総額 ÷ 期数」の 100 円未満切り捨てにし、端数は 1 期目。
// 期日: 名目の日（月末・3/15 など）が休日なら翌営業日（祝日データの無い年は土日だけ。src/calendar/businessDays.ts）。
import { addDays, addMonths, isBusinessDay } from '../../calendar/businessDays.ts';
import {
  BIZ_TAX_DEDUCTION,
  BIZ_TAX_SINGLE_PAYMENT_MAX,
  BLUE_RETURN_DEDUCTION,
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
  ratesFor,
  type NhiRates,
  type NhiSegment,
  type Step,
} from './rates.ts';
import type { TaxProfileValues, TaxYearValues } from './repo.ts';

export type EstimateKind = 'income_tax' | 'resident' | 'nhi' | 'biz_tax' | 'pension';

export type EstimateItem = {
  key: string; // 'income_tax:2026:final' など（scheduled_items.estimate_key）
  kind: EstimateKind;
  year: number; // 所得税は年分、それ以外は年度
  name: string;
  amount: number;
  due: string; // 休日を翌営業日に寄せた期日
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
};

export type EstimateWarning =
  | { kind: 'consumption_tax_mode_unset' }
  | { kind: 'consumption_tax_not_implemented'; mode: string } // 方式は設定済みだが PR1 は消費税を作らない
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

type Resolved = { income: number; preBlue: number; carriedFrom?: number; incomeYear: number; assumed?: true };

type Due = { key: string; name: string; amount: number; nominal: string; due: string };

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

  // その年の行から所得（青色控除後）と控除前の所得。出せなければ null。
  const incomeOfRow = (y: EstimateYear): { income: number; preBlue: number } | null => {
    if (y.business_income !== null) return { income: y.business_income, preBlue: y.business_income + blue };
    if (y.revenue !== null && y.expenses !== null) {
      const pre = y.revenue - y.expenses;
      return { income: Math.max(0, pre - blue), preBlue: pre };
    }
    return null;
  };

  // Y の所得。Y に無ければ前の年で最も新しいものを繰り越す。
  const resolve = (year: number): Resolved | null => {
    for (let i = sortedYears.length - 1; i >= 0; i--) {
      const y = sortedYears[i];
      if (y > year) continue;
      const r = incomeOfRow(rows.get(y)!);
      if (r) return { ...r, incomeYear: y, ...(y !== year ? { carriedFrom: y } : {}) };
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

  const memo = new Map<string, unknown>();
  const cached = <T>(k: string, f: () => T): T => {
    if (!memo.has(k)) memo.set(k, f());
    return memo.get(k) as T;
  };

  // ---- 国民年金（F 年度 = F 年 4 月〜F+1 年 3 月） ----
  const pension = (f: number): { dues: Due[]; b: Breakdown | null } =>
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
      return { dues, b: dues.length ? { group: `pension:${f}`, kind: 'pension', year: f, total, lines: [...lines, { label: '年度の合計', amount: total }] } : null };
    });

  // ---- 国民健康保険税（F 年度。F−1 年の所得） ----
  const nhi = (f: number): { dues: Due[]; b: Breakdown | null } =>
    cached(`nhi:${f}`, () => {
      const rates = nhiRatesOf(profile);
      if (!rates || profile.nhi_members < 1) return { dues: [], b: null };
      const r = resolvePrev(f);
      if (!r) return { dues: [], b: null };
      const base = Math.max(0, r.income - rates.basic_deduction);
      const lines: BreakdownLine[] = [{ label: `${r.incomeYear} 年の所得`, amount: r.income }, { label: '課税標準（所得 − 基礎控除）', amount: base }];
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

  // Y 年に払った社会保険料（確定値があればそれ。無ければ年金 + 国保の見積もりで、名目の期日が Y 年のもの）。
  const social = (year: number): number =>
    cached(`social:${year}`, () => {
      const a = actual(year);
      if (a && a.social_insurance_paid !== null) return a.social_insurance_paid;
      let s = 0;
      for (const f of [year - 1, year]) {
        for (const d of [...pension(f).dues, ...nhi(f).dues]) if (d.nominal.startsWith(`${year}-`)) s += d.amount;
      }
      return s;
    });

  // ---- 所得税（Y 年分の申告納税額。予定納税を引く前） ----
  const incomeTax = (year: number): { tax: number; lines: BreakdownLine[]; r: Resolved | null } | null =>
    cached(`it:${year}`, () => {
      const a = actual(year);
      if (a && a.income_tax_final !== null) return { tax: a.income_tax_final, lines: [{ label: '申告納税額（確定値）', amount: a.income_tax_final }], r: null };
      const r = resolve(year);
      if (!r) {
        noteMissing(year);
        return null;
      }
      const soc = social(year);
      const basic = step(ratesFor(INCOME_TAX_BASIC_DEDUCTION, year), r.income);
      const pers = INCOME_TAX_PERSONAL_DEDUCTION * personal;
      const taxable = floorTo(Math.max(0, r.income - soc - profile.other_deductions - basic - pers), 1000);
      const base = baseIncomeTax(taxable);
      const tax = floorTo(base + mulFloor(base, RECONSTRUCTION_RATE), 100);
      const lines: BreakdownLine[] = [
        { label: `${r.incomeYear} 年の所得`, amount: r.income },
        { label: '社会保険料控除', amount: soc },
        ...(profile.other_deductions ? [{ label: 'その他の控除（iDeCo 等）', amount: profile.other_deductions }] : []),
        { label: '基礎控除', amount: basic },
        ...(pers ? [{ label: '配偶者・扶養控除', amount: pers }] : []),
        { label: '課税所得', amount: taxable },
        { label: '所得税（速算表）', amount: base },
        { label: '申告納税額（復興特別所得税を含む）', amount: tax },
      ];
      return { tax, lines, r };
    });

  // Y 年分の予定納税（Y−1 年分の申告納税額が基準）。
  const prepay = (year: number): { dues: Due[]; basis: number | null } =>
    cached(`prepay:${year}`, () => {
      const prev = incomeTax(year - 1);
      if (!prev || prev.tax < PREPAY_THRESHOLD) return { dues: [], basis: prev?.tax ?? null };
      const each = floorTo(prev.tax / PREPAY_FRACTION, 100);
      const dues = ([[1, 7], [2, 11]] as const).map(([i, m]) => {
        const nominal = monthEnd(year, m);
        return { key: `income_tax:${year}:prepay${i}`, name: `所得税 ${year} 年分 予定納税 第 ${i} 期（見積）`, amount: each, nominal, due: nextBusinessDay(nominal) };
      });
      return { dues, basis: prev.tax };
    });

  const incomeTaxGroup = (year: number): { dues: Due[]; b: Breakdown | null } => {
    const it = incomeTax(year);
    const pre = prepay(year);
    const dues: Due[] = [...pre.dues];
    const lines: BreakdownLine[] = [];
    if (pre.basis !== null) lines.push({ label: `予定納税の基準額（${year - 1} 年分）`, amount: pre.basis });
    if (pre.dues.length) lines.push({ label: '予定納税（各期）', amount: pre.dues[0].amount });
    const total = it ? it.tax : pre.dues.reduce((s, d) => s + d.amount, 0);
    if (it) {
      const a = actual(year);
      const prepaid = a && a.prepaid_income_tax !== null ? a.prepaid_income_tax : pre.dues.reduce((s, d) => s + d.amount, 0);
      const final = it.tax - prepaid;
      lines.push(...it.lines, { label: '納めた予定納税', amount: prepaid }, { label: '確定申告で納める額', amount: Math.max(0, final) });
      if (final > 0) {
        const nominal = `${year + 1}-03-15`;
        dues.push({ key: `income_tax:${year}:final`, name: `所得税 ${year} 年分 確定申告（見積）`, amount: final, nominal, due: nextBusinessDay(nominal) });
      }
    }
    if (dues.length === 0) return { dues, b: null };
    return { dues, b: { group: `income_tax:${year}`, kind: 'income_tax', year, total, lines, ...(it?.r ? meta(it.r) : {}) } };
  };

  // ---- 住民税（F 年度。F−1 年の所得） ----
  const resident = (f: number): { dues: Due[]; b: Breakdown | null } => {
    const r = resolvePrev(f);
    if (!r) return { dues: [], b: null };
    const rates = ratesFor(RESIDENT_RATES, f);
    const soc = social(r.incomeYear);
    const pers = RESIDENT_PERSONAL_DEDUCTION * personal;
    const taxable = floorTo(Math.max(0, r.income - soc - profile.other_deductions - rates.basicDeduction - pers), 1000);
    const incomeLevy = floorTo(Math.max(0, mulFloor(taxable, rates.rate) - rates.adjustmentCredit), 100);
    const total = incomeLevy + rates.perCapita;
    const lines: BreakdownLine[] = [
      { label: `${r.incomeYear} 年の所得`, amount: r.income },
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

  // ---- 個人事業税（F 年度。F−1 年の所得 + 青色控除 − 事業主控除） ----
  const bizTax = (f: number): { dues: Due[]; b: Breakdown | null } => {
    if (profile.biz_tax_rate === null) return { dues: [], b: null };
    const r = resolvePrev(f);
    if (!r) return { dues: [], b: null };
    const base = r.preBlue - BIZ_TAX_DEDUCTION;
    const lines: BreakdownLine[] = [
      { label: `${r.incomeYear} 年の所得（青色控除の前）`, amount: r.preBlue },
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

  const items: EstimateItem[] = [];
  const breakdown: Breakdown[] = [];
  const add = (kind: EstimateKind, year: number, g: { dues: Due[]; b: Breakdown | null }) => {
    // 0 円以下の期（上限 0 の上書きなど）は作らない。
    const inWindow = g.dues.filter((d) => d.amount > 0 && d.due >= window.from && d.due <= window.to);
    if (!inWindow.length || !g.b) return;
    const category = kind === 'nhi' || kind === 'pension' ? 'insurance' : 'tax';
    for (const d of inWindow) items.push({ key: d.key, kind, year, name: d.name, amount: d.amount, due: d.due, category, group: g.b.group });
    breakdown.push(g.b);
  };
  for (let y = y0; y <= y1; y++) {
    add('income_tax', y, incomeTaxGroup(y));
    add('resident', y, resident(y));
    add('nhi', y, nhi(y));
    add('biz_tax', y, bizTax(y));
    add('pension', y, pension(y));
  }
  items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.key < b.key ? -1 : 1));

  if (profile.consumption_mode === 'unset') warnings.push({ kind: 'consumption_tax_mode_unset' });
  else if (profile.consumption_mode !== 'exempt') warnings.push({ kind: 'consumption_tax_not_implemented', mode: profile.consumption_mode });
  for (const year of [...missing].sort((a, b) => a - b)) warnings.push({ kind: 'income_missing', year });
  return { items, warnings, breakdown };
}
