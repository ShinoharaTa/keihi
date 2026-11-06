// freee 会計の Provider（docs/mvp-plan.md T1-10、freee-codex.md §5.3）。src/providers/types.ts の Provider を実装する。
// - トークンは <data_dir>/freee-token.json（0600）。更新は <data_dir>/freee-token.lock で web と worker の間で排他（auth.ts）。
// - HTTP の 1 回ごとに予算（budget.ts）を通し、freee_calls に記録する。トークンの更新は用途 auth で数える。
// - リクエストは 1 本ずつ。/receipts/{id}/download は 1 秒 3 回まで。
// - invalid_grant・トークンが無いときは settings.freee_reauth_required = 1 にして、以降は freee を呼ばずに
//   auth_invalid_grant を返す（`keihi freee auth` で戻す）。
// - 送るボディの形は test/contracts/freee-openapi.json（公式の OpenAPI の抜き出し）に合わせる（契約テスト）。
// - 例外のメッセージにはトークン・secret・freee の応答本文を入れない（ステータスと request_id だけ）。
import path from 'node:path';
import { addDays, todayInTokyo } from '../../calendar/businessDays.ts';
import type { Db } from '../../db/index.ts';
import {
  ProviderError,
  type BankTxn,
  type Capabilities,
  type CreateExpenseDealInput,
  type CreateRuleInput,
  type Deal,
  type DealDetail,
  type DocumentType,
  type ListBankTxnsQuery,
  type ListDealsQuery,
  type Masters,
  type Provider,
  type ProviderErrorKind,
  type QualifiedInvoice,
  type Receipt,
  type ReceiptMeta,
  type Rule,
  type RuleAction,
  type UploadReceiptInput,
  type WalletableType,
} from '../types.ts';
import { FreeeAuthError, TOKEN_URL, TokenStore, createTokenProvider, type ClientCredentials } from './auth.ts';
import { BudgetExceededError, DEFAULT_PURPOSES, budgetedFetch, createBudget, type Budget, type ProviderMethod, type Purpose } from './budget.ts';
import { DOWNLOAD_LIMIT, FreeeGuardError, FreeeNetworkError, createFreeeClient, type ApiResponse, type Method, type Query, type RequestOptions } from './client.ts';
import { isReauthRequired, setReauthRequired } from './state.ts';

export const PROVIDER_NAME = 'freee';
// POST /receipts は 64MB まで [FR-OA]。
export const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
export const FREEE_CAPABILITIES: Capabilities = {
  receiptMetaOnUpload: true,
  canLinkExistingReceipt: true,
  canReconcileTxn: false,
  maxReceiptBytes: MAX_RECEIPT_BYTES,
};
// findReceiptsByKey に期間を渡さなかったときに探すアップロード日の範囲（今日から遡る日数）。
export const RECEIPT_LOOKBACK_DAYS = 30;
const RECEIPTS_PAGE = 3000; // GET /receipts の limit の上限
const PAGE = 100; // deals・wallet_txns・user_matchers の limit の上限

// user_matchers の act（freee-codex.md F12。プライベートを登録 = 12 は mvp-plan-v3.md T109）。
const ACT: Record<RuleAction, number> = { ignore: 4, private: 11, private_register: 12, deal: 0 };
const ACTION_OF = new Map<number, RuleAction>(Object.entries(ACT).map(([k, v]) => [v, k as RuleAction]));

export type DateRange = { startDate: string; endDate: string };

// findReceiptsByKey はアップロード日の範囲を受け取れる（GET /receipts は start_date・end_date が必須）。
// downloadReceipt は予算の用途を差し替えられる（既定は DEFAULT_PURPOSES の user。月 1 回の照合は sync）。
export type FreeeProvider = Provider & {
  findReceiptsByKey(key: string, range?: DateRange): Promise<Receipt[]>;
  downloadReceipt(id: number, o?: { purpose?: Purpose }): Promise<{ bytes: Buffer; mime: string }>;
};

