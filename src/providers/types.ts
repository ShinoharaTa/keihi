// 会計サービスの Provider インターフェース（docs/mvp-plan.md T1-9、docs/freee-codex.md §5.3）。
// 名前は会計サービスに依存しない形にする。実装は freee（src/providers/freee/provider.ts、T1-10）と fake（テスト用）。
// - 冪等キーは freee に無い（architecture.md §1.1）。タイムアウトの後は findReceiptsByKey / listDeals の refNumber で
//   「実は成功していたか」を確かめてから送り直す。
// - ID は freee に合わせて数値。

export type ProviderErrorKind =
  | 'timeout' // 応答が来ない。実は成功していることがある
  | 'server' // 5xx
  | 'rate_limited' // 429（/receipts/{id}/download の 3 回/秒など）
  | 'usage_limited' // 403 の使用制限（過剰なアクセスで約 10 分止まる）
  | 'auth_invalid_grant' // 401 invalid_grant（リフレッシュトークンの失効・使い回し）。再認可が要る
  | 'client' // その他の 4xx
  | 'network'; // 接続できない

const RETRYABLE: Record<ProviderErrorKind, boolean> = {
  timeout: true,
  server: true,
  rate_limited: true,
  usage_limited: true,
  auth_invalid_grant: false,
  client: false,
  network: true,
};

