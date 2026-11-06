// Gemini の応答のサーバー側の検証（docs/mvp-plan.md T2-5、mvp-plan-v0.1.md T2-5、a2ui-review-ui.md §2.1）。
// Gemini が構造化出力を守っても毎回やる。
// - 拒否（errors）: JSON でない、スキーマ違反（型違い・enum 外・余分なキー・必須の欠け・範囲外）。再試行はしない。
// - 警告（warnings）: 値を直して通すもの。文字数の切り詰め、登録番号の形式・検査数字の誤り（null にする）、
//   内訳の和 ≠ 合計（許容差 0）、事業主貸なのに税率の区分が対象外でない。
// - テキスト（取引先名・摘要・理由・質問文）はデータとして扱うだけで解釈しない。制御文字を除き、長さで切るだけ。
// 税率の区分 → freee の税区分コードの変換（toTaxCode）もここに置く（K13）。
import { buildResponseSchema, TEXT_LIMITS, type Effect, type GeminiResponse, type Schema, type SchemaAccount } from './gemini/schema.ts';
import type { TaxCategory, TaxMap, TaxMapRule } from '../masters/tax-map.ts';

// ---- スキーマ（Gemini のサブセット + カタログで使う minLength / maxLength / pattern） ----

export function validateSchema(schema: Schema, value: unknown, at = '$'): string[] {
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as Schema[]).map((s) => validateSchema(s, value, at));
    if (branches.some((b) => b.length === 0)) return [];
    // 判別用の enum（component / field）が合う枝があれば、その枝の理由を返す
    const close = branches.filter((b) => !b.some((e) => /\.(component|field): enum 外/.test(e)));
    return close.length === 1 ? close[0] : [`${at}: anyOf のどれにも合わない`];
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const typeOk = (t: string) =>
    t === 'null' ? value === null
    : t === 'integer' ? Number.isSafeInteger(value)
    : t === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : t === 'array' ? Array.isArray(value)
    : t === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
    : typeof value === t;
  if (types.length && !types.some(typeOk)) return [`${at}: 型が ${types.join('|')} ではない`];
  if (value === null) return [];
  const errs: string[] = [];
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) errs.push(`${at}: enum 外の値`);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errs.push(`${at}: minimum 未満`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errs.push(`${at}: maximum 超過`);
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (typeof schema.minLength === 'number' && len < schema.minLength) errs.push(`${at}: minLength 未満`);
    if (typeof schema.maxLength === 'number' && len > schema.maxLength) errs.push(`${at}: maxLength 超過`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${at}: pattern に合わない`);
    if (schema.format === 'date' && !isDate(value)) errs.push(`${at}: 日付の形式ではない`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errs.push(`${at}: minItems 未満`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errs.push(`${at}: maxItems 超過`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateSchema(schema.items as Schema, v, `${at}[${i}]`)));
  }
  if (typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const props = schema.properties as Record<string, Schema>;
    const rec = value as Record<string, unknown>;
    for (const k of (schema.required as string[] | undefined) ?? []) if (!Object.hasOwn(rec, k)) errs.push(`${at}.${k}: 必須`);
    for (const [k, v] of Object.entries(rec)) {
      if (Object.hasOwn(props, k)) errs.push(...validateSchema(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: 未知のフィールド`);
    }
  }
  return errs;
}

function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ---- テキスト ----

// C0・DEL・C1 の制御文字と、表示を偽装できる書式文字（ゼロ幅・双方向の上書き・BOM）。
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// 改行・タブは空白に、それ以外の制御文字は除き、前後の空白を落としてから max 文字（コードポイント）で切る。
export function sanitizeText(s: string, max: number): { text: string; truncated: boolean; stripped: boolean } {
  const spaced = s.replace(/[\t\n\r\v\f]+/g, ' ');
  const cleaned = spaced.replace(CONTROL, '');
  const chars = [...cleaned.trim()];
  return { text: chars.slice(0, max).join(''), truncated: chars.length > max, stripped: cleaned !== spaced };
}

// ---- 登録番号（T + 13 桁。13 桁は法人番号と同じ検査数字の規則: 先頭 1 桁が残り 12 桁の検査数字） ----

export function corporateCheckDigit(base12: string): number {
  if (!/^\d{12}$/.test(base12)) throw new Error('12 桁の数字ではない');
  let sum = 0;
  for (let n = 1; n <= 12; n++) {
    const p = Number(base12[12 - n]); // 下から n 桁目
    sum += p * (n % 2 === 1 ? 1 : 2);
  }
  return 9 - (sum % 9);
}

export type InvoiceRegNoCheck = { value: string | null; error: 'format' | 'check_digit' | null };

// NFKC・大文字化・空白とハイフンの除去をしてから検査する。不正なら value は null。
export function checkInvoiceRegNo(raw: string): InvoiceRegNoCheck {
  const s = raw.normalize('NFKC').toUpperCase().replace(/[\s\-\u2010-\u2015\u2212]/g, '');
  if (!/^T\d{13}$/.test(s)) return { value: null, error: 'format' };
  if (Number(s[1]) !== corporateCheckDigit(s.slice(2))) return { value: null, error: 'check_digit' };
  return { value: s, error: null };
}

// ---- 応答の検証 ----

export type ValidationWarning = { code: string; path: string; detail?: string };
export type ValidationResult =
  | { ok: true; value: GeminiResponse; warnings: ValidationWarning[] }
  | { ok: false; errors: string[] };