export type FreeeProviderOptions = {
  db: Db;
  companyId: number;
  creds: ClientCredentials;
  tokenPath: string;
  lockPath?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  budget?: Budget;
  resetHourJst?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

// <data_dir> の下のトークンとロックのパス（mvp-plan.md §4.1）。
export function freeeTokenPaths(dataDir: string): { tokenPath: string; lockPath: string } {
  return { tokenPath: path.join(dataDir, 'freee-token.json'), lockPath: path.join(dataDir, 'freee-token.lock') };
}

export function kindOfStatus(status: number): ProviderErrorKind {
  if (status === 403) return 'usage_limited';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function metaFrom(r: Obj): ReceiptMeta {
  const m = obj(r.receipt_metadatum);
  const out: ReceiptMeta = {};
  const partnerName = str(m.partner_name);
  const issueDate = str(m.issue_date);
  const amount = num(m.amount);
  const documentType = str(r.document_type);
  const qualifiedInvoice = str(r.qualified_invoice);
  const reg = str(r.invoice_registration_number);
  if (partnerName !== null) out.partnerName = partnerName;
  if (issueDate !== null) out.issueDate = issueDate;
  if (amount !== null) out.amount = amount;
  if (documentType !== null) out.documentType = documentType as DocumentType;
  if (qualifiedInvoice !== null) out.qualifiedInvoice = qualifiedInvoice as QualifiedInvoice;
  if (reg !== null) out.invoiceRegistrationNumber = reg;
  return out;
}

// freee の receipt はファイル名・大きさ・取引との紐付けを返さない。分かっていれば fallback で補う（分からなければ '' / 0 / null）。
function receiptFrom(r: Obj, fallback: { fileName?: string; byteSize?: number } = {}): Receipt {
  return {
    id: num(r.id) ?? 0,
    key: str(r.description) ?? '',
    fileName: fallback.fileName ?? '',
    mime: str(r.mime_type) ?? '',
    byteSize: fallback.byteSize ?? 0,
    meta: metaFrom(r),
    dealId: null,
  };
}

function dealFrom(d: Obj): Deal {
  return {
    id: num(d.id) ?? 0,
    issueDate: str(d.issue_date) ?? '',
    refNumber: str(d.ref_number) ?? '',
    type: 'expense',
    settled: d.status === 'settled',
    amount: num(d.amount) ?? 0,
    details: arr(d.details).map((x) => {
      const o = obj(x);
      const det: DealDetail = { accountItemId: num(o.account_item_id) ?? 0, taxCode: num(o.tax_code) ?? 0, amount: num(o.amount) ?? 0 };
      const desc = str(o.description);
      if (desc) det.description = desc;
      return det;
    }),
    // freee の取引は partner_id だけを返す。名前は返さない。
    partnerName: null,
    receiptIds: arr(d.receipts).map((x) => num(obj(x).id)).filter((x): x is number => x !== null),
  };
}

function detailBody(d: DealDetail): Obj {
  const o: Obj = { account_item_id: d.accountItemId, tax_code: d.taxCode, amount: d.amount };
  if (d.description !== undefined) o.description = d.description;
  return o;
}

// PUT /deals/{id} は details を全部送り直す（含めない行は消える。freee-codex.md F9）。GET の行から更新に使える項目だけを写す。
const UPDATE_DETAIL_KEYS = [
  'id', 'tax_code', 'account_item_id', 'amount', 'item_id', 'section_id', 'partner_id', 'tag_ids',
  'segment_1_tag_id', 'segment_2_tag_id', 'segment_3_tag_id', 'description', 'vat',
] as const;

function updateDetailFrom(x: unknown): Obj {
  const o = obj(x);
  const out: Obj = {};
  for (const k of UPDATE_DETAIL_KEYS) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

export function createFreeeProvider(opts: FreeeProviderOptions): FreeeProvider {
  const { db, companyId } = opts;
  const now = opts.now ?? (() => new Date());
  const doFetch = opts.fetch ?? fetch;
  const budget = opts.budget ?? createBudget({ db, now, resetHourJst: opts.resetHourJst });
  const store = new TokenStore(opts.tokenPath, opts.lockPath ?? path.join(path.dirname(opts.tokenPath), 'freee-token.lock'));

  // トークンエンドポイントへの呼び出しも予算（auth）に通す。
  const authFetch = budgetedFetch(budget, 'auth', new URL(TOKEN_URL).pathname, doFetch);

  const tokens = createTokenProvider({ store, creds: opts.creds, fetch: authFetch, nowSec: () => Math.floor(now().getTime() / 1000) });
  const client = createFreeeClient({
    tokens,
    companyId,
    fetch: doFetch,
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    budget,
    serial: true,
    downloadLimit: DOWNLOAD_LIMIT,
    nowMs: () => now().getTime(),
    sleep: opts.sleep,
  });

  function reauth(message: string, status: number | null = null): ProviderError {
    setReauthRequired(db, true, now());
    return new ProviderError('auth_invalid_grant', message, { status });
  }

  let tokenChecked = false;
  async function ensureToken(): Promise<void> {
    if (tokenChecked) return;
    const t = await store.read();
    if (!t) throw reauth('freee のトークンが無い。keihi freee auth で認可する');
    if (t.company_id !== null && t.company_id !== companyId) {
      throw new ProviderError('client', `トークンの事業所（${t.company_id}）が設定の事業所（${companyId}）と違う。keihi freee auth で認可し直す`);
    }
    tokenChecked = true;
  }

  function toProviderError(e: unknown): unknown {
    if (e instanceof ProviderError || e instanceof BudgetExceededError || e instanceof FreeeGuardError) return e;
    if (e instanceof FreeeAuthError) {
      if (e.error === 'invalid_grant') return reauth('freee のリフレッシュトークンが無効（invalid_grant）。keihi freee auth で再認可する', e.status);
      if (e.status === null) return new ProviderError(/TimeoutError|AbortError/.test(e.message) ? 'timeout' : 'network', e.message);
      return new ProviderError(kindOfStatus(e.status), e.message, { status: e.status });
    }
    if (e instanceof FreeeNetworkError) return new ProviderError(e.timeout ? 'timeout' : 'network', e.message);
    return e;
  }

  async function call(method: ProviderMethod, httpMethod: Method, p: string, o: RequestOptions = {}, purpose: Purpose = DEFAULT_PURPOSES[method]): Promise<ApiResponse> {
    if (isReauthRequired(db)) throw new ProviderError('auth_invalid_grant', 'freee の再認可が要る（keihi freee auth）。呼び出さない');
    let res: ApiResponse;
    try {
      await ensureToken();
      res = await client.request(httpMethod, p, { ...o, purpose });
    } catch (e) {
      throw toProviderError(e);
    }
    if (!res.ok) {
      throw new ProviderError(kindOfStatus(res.status), `freee HTTP ${res.status}: ${httpMethod} ${p}${res.requestId ? ` req=${res.requestId}` : ''}`, {
        status: res.status,
        requestId: res.requestId,
      });
    }
    return res;
  }

  const cq = (q: Query = {}): Query => ({ company_id: companyId, ...q });

  // offset / limit で全部を取る。
  async function pages(method: ProviderMethod, p: string, q: Query, key: string, limit: number): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let offset = 0; ; offset += limit) {
      const res = await call(method, 'GET', p, { query: cq({ ...q, limit, offset }) });
      const page = arr(obj(res.json)[key]);
      out.push(...page);
      if (page.length < limit) return out;
    }
  }

  async function findPartnerId(name: string): Promise<number> {
    const list = await pages('createExpenseDeal', '/api/1/partners', { keyword: name }, 'partners', PAGE);
    const hit = list.map(obj).find((x) => x.name === name);
    const id = hit ? num(hit.id) : null;
    // 取引先は作らない（承認の無い書き込みをしない）。名前は個人情報になりうるのでメッセージに入れない。
    if (id === null) throw new ProviderError('client', '指定の取引先が freee に無い');
    return id;
  }

  async function fetchDeal(method: ProviderMethod, id: number): Promise<Obj> {
    const res = await call(method, 'GET', `/api/1/deals/${id}`, { query: cq() });
    return obj(obj(res.json).deal);
  }

  return {
    capabilities() {
      return { ...FREEE_CAPABILITIES };
    },

    async uploadReceipt(input: UploadReceiptInput) {
      if (input.bytes.length > MAX_RECEIPT_BYTES) throw new ProviderError('client', `ファイルが大きすぎる: ${input.bytes.length}B`);
      if (input.meta?.invoiceRegistrationNumber !== undefined) {
        throw new ProviderError('client', '登録番号はアップロードでは送れない（updateReceiptMeta で送る）');
      }
      const form = new FormData();
      form.set('company_id', String(companyId));
      form.set('description', input.key);
      // 原本はそのまま送る（R4）。
      form.set('receipt', new Blob([new Uint8Array(input.bytes)], { type: input.mime }), input.fileName);
      const m = input.meta ?? {};
      if (m.partnerName !== undefined) form.set('receipt_metadatum_partner_name', m.partnerName);
      if (m.issueDate !== undefined) form.set('receipt_metadatum_issue_date', m.issueDate);
      if (m.amount !== undefined) form.set('receipt_metadatum_amount', String(m.amount));
      if (m.documentType !== undefined) form.set('document_type', m.documentType);
      if (m.qualifiedInvoice !== undefined) form.set('qualified_invoice', m.qualifiedInvoice);
      const res = await call('uploadReceipt', 'POST', '/api/1/receipts', { form });
      return receiptFrom(obj(obj(res.json).receipt), { fileName: input.fileName, byteSize: input.bytes.length });
    },

    async updateReceiptMeta(id: number, meta: ReceiptMeta) {
      const body: Obj = { company_id: companyId };
      const md: Obj = {};
      if (meta.partnerName !== undefined) md.partner_name = meta.partnerName;
      if (meta.issueDate !== undefined) md.issue_date = meta.issueDate;
      if (meta.amount !== undefined) md.amount = meta.amount;
      if (Object.keys(md).length) body.receipt_metadatum = md;
      if (meta.qualifiedInvoice !== undefined) body.qualified_invoice = meta.qualifiedInvoice;
      if (meta.invoiceRegistrationNumber !== undefined) body.invoice_registration_number = meta.invoiceRegistrationNumber;
      if (meta.documentType !== undefined) body.document_type = meta.documentType;
      const res = await call('updateReceiptMeta', 'PUT', `/api/1/receipts/${id}`, { json: body });
      return receiptFrom(obj(obj(res.json).receipt));
    },

    async downloadReceipt(id: number, o: { purpose?: Purpose } = {}) {
      const res = await call('downloadReceipt', 'GET', `/api/1/receipts/${id}/download`, { query: cq(), binary: true }, o.purpose);
      const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
      return { bytes: res.bytes ?? Buffer.alloc(0), mime };
    },

    // 取引に未登録（without_deal）の証憑から、description が照合キーと一致し、削除されていないものを返す。
    async findReceiptsByKey(key: string, range?: DateRange) {
      const today = todayInTokyo(now());
      const r = range ?? { startDate: addDays(today, -RECEIPT_LOOKBACK_DAYS), endDate: addDays(today, 1) };
      const list = await pages(
        'findReceiptsByKey',
        '/api/1/receipts',
        { start_date: r.startDate, end_date: r.endDate, category: 'without_deal' },
        'receipts',
        RECEIPTS_PAGE,
      );
      return list
        .map(obj)
        .filter((x) => x.description === key && x.status !== 'deleted')
        .map((x) => receiptFrom(x));
    },

    async createExpenseDeal(input: CreateExpenseDealInput) {
      const body: Obj = {
        company_id: companyId,
        issue_date: input.issueDate,
        type: 'expense',
        ref_number: input.refNumber,
        details: input.details.map(detailBody),
      };
      if (input.receiptIds?.length) body.receipt_ids = [...new Set(input.receiptIds)];
      if (input.payments?.length) {
        body.payments = input.payments.map((x) => ({ date: x.date, amount: x.amount, from_walletable_type: x.fromWalletableType, from_walletable_id: x.fromWalletableId }));
      }
      if (input.partnerName !== undefined) body.partner_id = await findPartnerId(input.partnerName);
      const res = await call('createExpenseDeal', 'POST', '/api/1/deals', { json: body });
      return dealFrom(obj(obj(res.json).deal));
    },

    async attachReceipts(dealId: number, receiptIds: number[]) {
      const d = await fetchDeal('attachReceipts', dealId);
      const current = arr(d.receipts).map((x) => num(obj(x).id)).filter((x): x is number => x !== null);
      const body: Obj = {
        company_id: companyId,
        issue_date: d.issue_date,
        type: d.type,
        details: arr(d.details).map(updateDetailFrom),
        receipt_ids: [...new Set([...current, ...receiptIds])],
      };
      if (typeof d.due_date === 'string') body.due_date = d.due_date;
      if (typeof d.ref_number === 'string') body.ref_number = d.ref_number;
      const partnerId = num(d.partner_id);
      if (partnerId !== null && partnerId > 0) body.partner_id = partnerId;
      const res = await call('attachReceipts', 'PUT', `/api/1/deals/${dealId}`, { json: body });
      return dealFrom(obj(obj(res.json).deal));
    },

    async getDeal(id: number) {
      return dealFrom(await fetchDeal('getDeal', id));
    },

    // freee の一覧は ref_number で絞れないので、refNumber があれば全部取って手元で絞る。
    async listDeals(q: ListDealsQuery = {}) {
      const base: Query = { type: 'expense', start_issue_date: q.startIssueDate, end_issue_date: q.endIssueDate };
      if (q.refNumber === undefined && q.limit !== undefined && q.limit <= PAGE) {
        const res = await call('listDeals', 'GET', '/api/1/deals', { query: cq({ ...base, limit: q.limit, offset: q.offset ?? 0 }) });
        return arr(obj(res.json).deals).map((x) => dealFrom(obj(x)));
      }
      const all = (await pages('listDeals', '/api/1/deals', base, 'deals', PAGE)).map((x) => dealFrom(obj(x)));
      const hit = q.refNumber === undefined ? all : all.filter((d) => d.refNumber === q.refNumber);
      const offset = q.offset ?? 0;
      return hit.slice(offset, q.limit === undefined ? undefined : offset + q.limit);
    },

    async deleteDeal(id: number) {
      await call('deleteDeal', 'DELETE', `/api/1/deals/${id}`, { query: cq() });
    },

    async syncMasters(): Promise<Masters> {
      const items = await call('syncMasters', 'GET', '/api/1/account_items', { query: cq() });
      const taxes = await call('syncMasters', 'GET', '/api/1/taxes/codes');
      const wallets = await call('syncMasters', 'GET', '/api/1/walletables', { query: cq() });
      return {
        accountItems: arr(obj(items.json).account_items).map((x) => ({ id: num(obj(x).id) ?? 0, name: str(obj(x).name) ?? '' })),
        taxCodes: arr(obj(taxes.json).taxes).map((x) => ({ code: num(obj(x).code) ?? 0, name: str(obj(x).name_ja) ?? str(obj(x).name) ?? '' })),
        walletables: arr(obj(wallets.json).walletables).map((x) => ({
          id: num(obj(x).id) ?? 0,
          type: str(obj(x).type) as WalletableType,
          name: str(obj(x).name) ?? '',
        })),
      };
    },

    // 1 ページだけ取る（limit 既定 100、続きは offset）。
    async listBankTxns(q: ListBankTxnsQuery = {}): Promise<BankTxn[]> {
      const limit = q.limit ?? PAGE;
      const offset = q.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE) throw new ProviderError('client', `limit は 1〜${PAGE}: ${limit}`);
      if (!Number.isInteger(offset) || offset < 0) throw new ProviderError('client', `offset が不正: ${offset}`);
      const res = await call('listBankTxns', 'GET', '/api/1/wallet_txns', {
        query: cq({ walletable_type: q.walletableType, walletable_id: q.walletableId, start_date: q.startDate, end_date: q.endDate, limit, offset }),
      });
      return arr(obj(res.json).wallet_txns).map(obj).map((t) => ({
        id: num(t.id) ?? 0,
        walletableType: str(t.walletable_type) as WalletableType,
        walletableId: num(t.walletable_id) ?? 0,
        date: str(t.date) ?? '',
        amount: num(t.amount) ?? 0,
        entrySide: t.entry_side === 'income' ? 'income' : 'expense',
        description: str(t.description) ?? '',
        balance: num(t.balance),
        status: num(t.status),
        dueAmount: num(t.due_amount) ?? 0,
        ruleMatched: t.rule_matched === true,
      }));
    },

    // keihi の 4 種類（act 4 / 11 / 12 / 0）だけを返す。口座・科目・税区分の条件は M6 で扱う。
    async listRules(): Promise<Rule[]> {
      const list = await pages('listRules', '/api/1/user_matchers', {}, 'data', PAGE);
      const out: Rule[] = [];
      for (const r of list.map(obj)) {
        const action = ACTION_OF.get(num(r.act) ?? -1);
        const id = num(r.id);
        if (action && id !== null) out.push({ id, matchText: str(r.description) ?? '', action });
      }
      return out;
    },

    async createRule(input: CreateRuleInput): Promise<Rule> {
      // 口座の指定（body の walletable）は文字列の書式が未確認なので送らない。
      if (input.walletableType !== undefined || input.walletableId !== undefined || input.accountItemId !== undefined || input.taxCode !== undefined) {
        throw new ProviderError('client', 'ルールの口座・科目・税区分の指定は未対応（M6）');
      }
      const body: Obj = {
        act: ACT[input.action],
        active: true,
        condition: 0, // 部分一致（freee-codex.md F12 の PoC と同じ）
        description: input.matchText,
        entry_side_str: 'expense',
        priority: 0,
      };
      const res = await call('createRule', 'POST', '/api/1/user_matchers', { query: cq(), json: body });
      return { id: num(obj(res.json).id) ?? 0, matchText: input.matchText, action: input.action };
    },

    async deleteRule(id: number) {
      await call('deleteRule', 'DELETE', `/api/1/user_matchers/${id}`, { query: cq() });
    },
  };
}