export function isRetryable(kind: ProviderErrorKind): boolean {
  return RETRYABLE[kind];
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly requestId: string | null;
  constructor(kind: ProviderErrorKind, message: string, opts: { status?: number | null; requestId?: string | null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = isRetryable(kind);
    this.status = opts.status ?? null;
    this.requestId = opts.requestId ?? null;
  }
}

export type Capabilities = {
  // アップロード時に電子保存の検索項目（取引先・日付・金額）を渡せる。
  receiptMetaOnUpload: boolean;
  // 既存の取引に、上げ済みの証憑を後から紐付けられる。
  canLinkExistingReceipt: boolean;
  // 明細と取引の消込を API でできる。
  canReconcileTxn: boolean;
  maxReceiptBytes: number;
};

// ---- 証憑 ----

export type DocumentType = 'receipt' | 'invoice' | 'other';
export type QualifiedInvoice = 'qualified' | 'not_qualified' | 'unselected';

export type ReceiptMeta = {
  partnerName?: string;
  issueDate?: string; // YYYY-MM-DD
  amount?: number;
  documentType?: DocumentType;
  qualifiedInvoice?: QualifiedInvoice;
  invoiceRegistrationNumber?: string;
};

export type UploadReceiptInput = {
  bytes: Buffer;
  fileName: string;
  mime: string;
  // 照合キー（freee では description に入れる）。タイムアウト後の重複確認に使う。
  key: string;
  meta?: ReceiptMeta;
};

export type Receipt = {
  id: number;
  key: string;
  fileName: string;
  mime: string;
  byteSize: number;
  meta: ReceiptMeta;
  dealId: number | null;
};

// ---- 取引 ----

export type DealDetail = {
  accountItemId: number;
  taxCode: number;
  amount: number;
  description?: string;
};

// 決済（freee の deals.payments）。現金は wallet、事業主借は private_account_item（id は勘定科目の ID）。
export type DealPayment = {
  date: string; // YYYY-MM-DD
  amount: number;
  fromWalletableType: 'wallet' | 'private_account_item';
  fromWalletableId: number;
};

// 支出の取引。payments が無ければ未決済（連携カード。Y5）、あれば決済済み（現金・事業主借）。
export type CreateExpenseDealInput = {
  issueDate: string; // YYYY-MM-DD
  // 照合キー（freee の ref_number）。
  refNumber: string;
  details: DealDetail[];
  partnerName?: string;
  receiptIds?: number[];
  payments?: DealPayment[];
};

export type Deal = {
  id: number;
  issueDate: string;
  refNumber: string;
  type: 'expense';
  settled: boolean;
  amount: number;
  details: DealDetail[];
  partnerName: string | null;
  receiptIds: number[];
};

export type ListDealsQuery = {
  refNumber?: string;
  startIssueDate?: string;
  endIssueDate?: string;
  limit?: number;
  offset?: number;
};

// ---- マスタ ----

export type AccountItem = { id: number; name: string };
export type TaxCode = { code: number; name: string };
export type WalletableType = 'bank_account' | 'credit_card' | 'wallet';
export type Walletable = { id: number; type: WalletableType; name: string };
export type Masters = { accountItems: AccountItem[]; taxCodes: TaxCode[]; walletables: Walletable[] };
// 口座の残高（freee の walletables?with_balance=true の last_balance）。無ければ null。
export type WalletableBalance = Walletable & { lastBalance: number | null };

// ---- 明細とルール（M6） ----

// 明細の状態の既知の値（freee の wallet_txns.status。docs/transactions.md §明細）。
// OpenAPI は 1〜6 の整数としか定めていないので、BankTxn.status はこれ以外の値（5 など）も入る。
export const BANK_TXN_STATUS = {
  unmatched: 1, // 消込待ち（未処理）
  matched: 2, // 消込済み
  ignored: 3, // 無視
  matching: 4, // 消込中
  excluded: 6, // 対象外
} as const;

export type BankTxn = {
  id: number;
  walletableType: WalletableType;
  walletableId: number;
  date: string; // YYYY-MM-DD
  amount: number; // 正の整数。向きは entrySide
  entrySide: 'income' | 'expense';
  description: string;
  // 取引後の残高。銀行は整数、カードは null。
  balance: number | null;
  // 既知の値は BANK_TXN_STATUS。応答に無ければ null。
  status: number | null;
  dueAmount: number;
  ruleMatched: boolean;
};

// 1 回で 1 ページだけ返す。limit は 1〜100（既定 100）、offset で続きを取る。
export type ListBankTxnsQuery = {
  walletableType?: WalletableType;
  walletableId?: number;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
};

// ignore = 無視、private = プライベートを推測、private_register = プライベートを登録、deal = 取引を推測
// （freee の user_matchers の act=4 / 11 / 12 / 0）。
export type RuleAction = 'ignore' | 'private' | 'private_register' | 'deal';

export type CreateRuleInput = {
  matchText: string;
  action: RuleAction;
  walletableType?: WalletableType;
  walletableId?: number;
  accountItemId?: number;
  taxCode?: number;
};

export type Rule = CreateRuleInput & { id: number };

// ---- Provider ----

export type Provider = {
  capabilities(): Capabilities;

  uploadReceipt(input: UploadReceiptInput): Promise<Receipt>;
  updateReceiptMeta(id: number, meta: ReceiptMeta): Promise<Receipt>;
  downloadReceipt(id: number): Promise<{ bytes: Buffer; mime: string }>;
  findReceiptsByKey(key: string): Promise<Receipt[]>;

  createExpenseDeal(input: CreateExpenseDealInput): Promise<Deal>;
  attachReceipts(dealId: number, receiptIds: number[]): Promise<Deal>;
  getDeal(id: number): Promise<Deal>;
  listDeals(query?: ListDealsQuery): Promise<Deal[]>;
  deleteDeal(id: number): Promise<void>;

  syncMasters(): Promise<Masters>;
  listWalletables(): Promise<WalletableBalance[]>;

  listBankTxns(query?: ListBankTxnsQuery): Promise<BankTxn[]>;
  listRules(): Promise<Rule[]>;
  createRule(input: CreateRuleInput): Promise<Rule>;
  deleteRule(id: number): Promise<void>;

  // 将来用（消込 API。capabilities().canReconcileTxn が true のときだけ使う）。形は未定。
  reconcileTxn?(txnId: number, dealId: number): Promise<void>;
  ignoreTxn?(txnId: number): Promise<void>;
};
