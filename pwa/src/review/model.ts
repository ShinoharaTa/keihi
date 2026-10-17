// 確認画面の状態（docs/mvp-plan.md T2-10、a2ui-review-ui.md §3.7、U8）。純関数。
// - 下書き（Draft）はカードの dataModel.values から始める。確定のときはカードの値から変えた項目だけを送る
//   （変えていなければ values は空 = 差分なしの 1 タップ確定）。
// - 確定ボタンは R10 の必須（日付・金額・取引先・科目・税・支払手段）がそろったときだけ押せる。
import type { TaxCategory, TaxRow } from './catalog.ts';

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
export type FieldName = keyof Values;

export type DataModel = {
  document_id: string;
  status: string;
  deadline_on: string;
  days_left: number;
  version: number;
  values: Values;
  sources: Partial<Record<FieldName, string | null>>;
  accounts: { id: string; name: string; private: boolean }[];
  warnings: string[];
};

export type CardResponse = { card_id: string; surface: unknown; dataModel: DataModel };

export const REQUIRED: readonly FieldName[] = ['txn_date', 'amount', 'vendor', 'account_id', 'tax_id', 'payment'];
export const FIELD_LABELS: Record<FieldName, string> = {
  txn_date: '日付',
  amount: '金額',
  tax_by_rate: '税率別の内訳',
  vendor: '取引先',
  invoice_reg_no: '登録番号',
  qualified_invoice: '適格請求書',
  account_id: '科目',
  tax_id: '税区分',
  payment: '支払手段',
  proration_pct: '按分',
  memo: 'メモ',
};
export const TAX_LABELS: Record<TaxCategory, string> = {
  taxable_10: '10%',
  taxable_8_reduced: '8%（軽減）',
  non_taxable: '非課税',
  out_of_scope: '対象外',
};
export const ENDPOINTS = { approve: 'approve', personal: 'mark_private', duplicate: 'mark_duplicate' } as const;
export const ACTION_LABELS = { approve: '確定', personal: '私用', duplicate: '重複' } as const;

export function missingRequired(d: Values): FieldName[] {
  return REQUIRED.filter((f) => d[f] === null);
}

export function canApprove(d: Values): boolean {
  return missingRequired(d).length === 0;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// カードの値から変えた項目だけ。
export function changedValues(card: Values, draft: Values): Partial<Values> {
  const out: Partial<Values> = {};
  for (const k of Object.keys(draft) as FieldName[]) {
    if (!same(card[k], draft[k])) (out as Record<string, unknown>)[k] = draft[k];
  }
  return out;
}

export function requestBody(cardId: string, dm: DataModel, draft: Values): { card_id: string; expected_version: number; values?: Partial<Values> } {
  const values = changedValues(dm.values, draft);
  return Object.keys(values).length ? { card_id: cardId, expected_version: dm.version, values } : { card_id: cardId, expected_version: dm.version };
}

// 科目チップ（第 1〜3 候補）を選ぶ: 科目と税率の区分をその候補にする。
export function pickCandidate(d: Values, c: { account_id: string; tax_id: TaxCategory }): Values {
  return { ...d, account_id: c.account_id, tax_id: c.tax_id };
}

// "1,100" "１１００" "1100円" → 1100。正の整数でなければ null。
export function parseAmount(s: string): number | null {
  const t = s.normalize('NFKC').replace(/[,\s円¥]/g, '');
  if (!/^\d{1,12}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 ? n : null;
}

export function formatAmount(n: number | null): string {
  return n === null ? '―' : `¥${n.toLocaleString('ja-JP')}`;
}

export function daysLeftText(days: number): string {
  if (days < 0) return `期限を ${-days} 営業日過ぎ`;
  if (days === 0) return '期限は今日';
  return `期限まで ${days} 営業日`;
}

export function isUrgent(days: number): boolean {
  return days <= 2;
}

// 確定 API の失敗を画面の文に直す。
export function errorText(status: number, body: unknown): string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { reason?: unknown; fields?: unknown };
  if (status === 0) return '通信できませんでした。もう一度押してください。';
  if (status === 409) return 'ほかで更新されました。読み直しました。';
  if (status === 422 && b.reason === 'missing_required' && Array.isArray(b.fields)) {
    return `未入力: ${b.fields.map((f) => FIELD_LABELS[f as FieldName] ?? String(f)).join('・')}`;
  }
  if (status === 422) return '入力に誤りがあります。';
  return `確定できませんでした（HTTP ${status}）`;
}