export type ValidateContext = { accounts: readonly (SchemaAccount & { private?: boolean })[] };

export function validateGeminiResponse(input: unknown, ctx: ValidateContext): ValidationResult {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, errors: ['$: JSON として読めない'] };
    }
  }
  const errors = validateSchema(buildResponseSchema(ctx.accounts), raw);
  if (errors.length) return { ok: false, errors };

  const v = structuredClone(raw) as GeminiResponse;
  const warnings: ValidationWarning[] = [];
  const text = (s: string, max: number, path: string): string => {
    const r = sanitizeText(s, max);
    if (r.stripped) warnings.push({ code: 'control_chars_removed', path });
    if (r.truncated) warnings.push({ code: 'truncated', path, detail: `${max} 字` });
    return r.text;
  };
  const nullableText = (s: string | null, max: number, path: string): string | null => {
    if (s === null) return null;
    const t = text(s, max, path);
    return t === '' ? null : t;
  };
  const effect = (e: Effect, path: string): Effect => (e.field === 'memo_tag' ? { ...e, value: text(e.value, TEXT_LIMITS.memo_tag, `${path}.value`) } : e);

  const ex = v.extraction;
  ex.vendor_name = nullableText(ex.vendor_name, TEXT_LIMITS.vendor_name, '$.extraction.vendor_name');
  ex.description = nullableText(ex.description, TEXT_LIMITS.description, '$.extraction.description');
  ex.payment_hint = nullableText(ex.payment_hint, TEXT_LIMITS.payment_hint, '$.extraction.payment_hint');

  if (ex.invoice_reg_no !== null) {
    const r = checkInvoiceRegNo(ex.invoice_reg_no);
    if (r.error) warnings.push({ code: r.error === 'format' ? 'invoice_reg_no_format' : 'invoice_reg_no_check_digit', path: '$.extraction.invoice_reg_no' });
    ex.invoice_reg_no = r.value;
  }

  if (ex.amount_total !== null) {
    const sum = ex.tax_by_rate.reduce((a, r) => a + r.amount_incl_tax, 0);
    if (sum !== ex.amount_total) {
      warnings.push({ code: 'amount_mismatch', path: '$.extraction.tax_by_rate', detail: `内訳の和 ${sum} ≠ 合計 ${ex.amount_total}` });
    }
  }

  const priv = new Set(ctx.accounts.filter((a) => a.private).map((a) => a.id));
  v.account_candidates.forEach((c, i) => {
    c.reason = text(c.reason, TEXT_LIMITS.reason, `$.account_candidates[${i}].reason`);
    if (priv.has(c.account_id) && c.tax_id !== 'out_of_scope') {
      warnings.push({ code: 'private_not_out_of_scope', path: `$.account_candidates[${i}].tax_id` });
    }
  });

  v.questions = v.questions.map((q, i) => {
    const p = `$.questions[${i}]`;
    const t = text(q.text, TEXT_LIMITS.question_text, `${p}.text`);
    if (q.component === 'ChoiceQuestion') {
      return {
        ...q,
        text: t,
        options: q.options.map((o, j) => ({
          label: text(o.label, TEXT_LIMITS.option_label, `${p}.options[${j}].label`),
          effect: effect(o.effect, `${p}.options[${j}].effect`),
        })),
      };
    }
    if (q.component === 'YesNoQuestion') return { ...q, text: t, yes: effect(q.yes, `${p}.yes`), no: effect(q.no, `${p}.no`) };
    return { ...q, text: t };
  });

  return { ok: true, value: v, warnings };
}

// ---- 税率の区分 → freee の税区分コード ----

export type TaxCodeInput = {
  category: TaxCategory;
  txnDate: string | null; // YYYY-MM-DD。null なら日付の範囲を持つ規則には当てない
  hasInvoiceRegNo: boolean; // 検証済みの登録番号があるか
};
export type TaxCodeResult = { ok: true; code: number; rule: TaxMapRule } | { ok: false; reason: string };

// taxMasters は同期済みの税区分（remoteId はコードの文字列）。tax_name の規則はこれを名前で引く。
export function toTaxCode(input: TaxCodeInput, map: TaxMap, taxMasters: readonly { remoteId: string; name: string }[]): TaxCodeResult {
  const inv = input.hasInvoiceRegNo ? 'qualified' : 'not_qualified';
  const hits = map.rules.filter(
    (r) =>
      r.category === input.category &&
      (r.invoice === 'any' || r.invoice === inv) &&
      (r.from === null || (input.txnDate !== null && input.txnDate >= r.from)) &&
      (r.to === null || (input.txnDate !== null && input.txnDate <= r.to)),
  );
  const what = `${input.category} / ${inv} / ${input.txnDate ?? '日付なし'}`;
  if (hits.length === 0) return { ok: false, reason: `対応表に当てはまる規則が無い（${what}）` };
  if (hits.length > 1) return { ok: false, reason: `対応表の規則が ${hits.length} 件当てはまる（${what}）` };
  const rule = hits[0];
  if (rule.tax_code !== null) return { ok: true, code: rule.tax_code, rule };
  const m = taxMasters.filter((t) => t.name === rule.tax_name);
  if (m.length !== 1) return { ok: false, reason: `税区分「${rule.tax_name}」が同期済みのマスタに ${m.length} 件` };
  return { ok: true, code: Number(m[0].remoteId), rule };
}
