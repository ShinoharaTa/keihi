// 税金・保険料の見積もりに使う法定の数値（docs/cashflow.md §14.3）。年（暦年・年度）をキーにした定数。
// 定義の無い年は、それより前で最も新しい年の値を使う（ratesFor）。年 1 回、新しい年度の値を足す（10 分の手作業）。
// 金額は整数の円、率は小数（0.05 = 5%）。

// ---- 所得税（国税） ----

// 速算表。課税所得 ≤ upTo なら 税額 = 課税所得 × rate − minus。
// https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm
export type Bracket = { upTo: number; rate: number; minus: number };
export const INCOME_TAX_BRACKETS: readonly Bracket[] = [
  { upTo: 1_949_000, rate: 0.05, minus: 0 },
  { upTo: 3_299_000, rate: 0.1, minus: 97_500 },
  { upTo: 6_949_000, rate: 0.2, minus: 427_500 },
  { upTo: 8_999_000, rate: 0.23, minus: 636_000 },
  { upTo: 17_999_000, rate: 0.33, minus: 1_536_000 },
  { upTo: 39_999_000, rate: 0.4, minus: 2_796_000 },
  { upTo: Infinity, rate: 0.45, minus: 4_796_000 },
];

// 復興特別所得税（基準所得税額 × 2.1%）。令和 9 年以後は防衛特別所得税と組み替えるが合計率は変わらない。
// https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm
export const RECONSTRUCTION_RATE = 0.021;

// 基礎控除（所得税）。合計所得 ≤ upTo なら amount。年分ごと。
// 2025 = 令和 7 年分、2026 = 令和 8・9 年分（令和 8 年度改正。令和 8 年 12 月 1 日施行、令和 8 年分から適用）、2028 = 令和 10 年分以後。
// https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm （[令和8年4月1日現在法令等]。2026-11-12 に確認）
export type Step = { upTo: number; amount: number };
export const INCOME_TAX_BASIC_DEDUCTION: Readonly<Record<number, readonly Step[]>> = {
  2025: [
    { upTo: 1_320_000, amount: 950_000 },
    { upTo: 3_360_000, amount: 880_000 },
    { upTo: 4_890_000, amount: 680_000 },
    { upTo: 6_550_000, amount: 630_000 },
    { upTo: 23_500_000, amount: 580_000 },
    { upTo: 24_000_000, amount: 480_000 },
    { upTo: 24_500_000, amount: 320_000 },
    { upTo: 25_000_000, amount: 160_000 },
    { upTo: Infinity, amount: 0 },
  ],
  2026: [
    { upTo: 4_890_000, amount: 1_040_000 },
    { upTo: 6_550_000, amount: 670_000 },
    { upTo: 23_500_000, amount: 620_000 },
    { upTo: 24_000_000, amount: 480_000 },
    { upTo: 24_500_000, amount: 320_000 },
    { upTo: 25_000_000, amount: 160_000 },
    { upTo: Infinity, amount: 0 },
  ],
  2028: [
    { upTo: 1_320_000, amount: 990_000 },
    { upTo: 23_500_000, amount: 620_000 },
    { upTo: 24_000_000, amount: 480_000 },
    { upTo: 24_500_000, amount: 320_000 },
    { upTo: 25_000_000, amount: 160_000 },
    { upTo: Infinity, amount: 0 },
  ],
};

// 配偶者控除・扶養控除（一般）。所得税 38 万、住民税 33 万。所得制限・特定扶養などの細部は見ない（概算）。
// https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1191.htm / https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1180.htm
export const INCOME_TAX_PERSONAL_DEDUCTION = 380_000;
export const RESIDENT_PERSONAL_DEDUCTION = 330_000;

// 青色申告特別控除。'white' は白色申告（0）。
// https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2072.htm
export const BLUE_RETURN_DEDUCTION = { '65': 650_000, '55': 550_000, '10': 100_000, white: 0 } as const;

// 予定納税。前年の申告納税額（予定納税基準額）が 15 万円以上なら、7 月・11 月に各 1/3。
// https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2040.htm
export const PREPAY_THRESHOLD = 150_000;
export const PREPAY_FRACTION = 3;

// ---- 住民税（さいたま市・埼玉県。普通徴収） ----

// 所得割 市 8% + 県 2%。均等割 市 3,000 + 県 1,000 + 森林環境税（国税）1,000。
// https://www.city.saitama.lg.jp/001/153/004/002/001/001/p013654.html
// 基礎控除 43 万（令和 8 年度も据え置き）: https://www.pref.tochigi.lg.jp/b07/life/zeikin/zeikin/documents/09r7zeiseikaiseinogaiyou.pdf
// 令和 8 年度改正でも変わらない（大綱の概要で引き上げは所得税の基礎控除だけ。2026-11-12 に確認）: https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/08taikou_gaiyou.htm
// 調整控除は単身 2,500 円で仮置き【要確認】。
// 納期 第 1〜4 期 = 6 月末・8 月末・10 月末・翌 1 月末（休日なら翌開庁日）: https://www.city.saitama.lg.jp/faq/001/001/003/p110417.html
export type ResidentRates = { rate: number; perCapita: number; basicDeduction: number; adjustmentCredit: number };
export const RESIDENT_RATES: Readonly<Record<number, ResidentRates>> = {
  2026: { rate: 0.1, perCapita: 5_000, basicDeduction: 430_000, adjustmentCredit: 2_500 },
};
export const RESIDENT_DUE_MONTHS = [6, 8, 10, 13] as const; // 13 = 翌年 1 月

// ---- 国民健康保険税（市町村のプリセット） ----

