// Gemini の応答スキーマ（docs/mvp-plan.md T2-4、mvp-plan-v0.1.md T2-4、a2ui-review-ui.md §2.1）。
// 構造化出力（responseJsonSchema）に渡す。Gemini の対応するサブセット内で書く:
// type（null を含む配列で nullable）・properties・required・additionalProperties・enum・format(date)・minimum/maximum・
// items・minItems/maxItems・anyOf。allOf・$ref・maxLength は使わない（文字数の上限は src/ai/validate.ts で切る）。
// - 科目の enum は enabled_accounts（src/masters/accounts.ts）の freee の勘定科目 ID（文字列）。Gemini には名前を見せる（prompt.ts）。
// - 税は税率の区分だけを選ばせる（K13）。freee の税区分コードへはサーバーが変換する（validate.ts toTaxCode）。
//   列名は a2ui-review-ui.md・vendor_rules に合わせて tax_id のままにし、値を税率の区分にする。
// - questions[] は質問カード（keihi.catalog/v1 の質問部品）。MVP では保存だけする。
import { TAX_CATEGORIES } from '../../masters/tax-map.ts';

export { TAX_CATEGORIES };

// DecisionBar / 確定 API の decision（mvp-plan.md T2-8）。
export const DECISIONS = ['approve', 'personal', 'duplicate', 'hold'] as const;
// 質問の effect が変えられるフィールド（a2ui-review-ui.md §2.1）。
export const EFFECT_FIELDS = ['account_id', 'tax_id', 'proration_pct', 'decision', 'memo_tag'] as const;
export const QUESTION_COMPONENTS = ['ChoiceQuestion', 'ProrationQuestion', 'YesNoQuestion'] as const;

export const MAX_CANDIDATES = 3;
export const MAX_QUESTIONS = 2;
export const MAX_TAX_ROWS = TAX_CATEGORIES.length;

// 文字数の上限（validate.ts で切り詰める。スキーマには入れない）。
export const TEXT_LIMITS = {
  vendor_name: 100,
  description: 200,
  payment_hint: 40,
  reason: 60,
  question_text: 80,
  option_label: 20,
  memo_tag: 20,
} as const;

export type SchemaAccount = { id: string; name: string };
export type Schema = Record<string, unknown>;

const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
const nullable = (type: string, extra: Schema = {}): Schema => ({ type: [type, 'null'], ...extra });
const en = (values: readonly (string | number)[], type = 'string'): Schema => ({ type, enum: [...values] });
const int = (min: number, max?: number): Schema => ({ type: 'integer', minimum: min, ...(max === undefined ? {} : { maximum: max }) });
const num01: Schema = { type: 'number', minimum: 0, maximum: 1 };
function obj(properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function buildResponseSchema(accounts: readonly SchemaAccount[]): Schema {
  if (accounts.length === 0) throw new Error('科目が 0 件（enabled_accounts が空）');
  const ids = accounts.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new Error('科目の ID が重複している');
  const effect: Schema = {
    anyOf: [
      obj({ field: en(['account_id']), value: en(ids) }),
      obj({ field: en(['tax_id']), value: en(TAX_CATEGORIES) }),
      obj({ field: en(['proration_pct']), value: int(0, 100) }),
      obj({ field: en(['decision']), value: en(DECISIONS) }),
      obj({ field: en(['memo_tag']), value: str() }),
    ],
  };
  const question: Schema = {
    anyOf: [
      obj({
        component: en(['ChoiceQuestion']),
        text: str(),
        options: { type: 'array', minItems: 2, maxItems: 4, items: obj({ label: str(), effect }) },
      }),
      obj({
        component: en(['ProrationQuestion']),
        text: str(),
        min: en([0], 'integer'),
        max: en([100], 'integer'),
        step: en([10], 'integer'),
        suggested: int(0, 100),
      }),
      obj({ component: en(['YesNoQuestion']), text: str(), yes: effect, no: effect }),
    ],
  };
  return obj({
    extraction: obj({
      txn_date: nullable('string', { format: 'date' }),
      amount_total: nullable('integer', { minimum: 1 }),
      tax_by_rate: {
        type: 'array',
        maxItems: MAX_TAX_ROWS,
        items: obj({ category: en(TAX_CATEGORIES), amount_incl_tax: int(0), tax: int(0) }),
      },
      vendor_name: nullable('string'),
      invoice_reg_no: nullable('string'),
      payment_hint: nullable('string'),
      description: nullable('string'),
      confidence: num01,
    }),
    account_candidates: {
      type: 'array',
      maxItems: MAX_CANDIDATES,
      items: obj({ account_id: en(ids), tax_id: en(TAX_CATEGORIES), confidence: num01, reason: str() }),
    },
    questions: { type: 'array', maxItems: MAX_QUESTIONS, items: question },
  });
}

// ---- 応答の型（validate.ts が返す検証済みの値） ----

export type TaxCategoryValue = (typeof TAX_CATEGORIES)[number];
export type Decision = (typeof DECISIONS)[number];

export type Effect =
  | { field: 'account_id'; value: string }
  | { field: 'tax_id'; value: TaxCategoryValue }
  | { field: 'proration_pct'; value: number }
  | { field: 'decision'; value: Decision }
  | { field: 'memo_tag'; value: string };

export type Question =
  | { component: 'ChoiceQuestion'; text: string; options: { label: string; effect: Effect }[] }
  | { component: 'ProrationQuestion'; text: string; min: 0; max: 100; step: 10; suggested: number }
  | { component: 'YesNoQuestion'; text: string; yes: Effect; no: Effect };

export type GeminiResponse = {
  extraction: {
    txn_date: string | null;
    amount_total: number | null;
    tax_by_rate: { category: TaxCategoryValue; amount_incl_tax: number; tax: number }[];
    vendor_name: string | null;
    invoice_reg_no: string | null;
    payment_hint: string | null;
    description: string | null;
    confidence: number;
  };
  account_candidates: { account_id: string; tax_id: TaxCategoryValue; confidence: number; reason: string }[];
  questions: Question[];
};
