// 確認カードと確定で共有する項目の定義（docs/mvp-plan.md T2-7・T2-8、a2ui-review-ui.md §2.1・§3.6）。
// - 支払手段（reviews.credit_account / vendor_rules.credit_account）は 'cash' | 'owner' | 'card:<walletable の remote_id>'。
// - 税は税率の区分（TAX_CATEGORIES）で扱い、reviews.tax_by_rate_json にだけ短い符号（'10'|'8r'|'exempt'|'na'）で入れる（T4 との契約）。
// - 出所（field_sources_json）は ocr / ai / dictionary / human / agent。agent は M7 の提案から確定したとき用に予約（今は使わない）。
import { TAX_CATEGORIES, type TaxCategory } from '../masters/tax-map.ts';
import { listWalletables } from '../masters/sync.ts';
import type { Db } from '../db/index.ts';

export const PROVIDER = 'freee';
export const CATALOG_ID = 'keihi.catalog/v1';

export const FIELD_SOURCES = ['ocr', 'ai', 'dictionary', 'human', 'agent'] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

// 確定で受け取る項目（values のキー）。
export const FIELDS = [
  'txn_date',
  'amount',
  'tax_by_rate',
  'vendor',
  'invoice_reg_no',
  'qualified_invoice',
  'account_id',
  'tax_id',
  'payment',
  'proration_pct',
  'memo',
] as const;
export type Field = (typeof FIELDS)[number];

export type TaxRow = { category: TaxCategory; amount_incl_tax: number; tax: number };

export type Values = {
  txn_date: string | null;
  amount: number | null;
  tax_by_rate: TaxRow[];
  vendor: string | null;
  invoice_reg_no: string | null;
  qualified_invoice: boolean;
  account_id: string | null;
  tax_id: TaxCategory | null;
  payment: string | null;
  proration_pct: number;
  memo: string | null;
};

export type Sources = Record<Field, FieldSource | null>;

// approve で必須（R10。mvp-plan-v0.1.md T2-8）。
export const REQUIRED_FOR_APPROVE: readonly Field[] = ['txn_date', 'amount', 'vendor', 'account_id', 'tax_id', 'payment'];

export const TEXT_MAX = { vendor: 100, memo: 200, payment_label: 20, account_name: 40 } as const;

// ---- 税率の区分 ↔ reviews.tax_by_rate_json の符号 ----

const TO_CODE: Record<TaxCategory, string> = { taxable_10: '10', taxable_8_reduced: '8r', non_taxable: 'exempt', out_of_scope: 'na' };
const FROM_CODE = new Map(Object.entries(TO_CODE).map(([k, v]) => [v, k as TaxCategory]));

export function toStoredTaxRows(rows: readonly TaxRow[]): { category: string; amount_incl_tax: number; tax: number }[] {
  return rows.map((r) => ({ category: TO_CODE[r.category], amount_incl_tax: r.amount_incl_tax, tax: r.tax }));
}

export function fromStoredTaxRows(json: string | null): TaxRow[] {
  return parseRows(json, (c) => FROM_CODE.get(c) ?? null);
}

// extractions.tax_by_rate_json（税率の区分のまま）を読む。読めない行は捨てる。
export function fromExtractionTaxRows(json: string | null): TaxRow[] {
  return parseRows(json, (c) => ((TAX_CATEGORIES as readonly string[]).includes(c) ? (c as TaxCategory) : null));
}

function parseRows(json: string | null, cat: (c: string) => TaxCategory | null): TaxRow[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: TaxRow[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (typeof r !== 'object' || r === null) continue;
    const c = typeof r.category === 'string' ? cat(r.category) : null;
    const a = r.amount_incl_tax;
    const t = r.tax;
    if (c && Number.isSafeInteger(a) && (a as number) >= 0 && Number.isSafeInteger(t) && (t as number) >= 0) {
      out.push({ category: c, amount_incl_tax: a as number, tax: t as number });
    }
  }
  return out.slice(0, TAX_CATEGORIES.length);
}

// ---- 支払手段 ----

export type PaymentOption = { id: string; label: string };
export const CARD_PREFIX = 'card:';
const FIXED_PAYMENTS: PaymentOption[] = [
  { id: 'owner', label: '事業主借' },
  { id: 'cash', label: '現金' },
];
// PaymentChips の上限（カタログ）。
export const MAX_PAYMENT_OPTIONS = 8;

// 選べる支払手段の全部（固定の 2 つ + 同期済みの口座・カード）。
export function paymentOptions(db: Db): PaymentOption[] {
  const ws = listWalletables(db, PROVIDER)
    .slice()
    .sort((a, b) => (a.remoteId < b.remoteId ? -1 : a.remoteId > b.remoteId ? 1 : 0))
    .map((w) => ({ id: `${CARD_PREFIX}${w.remoteId}`, label: [...(w.alias ?? w.name)].slice(0, TEXT_MAX.payment_label).join('') }));
  return [...FIXED_PAYMENTS, ...ws];
}

// カードに出す分（上限 8）。selected が溢れた分にあれば入れ替えて必ず出す。
export function paymentChipOptions(all: readonly PaymentOption[], selected: string | null): PaymentOption[] {
  const head = all.slice(0, MAX_PAYMENT_OPTIONS);
  if (selected && !head.some((o) => o.id === selected)) {
    const hit = all.find((o) => o.id === selected);
    if (hit) head[head.length - 1] = hit;
  }
  return head;
}
