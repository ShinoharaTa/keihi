// keihi.catalog/v1 の部品の受け取り（docs/mvp-plan.md T2-10、a2ui-review-ui.md §2.1）。純関数。
// - カタログの固定部品 8 種だけを通す。知らない部品・形の合わない部品は捨てる（描画しない）。
// - 質問部品（ChoiceQuestion など）は MVP では描画しないので、ここで捨てる。
// - 文字列は加工しない（描画は JSX のテキストだけ。HTML・URL・画像の参照として扱わない）。
export const CATALOG_ID = 'keihi.catalog/v1';
export const TAX_CATEGORIES = ['taxable_10', 'taxable_8_reduced', 'non_taxable', 'out_of_scope'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];
export const DECISION_ACTIONS = ['approve', 'personal', 'duplicate'] as const; // hold は描画しない（サーバーに無い）
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export type TaxRow = { category: TaxCategory; amount_incl_tax: number; tax: number };
export type AccountCandidate = { account_id: string; name: string; tax_id: TaxCategory; confidence: number };

export type Component =
  | { id: string; component: 'ReceiptThumb'; document_id: string }
  | { id: string; component: 'AmountField'; total: number | null; by_rate: TaxRow[] }
  | { id: string; component: 'DateField'; value: string | null }
  | { id: string; component: 'VendorField'; name: string | null; invoice_reg_no: string | null }
  | { id: string; component: 'AccountChips'; candidates: AccountCandidate[]; selected: string | null }
  | { id: string; component: 'AccountSheet'; selected: string | null }
  | { id: string; component: 'PaymentChips'; options: { id: string; label: string }[]; selected: string | null }
  | { id: string; component: 'DecisionBar'; actions: DecisionAction[] };
export type ComponentName = Component['component'];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const int = (v: unknown): v is number => Number.isSafeInteger(v);
const isTax = (v: unknown): v is TaxCategory => str(v) && (TAX_CATEGORIES as readonly string[]).includes(v);

const CHECKS: Record<ComponentName, (c: Rec) => boolean> = {
  ReceiptThumb: (c) => str(c.document_id) && c.document_id.length > 0,
  AmountField: (c) =>
    (c.total === null || (int(c.total) && c.total >= 1)) &&
    Array.isArray(c.by_rate) &&
    c.by_rate.every((r) => isRec(r) && isTax(r.category) && int(r.amount_incl_tax) && int(r.tax)),
  DateField: (c) => strOrNull(c.value),
  VendorField: (c) => strOrNull(c.name) && strOrNull(c.invoice_reg_no),
  AccountChips: (c) =>
    strOrNull(c.selected) &&
    Array.isArray(c.candidates) &&
    c.candidates.length <= 3 &&
    c.candidates.every((x) => isRec(x) && str(x.account_id) && str(x.name) && isTax(x.tax_id) && typeof x.confidence === 'number'),
  AccountSheet: (c) => strOrNull(c.selected),
  PaymentChips: (c) => strOrNull(c.selected) && Array.isArray(c.options) && c.options.length <= 8 && c.options.every((o) => isRec(o) && str(o.id) && str(o.label)),
  DecisionBar: (c) => Array.isArray(c.actions) && c.actions.every(str),
};

// surface から描画する部品だけを返す。DecisionBar の知らない操作は落とす。
export function renderableComponents(surface: unknown): Component[] {
  if (!isRec(surface) || surface.catalogId !== CATALOG_ID || !Array.isArray(surface.components)) return [];
  const out: Component[] = [];
  for (const c of surface.components) {
    if (!isRec(c) || !str(c.id) || !str(c.component) || !Object.hasOwn(CHECKS, c.component)) continue;
    const name = c.component as ComponentName;
    if (!CHECKS[name](c)) continue;
    if (name === 'DecisionBar') {
      const actions = (c.actions as string[]).filter((a): a is DecisionAction => (DECISION_ACTIONS as readonly string[]).includes(a));
      out.push({ id: c.id, component: 'DecisionBar', actions });
      continue;
    }
    out.push(c as unknown as Component);
  }
  return out;
}

export function findComponent<N extends ComponentName>(list: readonly Component[], name: N): Extract<Component, { component: N }> | undefined {
  return list.find((c) => c.component === name) as Extract<Component, { component: N }> | undefined;
}
