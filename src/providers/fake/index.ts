// テスト用の Provider（docs/mvp-plan.md T1-9）。in-memory で状態を持ち、外部へ通信しない。
// - 障害注入: failNext(kind, { times, butSucceed }) で次の呼び出しから times 回、その種類の ProviderError を投げる。
//   butSucceed なら操作を反映してから投げる（「タイムアウトを返すが実は成功している」）。
// - 呼び出しは成否を問わず calls に記録する（capabilities() は API 呼び出しではないので記録しない）。
// - ID は種類ごとに 1 から採番する（決定的）。
import { createHash } from 'node:crypto';
import {
  ProviderError,
  type BankTxn,
  type Capabilities,
  type CreateExpenseDealInput,
  type CreateRuleInput,
  type Deal,
  type ListBankTxnsQuery,
  type ListDealsQuery,
  type Masters,
  type Provider,
  type ProviderErrorKind,
  type Receipt,
  type ReceiptMeta,
  type Rule,
  type UploadReceiptInput,
} from '../types.ts';

export const FAKE_CAPABILITIES: Capabilities = {
  receiptMetaOnUpload: true,
  canLinkExistingReceipt: true,
  canReconcileTxn: false,
  maxReceiptBytes: 64 * 1024 * 1024,
};

// 注入した障害のステータス（freee の応答に合わせる。timeout・network は応答が無い）。
const STATUS: Record<ProviderErrorKind, number | null> = {
  timeout: null,
  server: 500,
  rate_limited: 429,
  usage_limited: 403,
  auth_invalid_grant: 401,
  client: 400,
  network: null,
};

// ID・コードは fake 用の仮の値（freee の実際の値ではない）。
export const DEFAULT_MASTERS: Masters = {
  accountItems: [
    { id: 101, name: '消耗品費' },
    { id: 102, name: '旅費交通費' },
    { id: 103, name: '通信費' },
    { id: 104, name: '事業主貸' },
  ],
  taxCodes: [
    { code: 1, name: '課対仕入10%' },
    { code: 2, name: '課対仕入8%（軽）' },
    { code: 3, name: '対象外' },
  ],
  walletables: [{ id: 1, type: 'credit_card', name: 'テストカード' }],
};

export type FakeCall = {
  method: string;
  args: unknown[];
  // 'ok' か、注入した障害の種類か、fake 自身が返したエラー（存在しない ID など）の種類。
  outcome: 'ok' | ProviderErrorKind;
  // butSucceed で注入した呼び出し（操作は反映済み）。
  applied: boolean;
};

export type FailOptions = { times?: number; butSucceed?: boolean };

export type FakeProvider = Provider & {
  readonly calls: FakeCall[];
  failNext(kind: ProviderErrorKind, opts?: FailOptions): void;
  // テストの前提を作る（API 呼び出しではないので calls に記録しない）。
  addBankTxn(txn: Omit<BankTxn, 'id'>): BankTxn;
  readonly state: {
    receipts: Map<number, Receipt & { bytes: Buffer; sha256: string }>;
    deals: Map<number, Deal>;
    bankTxns: Map<number, BankTxn>;
    rules: Map<number, Rule>;
  };
};

type Pending = { kind: ProviderErrorKind; left: number; butSucceed: boolean };

