// 確定（docs/mvp-plan.md T2-8、mvp-plan-v0.1.md T2-8・U8、a2ui-review-ui.md §3.6）。
// - 送られた値はサーバーで再検証する（enum・形式・金額の整合）。送られなかった項目はカードの値のまま（U8: 差分なしの 1 タップ確定）。
// - reviews に新しい版を追記し、各項目の出所を field_sources_json に入れる（カードの値のままなら カードの出所、変えたら human）。
// - audit に人の確定として残す（変更なしは user.confirmed、変えた項目があれば user.overrode。changed に項目名）。
// - documents.status を approved / personal / duplicate / rejected にする。needs_attention のときは残す（要対応を消さない）。
// - approve では、取引ビルダ（src/deals/builder.ts）が拒否する入力を 422 not_sendable で止める（messages に人が直せる文）。
//   税率の区分（tax_id）を変えて内訳が 1 行なら、内訳の区分もそれに揃える（複数行なら内訳を直してもらう）。
// - approve のときだけ jobs に update_receipt_meta と send_deal を積む（ハンドラは別担当）。
// - approve と personal は取引先の辞書を学習する（src/review/learn.ts）。
// - approve で integrity_checked: true なら、同じトランザクションで documents.integrity_checked_at を入れる（T004、legal R9）。
//   scan だけ。一度入れたら変えない（NULL のときだけ書く）。書いたら audit に document.integrity_checked。
// - 確定の後（トランザクションの外）に明細 ⇔ 証憑の照合を動かす（src/bank/match.ts の runMatchingSafe。失敗しても確定は済んでいる）。
import { appendAudit } from '../audit.ts';
import { runMatchingSafe, type MatchWindows } from '../bank/match.ts';
import { checkInvoiceRegNo, sanitizeText } from '../ai/validate.ts';
import { tx, type Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';
import { enqueue } from '../jobs/queue.ts';
import { enabledAccounts, loadAccountMap, type AccountMap } from '../masters/accounts.ts';
import { TAX_CATEGORIES, type TaxCategory } from '../masters/tax-map.ts';
import { getStoredCard, type StoredCard } from './card.ts';
import {
  FIELDS,
  PROVIDER,
  paymentOptions,
  REQUIRED_FOR_APPROVE,
  TEXT_MAX,
  toStoredTaxRows,
  type Field,
  type FieldSource,
  type Sources,
  type TaxRow,
  type Values,
} from './fields.ts';
import { learnFromReview, type LearnResult } from './learn.ts';

export const DECISIONS = ['approve', 'personal', 'duplicate', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];

export const STATUS_OF: Record<Decision, string> = { approve: 'approved', personal: 'personal', duplicate: 'duplicate', reject: 'rejected' };
export const JOBS_ON_APPROVE = ['update_receipt_meta', 'send_deal'] as const;
const MAX_AMOUNT = 1_000_000_000_000; // 1 兆円未満（桁あふれの防止だけ）

export class ReviewError extends Error {
  readonly status: 400 | 404 | 409 | 422;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
  constructor(status: 400 | 404 | 409 | 422, reason: string, detail: Record<string, unknown> = {}) {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

const isTax = (v: unknown): v is TaxCategory => typeof v === 'string' && (TAX_CATEGORIES as readonly string[]).includes(v);
function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type ValidateContext = { accountIds: ReadonlySet<string>; paymentIds: ReadonlySet<string> };

// 1 項目ずつ検証して直した値を返す。直せないものは errors に入れる（呼び出し側で 422）。
export function validateValues(input: unknown, base: Values, ctx: ValidateContext): { values: Values; given: Set<Field>; errors: string[] } {
  const errors: string[] = [];
  const given = new Set<Field>();
  const v: Values = structuredClone(base);
  if (input === undefined || input === null) return { values: v, given, errors };
  if (typeof input !== 'object' || Array.isArray(input)) return { values: v, given, errors: ['values: オブジェクトではない'] };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(FIELDS as readonly string[]).includes(k)) errors.push(`values.${k}: 未知の項目`);
  const has = (f: Field) => Object.hasOwn(o, f);
  const text = (f: 'vendor' | 'memo', max: number) => {
    const x = o[f];
    if (x === null) v[f] = null;
    else if (typeof x !== 'string') errors.push(`values.${f}: 文字列か null ではない`);
    else {
      const t = sanitizeText(x, max).text;
      v[f] = t === '' ? null : t;
    }
  };

  for (const f of FIELDS) {
    if (!has(f)) continue;
    given.add(f);
    const x = o[f];
    switch (f) {
      case 'txn_date':
        if (x === null) v.txn_date = null;
        else if (typeof x === 'string' && isDate(x)) v.txn_date = x;
        else errors.push('values.txn_date: YYYY-MM-DD ではない');
        break;
      case 'amount':
        if (x === null) v.amount = null;
        else if (Number.isSafeInteger(x) && (x as number) >= 1 && (x as number) < MAX_AMOUNT) v.amount = x as number;
        else errors.push('values.amount: 正の整数ではない');
        break;
      case 'tax_by_rate': {
        if (!Array.isArray(x) || x.length > TAX_CATEGORIES.length) {
          errors.push(`values.tax_by_rate: ${TAX_CATEGORIES.length} 行までの配列ではない`);
          break;
        }
        const rows: TaxRow[] = [];
        x.forEach((r: unknown, i: number) => {
          const e = r as Record<string, unknown>;
          const ok =
            typeof e === 'object' && e !== null && isTax(e.category) &&
            Number.isSafeInteger(e.amount_incl_tax) && (e.amount_incl_tax as number) >= 0 &&
            Number.isSafeInteger(e.tax) && (e.tax as number) >= 0 &&
            Object.keys(e).every((k) => ['category', 'amount_incl_tax', 'tax'].includes(k));
          if (!ok) errors.push(`values.tax_by_rate[${i}]: {category, amount_incl_tax, tax} ではない`);
          else rows.push({ category: e.category as TaxCategory, amount_incl_tax: e.amount_incl_tax as number, tax: e.tax as number });
        });
        if (new Set(rows.map((r) => r.category)).size !== rows.length) errors.push('values.tax_by_rate: 区分が重複している');
        v.tax_by_rate = rows;
        break;
      }
      case 'vendor':
        text('vendor', TEXT_MAX.vendor);
        break;
      case 'memo':
        text('memo', TEXT_MAX.memo);
        break;
      case 'invoice_reg_no':
        if (x === null || x === '') v.invoice_reg_no = null;
        else if (typeof x !== 'string') errors.push('values.invoice_reg_no: 文字列か null ではない');
        else {
          const r = checkInvoiceRegNo(x);
          if (r.error) errors.push(`values.invoice_reg_no: ${r.error === 'format' ? 'T + 13 桁ではない' : '検査数字が合わない'}`);
          else v.invoice_reg_no = r.value;
        }
        break;
      case 'qualified_invoice':
        if (typeof x === 'boolean') v.qualified_invoice = x;
        else errors.push('values.qualified_invoice: 真偽値ではない');
        break;
      case 'account_id':
        if (x === null) v.account_id = null;
        else if (typeof x === 'string' && ctx.accountIds.has(x)) v.account_id = x;
        else errors.push('values.account_id: 選べる科目ではない');
        break;
      case 'tax_id':
        if (x === null) v.tax_id = null;
        else if (isTax(x)) v.tax_id = x;
        else errors.push('values.tax_id: 税率の区分ではない');
        break;
      case 'payment':
        if (x === null) v.payment = null;
        else if (typeof x === 'string' && ctx.paymentIds.has(x)) v.payment = x;
        else errors.push('values.payment: 選べる支払手段ではない');
        break;
      case 'proration_pct':
        if (Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= 100) v.proration_pct = x as number;
        else errors.push('values.proration_pct: 0〜100 の整数ではない');
        break;
    }
  }
  // 登録番号を消したら（送らずに）適格の扱いも外す。登録番号なしの適格は矛盾。
  if (given.has('invoice_reg_no') && !given.has('qualified_invoice')) v.qualified_invoice = v.invoice_reg_no !== null;
  if (v.qualified_invoice && v.invoice_reg_no === null) errors.push('values.qualified_invoice: 登録番号が無いのに適格になっている');
  return { values: v, given, errors };
}

export function missingForApprove(v: Values): Field[] {
  return REQUIRED_FOR_APPROVE.filter((f) => v[f] === null);
}

// 税率の区分を変えたら、内訳が 1 行のときはその区分に揃える。複数行で内訳を送っていなければ直してもらう（approve だけ）。
export function alignTaxRows(card: Values, v: Values, given: ReadonlySet<Field>): string[] {
  if (!given.has('tax_id') || v.tax_id === null || v.tax_id === card.tax_id || v.tax_by_rate.length === 0) return [];
  if (v.tax_by_rate.length === 1) {
    v.tax_by_rate = [{ ...v.tax_by_rate[0], category: v.tax_id }];
    return [];
  }
  if (given.has('tax_by_rate')) return [];
  return ['税率の区分を変えましたが、税率別の内訳が複数行あります。内訳を直してください。'];
}

// 取引ビルダが拒否する入力（approve だけ。内訳が空なら合計だけで送れる）。
export function sendableErrors(v: Values): string[] {
  const out: string[] = [];
  v.tax_by_rate.forEach((r, i) => {
    if (r.amount_incl_tax <= 0) out.push(`税率別の内訳 ${i + 1} 行目の金額が 0 円です。金額を入れるか、その行を消してください。`);
  });
  if (v.amount !== null && v.tax_by_rate.length) {
    const sum = v.tax_by_rate.reduce((a, r) => a + r.amount_incl_tax, 0);
    if (sum !== v.amount) out.push(`税率別の内訳の合計（${sum} 円）が支払金額（${v.amount} 円）と合いません。どちらかを直してください。`);
  }
  if (!Number.isSafeInteger(v.proration_pct) || v.proration_pct < 0 || v.proration_pct > 100) out.push('按分は 0〜100 の整数（%）で入れてください。');
  return out;
}

// 合計と税率別の内訳の和（内訳があるときだけ）。食い違いは警告（approve 以外は拒否しない）。
export function amountWarnings(v: Values): string[] {
  if (v.amount === null || v.tax_by_rate.length === 0) return [];
  const sum = v.tax_by_rate.reduce((a, r) => a + r.amount_incl_tax, 0);
  return sum === v.amount ? [] : ['amount_mismatch'];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// カードの値から変えた項目と、確定後の各項目の出所。
export function diffSources(card: Values, cardSources: Sources, final: Values): { changed: Field[]; sources: Sources } {
  const changed: Field[] = [];
  const sources = {} as Sources;
  for (const f of FIELDS) {
    const unchanged = same(card[f], final[f]);
    if (!unchanged) changed.push(f);
    const s: FieldSource | null = unchanged ? cardSources[f] : 'human';
    sources[f] = final[f] === null ? null : (s ?? 'human');
  }
  return { changed, sources };
}

export type DecideInput = {
  documentId: string;
  decision: Decision;
  body: unknown;
  user: string | null;
  now: Date;
  accountMap?: AccountMap;
  // 照合の日付の幅（[bank]。省略時は既定値）。
  matchWindows?: MatchWindows;
};

export type DecideResult = {
  review_id: string;
  version: number;
  decision: Decision;
  status: string;
  changed: Field[];
  warnings: string[];
  jobs: string[];
  learned: LearnResult | null;
};

type Body = { card_id?: unknown; expected_version?: unknown; values?: unknown; integrity_checked?: unknown };

export function decide(db: Db, input: DecideInput): DecideResult {
  const body = (typeof input.body === 'object' && input.body !== null && !Array.isArray(input.body) ? input.body : null) as Body | null;
  if (!body) throw new ReviewError(400, 'invalid_body');
  for (const k of Object.keys(body)) if (!['card_id', 'expected_version', 'values', 'integrity_checked'].includes(k)) throw new ReviewError(400, 'invalid_body', { field: k });
  if (typeof body.card_id !== 'string' || !body.card_id) throw new ReviewError(400, 'card_id_required');
  if (!Number.isSafeInteger(body.expected_version) || (body.expected_version as number) < 0) throw new ReviewError(400, 'expected_version_required');
  if (body.integrity_checked !== undefined && typeof body.integrity_checked !== 'boolean') throw new ReviewError(400, 'invalid_body', { field: 'integrity_checked' });

  const doc = db.prepare('SELECT id, status, kind FROM documents WHERE id = ?').get(input.documentId) as { id: string; status: string; kind: string } | undefined;
  if (!doc) throw new ReviewError(404, 'not_found');
  const stored: StoredCard | null = getStoredCard(db, body.card_id);
  if (!stored || stored.document_id !== doc.id) throw new ReviewError(400, 'unknown_card');

  const { accounts } = enabledAccounts(db, PROVIDER, input.accountMap ?? loadAccountMap());
  const ctx: ValidateContext = { accountIds: new Set(accounts.map((a) => a.id)), paymentIds: new Set(paymentOptions(db).map((p) => p.id)) };
  const cardValues = stored.card.dataModel.values;
  const { values, given, errors } = validateValues(body.values, cardValues, ctx);
  if (errors.length) throw new ReviewError(422, 'invalid_values', { errors });

  // 私用は事業主貸（税は対象外）。対応表に事業主貸が無ければ科目は空のまま。
  if (input.decision === 'personal') {
    const priv = accounts.find((a) => a.private);
    values.account_id = priv?.id ?? null;
    values.tax_id = 'out_of_scope';
  }
  if (input.decision === 'approve') {
    const missing = missingForApprove(values);
    if (missing.length) throw new ReviewError(422, 'missing_required', { fields: missing });
    const messages = [...alignTaxRows(cardValues, values, given), ...sendableErrors(values)];
    if (messages.length) throw new ReviewError(422, 'not_sendable', { messages });
  }
  const warnings = amountWarnings(values);
  const { changed, sources } = diffSources(cardValues, stored.card.dataModel.sources, values);

  const res = tx(db, () => {
    const cur = (db.prepare('SELECT max(version) v FROM reviews WHERE document_id = ?').get(doc.id) as { v: number | null }).v ?? 0;
    if (cur !== body.expected_version) throw new ReviewError(409, 'version_conflict', { current_version: cur });
    const card = db.prepare('SELECT status FROM ui_cards WHERE id = ?').get(stored.id) as { status: string };
    if (card.status !== 'open') throw new ReviewError(409, 'stale_card', { card_status: card.status });

    const version = cur + 1;
    const id = ulid(input.now.getTime());
    const iso = input.now.toISOString();
    db.prepare(
      `INSERT INTO reviews (id, document_id, version, txn_date, amount, vendor, account_id, tax_id, credit_account, memo, decision,
         field_sources_json, based_on_ai_turn_id, decided_at, proration_pct, tax_by_rate_json, invoice_reg_no, qualified_invoice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, doc.id, version, values.txn_date, values.amount, values.vendor, values.account_id, values.tax_id, values.payment, values.memo,
      input.decision, JSON.stringify(sources), stored.ai_turn_id, iso, values.proration_pct,
      values.tax_by_rate.length ? JSON.stringify(toStoredTaxRows(values.tax_by_rate)) : null, values.invoice_reg_no, values.qualified_invoice ? 1 : 0,
    );
    db.prepare(`UPDATE ui_cards SET status = 'answered' WHERE id = ?`).run(stored.id);

    const next = doc.status === 'needs_attention' ? doc.status : STATUS_OF[input.decision];
    if (next !== doc.status) db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(next, doc.id);

    appendAudit(
      db,
      {
        actor: 'user',
        action: changed.length ? 'user.overrode' : 'user.confirmed',
        entity: 'document',
        entityId: doc.id,
        payload: {
          review_id: id,
          version,
          decision: input.decision,
          user: input.user,
          card_id: stored.id,
          based_on_ai_turn_id: stored.ai_turn_id,
          unchanged: changed.length === 0,
          changed,
          values,
          field_sources: sources,
          warnings,
          status: { from: doc.status, to: next },
        },
      },
      input.now,
    );

    // 同等確認（scan だけ。e_transaction は無視する）。一度入った時刻は上書きしない。
    if (input.decision === 'approve' && body.integrity_checked === true && doc.kind === 'scan') {
      const r = db.prepare('UPDATE documents SET integrity_checked_at = ? WHERE id = ? AND integrity_checked_at IS NULL').run(iso, doc.id);
      if (r.changes === 1) {
        appendAudit(db, { actor: 'user', action: 'document.integrity_checked', entity: 'document', entityId: doc.id, payload: { document_id: doc.id } }, input.now);
      }
    }

    const jobs: string[] = [];
    if (input.decision === 'approve') {
      for (const k of JOBS_ON_APPROVE) {
        enqueue(db, k, doc.id, { now: input.now });
        jobs.push(k);
      }
    }

    const learned =
      input.decision === 'approve' || input.decision === 'personal'
        ? learnFromReview(db, { documentId: doc.id, reviewId: id, values, proposedAccountId: stored.card.dataModel.proposed.account_id, now: input.now })
        : null;

    return { review_id: id, version, decision: input.decision, status: next, changed, warnings, jobs, learned };
  });
  runMatchingSafe(db, input.now, { windows: input.matchWindows });
  return res;
}