// 区分ごとに 所得割（課税標準 × rate）+ 均等割（per_capita × 人数）+ 平等割（per_household、無ければ null）、100 円未満切り捨て、cap が上限。
// 課税標準 = 前年の所得 − basic_deduction。介護分は 40〜64 歳の人数だけ数える。
export type NhiSegment = { rate: number; per_capita: number; per_household: number | null; cap: number };
export type NhiRates = { basic_deduction: number; medical: NhiSegment; support: NhiSegment; care: NhiSegment; children: NhiSegment };
export const NHI_SEGMENTS = ['medical', 'support', 'care', 'children'] as const;

// さいたま市 令和 8 年度。医療 7.64% + 43,300（上限 67 万）/ 支援 2.73% + 14,900（26 万）/ 介護 2.37% + 16,100（17 万）/
// 子ども・子育て 0.26% + 1,700（3 万）。平等割なし。基礎控除 43 万。納期 8 期 = 7 月末〜翌 2 月末の毎月末。
// 計算例: 42 歳・所得 300 万 → 409,900 円。
// 料率 https://www.city.saitama.lg.jp/001/153/002/004/p010020.html / 納期 https://www.city.saitama.lg.jp/faq/001/001/003/p110417.html
export const NHI_PRESETS: Readonly<Record<string, { label: string; rates: NhiRates }>> = {
  'saitama-city-2026': {
    label: 'さいたま市 令和 8 年度',
    rates: {
      basic_deduction: 430_000,
      medical: { rate: 0.0764, per_capita: 43_300, per_household: null, cap: 670_000 },
      support: { rate: 0.0273, per_capita: 14_900, per_household: null, cap: 260_000 },
      care: { rate: 0.0237, per_capita: 16_100, per_household: null, cap: 170_000 },
      children: { rate: 0.0026, per_capita: 1_700, per_household: null, cap: 30_000 },
    },
  },
};

// ---- 個人事業税（埼玉県） ----

// 事業主控除 290 万。課税標準 = 所得 + 青色申告特別控除 − 290 万。納期 8 月・11 月（税額 1 万円以下は 8 月に一括）。
// https://www.pref.saitama.lg.jp/a0209/z-kurashiindex/z-2-4.html
export const BIZ_TAX_DEDUCTION = 2_900_000;
export const BIZ_TAX_SINGLE_PAYMENT_MAX = 10_000;

// ---- 国民年金（年度 = 4 月〜翌 3 月） ----

// 月額。付加保険料 400 円/月。口座振替の前納額（6 か月・1 年・2 年）。
// https://www.nenkin.go.jp/service/kokunen/hokenryo/zenno.html / https://www.city.saitama.lg.jp/001/153/003/005/p082987.html
// 2027 年度の前納額は未公表のため、2026 年度の値を使う（ratesFor の繰り越し）。
export type PensionRates = { monthly: number; prepay6: number; prepay12: number; prepay24: number };
export const PENSION_RATES: Readonly<Record<number, PensionRates>> = {
  2026: { monthly: 17_920, prepay6: 106_300, prepay12: 210_530, prepay24: 417_150 },
  2027: { monthly: 18_290, prepay6: 106_300, prepay12: 210_530, prepay24: 417_150 },
};
export const PENSION_ADDON_MONTHLY = 400;

// ---- 消費税（国税 7.8% + 地方消費税 2.2% = 10%） ----

// 簡易課税のみなし仕入率（第 1 種 卸売 90% 〜 第 6 種 不動産 40%）。
// https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6509.htm
export const CTAX_DEEMED_PURCHASE_PCT: Readonly<Record<number, number>> = { 1: 90, 2: 80, 3: 70, 4: 60, 5: 50, 6: 40 };

// 2 割特例（売上税額 × 20%）はインボイス登録で課税事業者になった人の令和 5〜8 年分（2026 年分）まで。
// 2027 年分以降は作らず special20_expired の警告。
// https://www.nta.go.jp/publication/pamph/shohi/kaisei/202304/01.htm
export const CTAX_SPECIAL20_LAST_YEAR = 2026;

// 免税事業者の判定（基準期間の課税売上高 1,000 万円以下）と簡易課税を選べる上限（同 5,000 万円以下）。試算（simulate.ts）の方式の比較だけで使う。
// https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm / https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm
export const CTAX_EXEMPT_THRESHOLD = 10_000_000;
export const CTAX_SIMPLIFIED_THRESHOLD = 50_000_000;

// 中間申告。前年の確定消費税額（国税分）が 48 万円超〜400 万円以下なら年 1 回、前年の国税分 × 6/12。
// 地方消費税の中間分は国税分 × 22/78。期限は中間期間（1〜6 月）の末日の翌日から 2 か月（8/31）。
// https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6609.htm
export const CTAX_INTERIM_THRESHOLD = 480_000;

// year 以前で最も新しい年の値。year がどの年より前なら最も古い年の値。
export function ratesFor<T>(table: Readonly<Record<number, T>>, year: number): T {
  const years = Object.keys(table).map(Number).sort((a, b) => a - b);
  let pick = years[0];
  for (const y of years) if (y <= year) pick = y;
  return table[pick];
}

// 表の最も新しい年。
export function latestYear(table: Readonly<Record<number, unknown>>): number {
  return Math.max(...Object.keys(table).map(Number));
}

// 年をキーにした表の最新年（試算の rates_assumed）。これより先の年は前の年の値で計算する。国保のプリセットは年のキーを持たないので入らない。
export function ratesLatestYears(): { income_tax_basic_deduction: number; resident: number; pension: number } {
  return { income_tax_basic_deduction: latestYear(INCOME_TAX_BASIC_DEDUCTION), resident: latestYear(RESIDENT_RATES), pension: latestYear(PENSION_RATES) };
}
