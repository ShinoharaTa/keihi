// 確認カードの surface（docs/mvp-plan.md T2-7、mvp-plan-v0.1.md T2-7、a2ui-review-ui.md §2.1・§3.1・§3.6）。
// extractions・classifications・取引先の辞書から、keihi.catalog/v1 の固定部品だけでカードを組み立てる。
// - surface（{catalogId, surfaceId, components}）はカタログのスキーマに適合させる（組み立て後に検証し、合わなければ例外）。
// - 部品に入らない情報（各項目の値・出所・版・科目の一覧・残り営業日）は dataModel に入れる。
// - 質問（extractions.raw_json の questions[]）は MVP では描画しないので入れない。
// - 科目候補は辞書（いま引いた vendor_rules → 抽出時の classifications source=rule）を先頭に、残りを確信度の高い順。
//   enabled_accounts に無い科目は捨てる。上位 3 件。
// - 画像は ReceiptThumb の document_id だけ（PWA が /api/documents/:id/thumbnail を引く。URL は持たない）。
// - 確定の版があれば、値と出所はその版から始める（訂正のため）。科目候補は AI・辞書のまま。
// - ui_cards に保存し、内容が前回の open と同じなら使い回す。日々変わる値（documents.status・残り営業日）は保存も比較もせず、
//   表示用に API 応答で付け足す（日付が変わっただけで別のカードにしない。LIVE_FIELDS）。新しく作ったら前の open を superseded にし、
//   AI（または辞書）の提案として audit に ai.proposed を残す（actor = 提案者 ai | dictionary）。確定の版から作ったカードは提案ではないので残さない。
import { readFileSync } from 'node:fs';
import { appendAudit, canonicalJson } from '../audit.ts';
import { sanitizeText, validateSchema, checkInvoiceRegNo } from '../ai/validate.ts';
import type { Schema } from '../ai/gemini/schema.ts';
import { todayInTokyo, type CalendarOptions } from '../calendar/businessDays.ts';
import { tx, type Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';
import { enabledAccounts, loadAccountMap, type AccountMap, type EnabledAccount } from '../masters/accounts.ts';
import { TAX_CATEGORIES, type TaxCategory } from '../masters/tax-map.ts';
import { lookupVendor } from '../vendors/dictionary.ts';
import {
  CATALOG_ID,
  FIELDS,
  fromExtractionTaxRows,
  fromStoredTaxRows,
  PROVIDER,
  paymentChipOptions,
  paymentOptions,
  TEXT_MAX,
  type FieldSource,
  type Sources,
  type Values,
} from './fields.ts';
import { businessDaysLeft } from './list.ts';

export const CATALOG = JSON.parse(readFileSync(new URL('../catalog/keihi.catalog.v1.schema.json', import.meta.url), 'utf8')) as Schema;
export const MAX_ACCOUNT_CHIPS = 3;
export const CARD_KIND = 'review';
const DECISION_ACTIONS = ['approve', 'personal', 'duplicate'] as const; // hold は実装しない（reviews.decision に無い）

export type Candidate = { account_id: string; name: string; tax_id: TaxCategory; confidence: number; source: 'dictionary' | 'ai' };

export type Surface = { catalogId: typeof CATALOG_ID; surfaceId: string; components: Record<string, unknown>[] };

export type DataModel = {
  document_id: string;
  status: string;
  kind: string;
  no_ai: boolean;
  paper_required: boolean;
  deadline_on: string;
  days_left: number;
  version: number; // 確定の最新版（無ければ 0）。確定 API の expected_version
  ai_turn_id: string | null;
  values: Values;
  sources: Sources;
  proposed: Values; // AI・辞書・OCR の提案（確定の版から作ったときもこちらは提案のまま）
  candidates: Candidate[];
  accounts: { id: string; name: string; private: boolean }[];
  warnings: string[];
  integrity_checked?: boolean; // 同等確認（欠け・折れ・裏面）のチェック。scan のときだけ置く（documents.integrity_checked_at があれば true。T004）
  integrity_checked_at?: string | null; // 同等確認の時刻（ISO）。scan のときだけ置く。入っていれば PWA はチェックを外せない形で出す
};

// 保存・比較しない（日々変わる）項目。
export const LIVE_FIELDS = ['status', 'days_left'] as const;
export type StoredDataModel = Omit<DataModel, (typeof LIVE_FIELDS)[number]>;

export function storedDataModel(dm: DataModel): StoredDataModel {
  const { status: _s, days_left: _d, ...rest } = dm;
  return rest;
}

export type Card = { surface: Surface; dataModel: DataModel; proposer: 'ai' | 'dictionary' | null };

type DocRow = { id: string; status: string; kind: string; no_ai: number; paper_required: number; deadline_on: string; integrity_checked_at: string | null };
type ExtractionRow = {
  id: string;
  raw_json: string;
  txn_date: string | null;
  amount_total: number | null;
  tax_by_rate_json: string | null;
  vendor_name: string | null;
  invoice_reg_no: string | null;
};
type ReviewRow = {
  version: number;
  txn_date: string | null;
  amount: number | null;
  vendor: string | null;
  account_id: string | null;
  tax_id: string | null;
  credit_account: string | null;
  memo: string | null;
  field_sources_json: string | null;
  proration_pct: number;
  tax_by_rate_json: string | null;
  invoice_reg_no: string | null;
  qualified_invoice: number | null;
};

export type CardOptions = { now: Date; calendar?: CalendarOptions; accountMap?: AccountMap };

const isTax = (v: unknown): v is TaxCategory => typeof v === 'string' && (TAX_CATEGORIES as readonly string[]).includes(v);
const isDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const cleanText = (s: string | null, max: number): string | null => {
  if (s === null) return null;
  const t = sanitizeText(s, max).text;
  return t === '' ? null : t;
};
const regNo = (s: string | null): string | null => (s === null ? null : checkInvoiceRegNo(s).value);

function parseCandidates(json: string): { account_id: string; tax_id: TaxCategory; confidence: number }[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).flatMap((c) => {
    if (typeof c !== 'object' || c === null || typeof c.account_id !== 'string' || !isTax(c.tax_id)) return [];
    const conf = typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1 ? c.confidence : 0;
    return [{ account_id: c.account_id, tax_id: c.tax_id, confidence: conf }];
  });
}