export function createFakeProvider(opts: { masters?: Masters } = {}): FakeProvider {
  const masters = structuredClone(opts.masters ?? DEFAULT_MASTERS);
  const calls: FakeCall[] = [];
  const pending: Pending[] = [];
  const seq = { receipt: 0, deal: 0, txn: 0, rule: 0, request: 0 };
  const state: FakeProvider['state'] = { receipts: new Map(), deals: new Map(), bankTxns: new Map(), rules: new Map() };

  const requestId = () => `fake-req-${++seq.request}`;
  const notFound = (what: string, id: number) => new ProviderError('client', `${what} ${id} が無い`, { status: 404, requestId: requestId() });
  const badRequest = (msg: string) => new ProviderError('client', msg, { status: 400, requestId: requestId() });

  // 返す値は内部状態と切り離す（呼び出し側の書き換えが状態に及ばないように）。
  const publicReceipt = (r: Receipt): Receipt => ({
    id: r.id,
    key: r.key,
    fileName: r.fileName,
    mime: r.mime,
    byteSize: r.byteSize,
    meta: { ...r.meta },
    dealId: r.dealId,
  });
  const publicDeal = (d: Deal): Deal => structuredClone(d);

  async function run<T>(method: string, args: unknown[], op: () => T): Promise<T> {
    const p = pending[0];
    if (p) {
      if (--p.left <= 0) pending.shift();
      if (p.butSucceed) {
        try {
          op();
        } catch (e) {
          calls.push({ method, args, outcome: e instanceof ProviderError ? e.kind : 'client', applied: false });
          throw e;
        }
      }
      calls.push({ method, args, outcome: p.kind, applied: p.butSucceed });
      throw new ProviderError(p.kind, `fake: ${method} に ${p.kind} を注入`, { status: STATUS[p.kind], requestId: requestId() });
    }
    try {
      const out = op();
      calls.push({ method, args, outcome: 'ok', applied: false });
      return out;
    } catch (e) {
      calls.push({ method, args, outcome: e instanceof ProviderError ? e.kind : 'client', applied: false });
      throw e;
    }
  }

  function receipt(id: number) {
    const r = state.receipts.get(id);
    if (!r) throw notFound('証憑', id);
    return r;
  }

  function deal(id: number) {
    const d = state.deals.get(id);
    if (!d) throw notFound('取引', id);
    return d;
  }

  return {
    calls,
    state,

    failNext(kind, o = {}) {
      const times = o.times ?? 1;
      if (!Number.isInteger(times) || times <= 0) throw new Error(`times が不正: ${times}`);
      pending.push({ kind, left: times, butSucceed: o.butSucceed ?? false });
    },

    addBankTxn(txn) {
      const t = { ...txn, id: ++seq.txn };
      state.bankTxns.set(t.id, t);
      return { ...t };
    },

    capabilities() {
      return { ...FAKE_CAPABILITIES };
    },

    uploadReceipt(input: UploadReceiptInput) {
      return run('uploadReceipt', [{ fileName: input.fileName, mime: input.mime, key: input.key, byteSize: input.bytes.length }], () => {
        if (input.bytes.length > FAKE_CAPABILITIES.maxReceiptBytes) throw badRequest(`ファイルが大きすぎる: ${input.bytes.length}B`);
        const bytes = Buffer.from(input.bytes);
        const r = {
          id: ++seq.receipt,
          key: input.key,
          fileName: input.fileName,
          mime: input.mime,
          byteSize: bytes.length,
          meta: { ...input.meta },
          dealId: null,
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
        state.receipts.set(r.id, r);
        return publicReceipt(r);
      });
    },

    updateReceiptMeta(id: number, meta: ReceiptMeta) {
      return run('updateReceiptMeta', [id, { ...meta }], () => {
        const r = receipt(id);
        r.meta = { ...r.meta, ...meta };
        return publicReceipt(r);
      });
    },

    downloadReceipt(id: number) {
      return run('downloadReceipt', [id], () => {
        const r = receipt(id);
        return { bytes: Buffer.from(r.bytes), mime: r.mime };
      });
    },

    findReceiptsByKey(key: string) {
      return run('findReceiptsByKey', [key], () => [...state.receipts.values()].filter((r) => r.key === key).map(publicReceipt));
    },

    createExpenseDeal(input: CreateExpenseDealInput) {
      return run('createExpenseDeal', [structuredClone(input)], () => {
        if (input.details.length === 0) throw badRequest('details が空');
        const receiptIds = [...new Set(input.receiptIds ?? [])];
        for (const rid of receiptIds) receipt(rid);
        const d: Deal = {
          id: ++seq.deal,
          issueDate: input.issueDate,
          refNumber: input.refNumber,
          type: 'expense',
          settled: (input.payments?.length ?? 0) > 0,
          amount: input.details.reduce((s, x) => s + x.amount, 0),
          details: structuredClone(input.details),
          partnerName: input.partnerName ?? null,
          receiptIds,
        };
        state.deals.set(d.id, d);
        for (const rid of receiptIds) receipt(rid).dealId = d.id;
        return publicDeal(d);
      });
    },

    attachReceipts(dealId: number, receiptIds: number[]) {
      return run('attachReceipts', [dealId, [...receiptIds]], () => {
        const d = deal(dealId);
        for (const rid of receiptIds) receipt(rid);
        for (const rid of receiptIds) {
          if (!d.receiptIds.includes(rid)) d.receiptIds.push(rid);
          receipt(rid).dealId = d.id;
        }
        return publicDeal(d);
      });
    },

    getDeal(id: number) {
      return run('getDeal', [id], () => publicDeal(deal(id)));
    },

    listDeals(q: ListDealsQuery = {}) {
      return run('listDeals', [{ ...q }], () => {
        const all = [...state.deals.values()].filter(
          (d) =>
            (q.refNumber === undefined || d.refNumber === q.refNumber) &&
            (q.startIssueDate === undefined || d.issueDate >= q.startIssueDate) &&
            (q.endIssueDate === undefined || d.issueDate <= q.endIssueDate),
        );
        const offset = q.offset ?? 0;
        return all.slice(offset, q.limit === undefined ? undefined : offset + q.limit).map(publicDeal);
      });
    },

    deleteDeal(id: number) {
      return run('deleteDeal', [id], () => {
        const d = deal(id);
        for (const rid of d.receiptIds) {
          const r = state.receipts.get(rid);
          if (r && r.dealId === id) r.dealId = null;
        }
        state.deals.delete(id);
      });
    },

    syncMasters() {
      return run('syncMasters', [], () => structuredClone(masters));
    },

    listBankTxns(q: ListBankTxnsQuery = {}) {
      return run('listBankTxns', [{ ...q }], () =>
        [...state.bankTxns.values()]
          .filter(
            (t) =>
              (q.walletableType === undefined || t.walletableType === q.walletableType) &&
              (q.walletableId === undefined || t.walletableId === q.walletableId) &&
              (q.startDate === undefined || t.date >= q.startDate) &&
              (q.endDate === undefined || t.date <= q.endDate),
          )
          .map((t) => ({ ...t })),
      );
    },

    listRules() {
      return run('listRules', [], () => [...state.rules.values()].map((r) => ({ ...r })));
    },

    createRule(input: CreateRuleInput) {
      return run('createRule', [{ ...input }], () => {
        const r: Rule = { ...input, id: ++seq.rule };
        state.rules.set(r.id, r);
        return { ...r };
      });
    },

    deleteRule(id: number) {
      return run('deleteRule', [id], () => {
        if (!state.rules.delete(id)) throw notFound('ルール', id);
      });
    },
  };
}
