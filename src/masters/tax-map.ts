// 税率の区分と、freee の税区分コードへの対応表（docs/mvp-plan.md T0-4・T2-5、K13）。
// Gemini には税率の区分だけを選ばせ、税区分コードへはサーバーが対応表で決定的に変換する（src/ai/validate.ts toTaxCode）。
// 対応表は config/tax-map.json（T0-4 で作る）。無ければ src/masters/default-tax-map.json（仮の表。課税方式は本則を仮定）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 税率の区分（Gemini の enum）。
export const TAX_CATEGORIES = ['taxable_10', 'taxable_8_reduced', 'non_taxable', 'out_of_scope'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];
// Gemini に見せる名前。
export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  taxable_10: '課税 10%',
  taxable_8_reduced: '課税 8%（軽減税率）',
  non_taxable: '非課税',
  out_of_scope: '対象外・不課税',
};

// qualified = 有効な登録番号がある、not_qualified = 無い、any = どちらでも。
export type InvoiceCond = 'qualified' | 'not_qualified' | 'any';

export type TaxMapRule = {
  category: TaxCategory;
  invoice: InvoiceCond;
  from: string | null; // 取引日の範囲（両端を含む、YYYY-MM-DD）。null は制限なし
  to: string | null;
  // どちらか一方。tax_name は同期済みの税区分のマスタを名前で引く。
  tax_code: number | null;
  tax_name: string | null;
};
export type TaxMap = { version: 1; provisional: boolean; method: string; rules: TaxMapRule[] };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TAX_MAP_PATH = path.join(HERE, '..', '..', 'config', 'tax-map.json');
export const DEFAULT_TAX_MAP_PATH = path.join(HERE, 'default-tax-map.json');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE: readonly InvoiceCond[] = ['qualified', 'not_qualified', 'any'];

function fail(file: string, msg: string): never {
  throw new Error(`${file}: ${msg}`);
}

export function parseTaxMap(raw: unknown, file = 'tax-map'): TaxMap {
  const o = raw as Record<string, unknown>;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) fail(file, 'オブジェクトではない');
  if (o.version !== 1) fail(file, 'version が 1 ではない');
  if (typeof o.method !== 'string' || !o.method) fail(file, 'method が無い');
  if (!Array.isArray(o.rules) || o.rules.length === 0) fail(file, 'rules が空');
  const rules = o.rules.map((r: unknown, i: number): TaxMapRule => {
    const e = r as Record<string, unknown>;
    const at = `rules[${i}]`;
    if (typeof e !== 'object' || e === null) fail(file, `${at} がオブジェクトではない`);
    if (!(TAX_CATEGORIES as readonly unknown[]).includes(e.category)) fail(file, `${at}.category が不正`);
    if (!(INVOICE as readonly unknown[]).includes(e.invoice)) fail(file, `${at}.invoice が不正`);
    for (const k of ['from', 'to'] as const) {
      const v = e[k] ?? null;
      if (v !== null && !(typeof v === 'string' && DATE.test(v))) fail(file, `${at}.${k} が YYYY-MM-DD か null ではない`);
    }
    const code = e.tax_code ?? null;
    const name = e.tax_name ?? null;
    if (code !== null && !Number.isInteger(code)) fail(file, `${at}.tax_code が整数ではない`);
    if (name !== null && (typeof name !== 'string' || !name)) fail(file, `${at}.tax_name が文字列ではない`);
    if ((code === null) === (name === null)) fail(file, `${at} は tax_code と tax_name のどちらか一方だけを持つ`);
    return {
      category: e.category as TaxCategory,
      invoice: e.invoice as InvoiceCond,
      from: (e.from as string | null) ?? null,
      to: (e.to as string | null) ?? null,
      tax_code: code as number | null,
      tax_name: name as string | null,
    };
  });
  return { version: 1, provisional: o.provisional === true, method: o.method, rules };
}

export function loadTaxMap(file?: string): TaxMap {
  const f = file ?? (existsSync(TAX_MAP_PATH) ? TAX_MAP_PATH : DEFAULT_TAX_MAP_PATH);
  return parseTaxMap(JSON.parse(readFileSync(f, 'utf8')), f);
}