// 辞書を先頭に（いま引いた辞書 → classifications の rule）、残りを確信度の高い順。科目で重複を除き、上位 3 件。
export function rankCandidates(
  dictionary: Omit<Candidate, 'name'>[],
  others: Omit<Candidate, 'name'>[],
  accounts: readonly EnabledAccount[],
): Candidate[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const sorted = [...others].sort((a, b) => b.confidence - a.confidence);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of [...dictionary, ...sorted]) {
    const a = byId.get(c.account_id);
    if (!a || seen.has(c.account_id)) continue;
    seen.add(c.account_id);
    out.push({ ...c, name: [...a.name].slice(0, TEXT_MAX.account_name).join('') });
    if (out.length === MAX_ACCOUNT_CHIPS) break;
  }
  return out;
}

function emptySources(): Sources {
  return Object.fromEntries(FIELDS.map((f) => [f, null])) as Sources;
}

export function buildCard(db: Db, documentId: string, opts: CardOptions): Card | null {
  const doc = db.prepare('SELECT id, status, kind, no_ai, paper_required, deadline_on, integrity_checked_at FROM documents WHERE id = ?').get(documentId) as DocRow | undefined;
  if (!doc) return null;
  const { accounts } = enabledAccounts(db, PROVIDER, opts.accountMap ?? loadAccountMap());
  const ex = db
    .prepare('SELECT id, raw_json, txn_date, amount_total, tax_by_rate_json, vendor_name, invoice_reg_no FROM extractions WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(documentId) as ExtractionRow | undefined;
  const turn = db.prepare(`SELECT id FROM ai_turns WHERE document_id = ? AND role = 'ai' ORDER BY seq DESC LIMIT 1`).get(documentId) as { id: string } | undefined;
  const warnings: string[] = [];

  // ---- OCR（抽出）の値 ----
  const proposed: Values = {
    txn_date: null,
    amount: null,
    tax_by_rate: [],
    vendor: null,
    invoice_reg_no: null,
    qualified_invoice: false,
    account_id: null,
    tax_id: null,
    payment: null,
    proration_pct: 100,
    memo: null,
  };
  const sources = emptySources();
  const ocr = (f: keyof Values, v: unknown) => {
    if (v !== null && !(Array.isArray(v) && v.length === 0)) sources[f] = 'ocr';
  };
  if (ex) {
    proposed.txn_date = isDate(ex.txn_date) ? ex.txn_date : null;
    proposed.amount = Number.isSafeInteger(ex.amount_total) && (ex.amount_total as number) >= 1 ? ex.amount_total : null;
    proposed.tax_by_rate = fromExtractionTaxRows(ex.tax_by_rate_json);
    proposed.vendor = cleanText(ex.vendor_name, TEXT_MAX.vendor);
    proposed.invoice_reg_no = regNo(ex.invoice_reg_no);
    proposed.qualified_invoice = proposed.invoice_reg_no !== null;
    for (const f of ['txn_date', 'amount', 'tax_by_rate', 'vendor', 'invoice_reg_no'] as const) ocr(f, proposed[f]);
    if (proposed.invoice_reg_no !== null) sources.qualified_invoice = 'ocr';
    if (proposed.amount !== null && proposed.tax_by_rate.length) {
      const sum = proposed.tax_by_rate.reduce((a, r) => a + r.amount_incl_tax, 0);
      if (sum !== proposed.amount) warnings.push('amount_mismatch');
    }
  }

  // ---- 科目候補 ----
  const hit = proposed.vendor || proposed.invoice_reg_no ? lookupVendor(db, { name: proposed.vendor, invoiceRegNo: proposed.invoice_reg_no }) : null;
  const dict: Omit<Candidate, 'name'>[] = [];
  if (hit?.accountId && isTax(hit.taxCategory)) {
    dict.push({ account_id: hit.accountId, tax_id: hit.taxCategory, confidence: hit.confidence ?? 1, source: 'dictionary' });
  }
  const others: Omit<Candidate, 'name'>[] = [];
  if (ex) {
    const cls = db.prepare('SELECT source, candidates_json FROM classifications WHERE extraction_id = ? ORDER BY created_at, id').all(ex.id) as { source: string; candidates_json: string }[];
    for (const c of cls) {
      const list = parseCandidates(c.candidates_json);
      if (c.source === 'rule') dict.push(...list.map((x) => ({ ...x, source: 'dictionary' as const })));
      else others.push(...list.map((x) => ({ ...x, source: 'ai' as const })));
    }
  }
  const candidates = rankCandidates(dict, others, accounts);
  const top = candidates[0];
  if (top) {
    proposed.account_id = top.account_id;
    proposed.tax_id = top.tax_id;
    sources.account_id = top.source;
    sources.tax_id = top.source;
  }

  // ---- 支払手段（辞書にあればそれ。無ければ未選択） ----
  const payments = paymentOptions(db);
  if (hit?.creditAccount && payments.some((p) => p.id === hit.creditAccount)) {
    proposed.payment = hit.creditAccount;
    sources.payment = 'dictionary';
  }

  // ---- 確定の版があれば、そこから始める ----
  const rv = db
    .prepare(
      `SELECT version, txn_date, amount, vendor, account_id, tax_id, credit_account, memo, field_sources_json,
         proration_pct, tax_by_rate_json, invoice_reg_no, qualified_invoice
       FROM reviews WHERE document_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(documentId) as ReviewRow | undefined;
  let values: Values = proposed;
  let valueSources: Sources = sources;
  if (rv) {
    values = {
      txn_date: isDate(rv.txn_date) ? rv.txn_date : null,
      amount: rv.amount,
      tax_by_rate: fromStoredTaxRows(rv.tax_by_rate_json),
      vendor: rv.vendor,
      invoice_reg_no: rv.invoice_reg_no,
      qualified_invoice: rv.qualified_invoice === 1,
      account_id: rv.account_id,
      tax_id: isTax(rv.tax_id) ? rv.tax_id : null,
      payment: rv.credit_account,
      proration_pct: rv.proration_pct,
      memo: rv.memo,
    };
    valueSources = { ...emptySources(), ...parseSources(rv.field_sources_json) };
  }

  const surfaceId = `review-${doc.id}`.slice(0, 64);
  const components: Record<string, unknown>[] = [
    { id: 'thumb', component: 'ReceiptThumb', document_id: doc.id },
    { id: 'amount', component: 'AmountField', total: values.amount, by_rate: values.tax_by_rate },
    { id: 'date', component: 'DateField', value: values.txn_date },
    { id: 'vendor', component: 'VendorField', name: values.vendor, invoice_reg_no: values.invoice_reg_no },
    {
      id: 'accounts',
      component: 'AccountChips',
      candidates: candidates.map((c) => ({ account_id: c.account_id, name: c.name, tax_id: c.tax_id, confidence: c.confidence })),
      selected: values.account_id,
    },
    { id: 'account_sheet', component: 'AccountSheet', selected: values.account_id },
    { id: 'payment', component: 'PaymentChips', options: paymentChipOptions(payments, values.payment), selected: values.payment },
    { id: 'decision', component: 'DecisionBar', actions: [...DECISION_ACTIONS] },
  ];
  const surface: Surface = { catalogId: CATALOG_ID, surfaceId, components };
  const errs = validateSchema(CATALOG, surface);
  if (errs.length) throw new Error(`確認カードがカタログに適合しない: ${errs.slice(0, 5).join(' / ')}`);

  const latest = rv?.version ?? 0;
  const dataModel: DataModel = {
    document_id: doc.id,
    status: doc.status,
    kind: doc.kind,
    no_ai: doc.no_ai === 1,
    paper_required: doc.paper_required === 1,
    deadline_on: doc.deadline_on,
    days_left: businessDaysLeft(todayInTokyo(opts.now), doc.deadline_on, opts.calendar ?? {}),
    version: latest,
    ai_turn_id: turn?.id ?? null,
    values,
    sources: valueSources,
    proposed,
    candidates,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, private: a.private })),
    warnings,
    ...(doc.kind === 'scan' ? { integrity_checked: doc.integrity_checked_at !== null, integrity_checked_at: doc.integrity_checked_at } : {}),
  };
  const proposer = rv ? null : top ? top.source : ex ? 'ai' : null;
  return { surface, dataModel, proposer };
}

export function parseSources(json: string | null): Partial<Sources> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Partial<Sources> = {};
    for (const f of FIELDS) {
      const v = o[f];
      if (typeof v === 'string' && (['ocr', 'ai', 'dictionary', 'human', 'agent'] as const).includes(v as FieldSource)) out[f] = v as FieldSource;
    }
    return out;
  } catch {
    return {};
  }
}

export type StoredCard = { id: string; document_id: string; ai_turn_id: string | null; status: string; card: { surface: Surface; dataModel: StoredDataModel } };

export function getStoredCard(db: Db, cardId: string): StoredCard | null {
  const r = db.prepare('SELECT id, document_id, ai_turn_id, status, card_json FROM ui_cards WHERE id = ? AND kind = ?').get(cardId, CARD_KIND) as
    | { id: string; document_id: string; ai_turn_id: string | null; status: string; card_json: string }
    | undefined;
  if (!r) return null;
  return { id: r.id, document_id: r.document_id, ai_turn_id: r.ai_turn_id, status: r.status, card: JSON.parse(r.card_json) };
}

// カードを組み立てて ui_cards に保存する（同じ内容の open があれば使い回す）。
export function openCard(db: Db, documentId: string, opts: CardOptions): { cardId: string; created: boolean; card: Card } | null {
  const card = buildCard(db, documentId, opts);
  if (!card) return null;
  const json = canonicalJson({ surface: card.surface, dataModel: storedDataModel(card.dataModel) });
  return tx(db, () => {
    const open = db
      .prepare(`SELECT id, card_json FROM ui_cards WHERE document_id = ? AND kind = ? AND status = 'open' ORDER BY id DESC`)
      .all(documentId, CARD_KIND) as { id: string; card_json: string }[];
    const same = open.find((o) => o.card_json === json);
    if (same) return { cardId: same.id, created: false, card };
    db.prepare(`UPDATE ui_cards SET status = 'superseded' WHERE document_id = ? AND kind = ? AND status = 'open'`).run(documentId, CARD_KIND);
    const id = ulid(opts.now.getTime());
    db.prepare(`INSERT INTO ui_cards (id, document_id, ai_turn_id, kind, card_json, status) VALUES (?, ?, ?, ?, ?, 'open')`).run(
      id,
      documentId,
      card.dataModel.ai_turn_id,
      CARD_KIND,
      json,
    );
    if (card.proposer) {
      appendAudit(
        db,
        {
          actor: card.proposer,
          action: 'ai.proposed',
          entity: 'document',
          entityId: documentId,
          payload: {
            card_id: id,
            proposer: card.proposer,
            ai_turn_id: card.dataModel.ai_turn_id,
            values: card.dataModel.proposed,
            sources: card.dataModel.sources,
            candidates: card.dataModel.candidates,
            warnings: card.dataModel.warnings,
          },
        },
        opts.now,
      );
    }
    return { cardId: id, created: true, card };
  });
}
