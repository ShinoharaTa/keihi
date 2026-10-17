// 取引ビルダ（docs/mvp-plan.md T4-1、§3.2 Y5・U4'）。確定版の review → freee に送る取引の下書き（DealDraft）。
// - 支払手段（reviews.credit_account）で決済を分ける。
//   連携カード（card:<walletable_remote_id>）: 未決済（payments を持たない）。消込は freee の画面で行う（Y5 の既定）。
//   現金（cash）: 決済済み。payments に取引日・合計で、口座は名前が「現金」の wallet（同期済みのマスタ）。
//   事業主借（owner）: 決済済み。payments の from_walletable_type は private_account_item、id は勘定科目「事業主借」。
//   マスタに見つからなければ DealBuildError（send_deal は build_failed にする）。
// - 按分は 1 枚ごとに分ける（U4' の既定）。按分率（事業分の %）は review の値。事業分 = 行の金額 × 率 / 100 の切り捨て、
//   残りは事業主貸（税区分は対象外）にまとめて 1 行にする。
// - 軽減税率の混在など、税率の区分ごとの内訳があれば行を分ける（内訳の税込額の和は合計と一致すること）。
// - ref_number は照合キー kh-<document_id>（証憑の description と同じ）。
// 入力は DB から独立した型（ReviewForDeal）。DB からの読み出しは loadReviewForDeal。
import type { Db } from '../db/index.ts';
import type { DealDetail, DealPayment } from '../providers/types.ts';
import { toTaxCode } from '../ai/validate.ts';
import { loadTaxMap, TAX_CATEGORIES, type TaxCategory, type TaxMap } from '../masters/tax-map.ts';
import { currentMasters } from '../masters/sync.ts';

export type Payment = { kind: 'cash' } | { kind: 'owner' } | { kind: 'card'; walletableRemoteId: string };

export type TaxLine = { taxCode: number; amount: number }; // 税込額

export type ReviewForDeal = {
  documentId: string;
  reviewId: string;
  txnDate: string; // YYYY-MM-DD
  amount: number; // 税込の合計
  vendor: string | null;
  accountItemId: number;
  // 税率の区分ごとの内訳。1 行なら [{taxCode, amount}]。
  taxLines: TaxLine[];
  payment: Payment;
  prorationPct: number; // 事業分の %（0〜100）
  receiptIds: number[]; // 紐付ける証憑（provider_uploads.remote_receipt_id）。まだ無ければ空
};

export type BuildOptions = {
  ownerDrawAccountItemId: number; // 事業主貸
  outOfScopeTaxCode: number; // 対象外
  cashWalletableId?: number; // 現金（wallet）の口座。payment が cash のとき要る
  ownerLoanAccountItemId?: number; // 事業主借。payment が owner のとき要る
};

export type DealDraft = {
  refNumber: string;
  issueDate: string;
  partnerName?: string;
  details: DealDetail[];
  receiptIds: number[];
  payment: Payment; // 支払手段の記録（送るのは payments）
  payments?: DealPayment[]; // 現金・事業主借のときだけ（連携カードは未決済なので持たない）
};

export class DealBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DealBuildError';
  }
}

export function refNumber(documentId: string): string {
  return `kh-${documentId}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildDeal(r: ReviewForDeal, opts: BuildOptions): DealDraft {
  if (!DATE.test(r.txnDate)) throw new DealBuildError(`取引日が不正: ${r.txnDate}`);
  if (!Number.isSafeInteger(r.amount) || r.amount <= 0) throw new DealBuildError(`金額が正の整数ではない: ${r.amount}`);
  if (!Number.isInteger(r.prorationPct) || r.prorationPct < 0 || r.prorationPct > 100) throw new DealBuildError(`按分率が 0〜100 の整数ではない: ${r.prorationPct}`);
  if (r.taxLines.length === 0) throw new DealBuildError('税区分の行が無い');
  for (const l of r.taxLines) {
    if (!Number.isSafeInteger(l.amount) || l.amount <= 0) throw new DealBuildError(`内訳の金額が正の整数ではない: ${l.amount}`);
  }
  const sum = r.taxLines.reduce((s, l) => s + l.amount, 0);
  if (sum !== r.amount) throw new DealBuildError(`内訳の和 ${sum} ≠ 合計 ${r.amount}`);

  const business: DealDetail[] = [];
  let privateAmount = 0;
  for (const l of r.taxLines) {
    const b = Math.floor((l.amount * r.prorationPct) / 100);
    if (b > 0) business.push({ accountItemId: r.accountItemId, taxCode: l.taxCode, amount: b });
    privateAmount += l.amount - b;
  }
  const details = [...business];
  if (privateAmount > 0) details.push({ accountItemId: opts.ownerDrawAccountItemId, taxCode: opts.outOfScopeTaxCode, amount: privateAmount });

  const draft: DealDraft = {
    refNumber: refNumber(r.documentId),
    issueDate: r.txnDate,
    details,
    receiptIds: [...new Set(r.receiptIds)],
    payment: r.payment,
  };
  if (r.vendor) draft.partnerName = r.vendor;
  if (r.payment.kind === 'cash') {
    if (opts.cashWalletableId === undefined) throw new DealBuildError('現金の口座（wallet）が無い');
    draft.payments = [{ date: r.txnDate, amount: r.amount, fromWalletableType: 'wallet', fromWalletableId: opts.cashWalletableId }];
  } else if (r.payment.kind === 'owner') {
    if (opts.ownerLoanAccountItemId === undefined) throw new DealBuildError('勘定科目「事業主借」が無い');
    draft.payments = [{ date: r.txnDate, amount: r.amount, fromWalletableType: 'private_account_item', fromWalletableId: opts.ownerLoanAccountItemId }];
  }
  return draft;
}

// ---- DB からの読み出し ----

// 0003_review.sql（T2-8）の tax_by_rate_json の区分 → 税率の区分。
const REVIEW_CATEGORY: Record<string, TaxCategory> = {
  '10': 'taxable_10',
  '8r': 'taxable_8_reduced',
  exempt: 'non_taxable',
  na: 'out_of_scope',
};

export function parsePayment(creditAccount: string | null): Payment {
  if (creditAccount === 'cash') return { kind: 'cash' };
  if (creditAccount === 'owner') return { kind: 'owner' };
  if (creditAccount?.startsWith('card:') && creditAccount.length > 5) return { kind: 'card', walletableRemoteId: creditAccount.slice(5) };
  throw new DealBuildError(`支払手段が不正: ${creditAccount}`);
}

type ReviewRow = {
  id: string;
  document_id: string;
  version: number;
  txn_date: string | null;
  amount: number | null;
  vendor: string | null;
  account_id: string | null;
  tax_id: string | null;
  credit_account: string | null;
  decision: string;
  proration_pct: number | null;
  tax_by_rate_json: string | null;
  qualified_invoice: number | null;
};

// 送る対象の確定版: decision='approve' の version 最大。無ければ null。
// 最新の版が approve でない（私用・重複・却下に変えた）場合も null を返す（送らない）。
export function latestApprovedReview(db: Db, documentId: string): ReviewRow | null {
  const latest = db
    .prepare(
      `SELECT id, document_id, version, txn_date, amount, vendor, account_id, tax_id, credit_account, decision, proration_pct, tax_by_rate_json, qualified_invoice
       FROM reviews WHERE document_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(documentId) as ReviewRow | undefined;
  if (!latest || latest.decision !== 'approve') return null;
  return latest;
}

export type TaxResolver = (category: TaxCategory, txnDate: string, qualified: boolean) => number;

// 税率の区分 → freee の税区分コード（対応表と同期済みの税区分のマスタ。src/ai/validate.ts の toTaxCode）。
export function taxResolver(db: Db, provider: string, map: TaxMap = loadTaxMap()): TaxResolver {
  const masters = currentMasters(db, provider, 'tax');
  return (category, txnDate, qualified) => {
    const r = toTaxCode({ category, txnDate, hasInvoiceRegNo: qualified }, map, masters);
    if (!r.ok) throw new DealBuildError(`税区分に変換できない: ${r.reason}`);
    return r.code;
  };
}

// 事業主貸の勘定科目と対象外の税区分（同期済みのマスタを名前で引く）。
// 支払手段が現金なら「現金」の wallet、事業主借なら勘定科目「事業主借」も引く（1 件でなければ DealBuildError）。
export function resolveBuildOptions(db: Db, provider: string, resolveTax: TaxResolver, txnDate: string, payment?: Payment): BuildOptions {
  const accounts = currentMasters(db, provider, 'account');
  const owner = accounts.filter((m) => m.name === '事業主貸');
  if (owner.length !== 1) throw new DealBuildError(`勘定科目「事業主貸」が同期済みのマスタに ${owner.length} 件`);
  const opts: BuildOptions = { ownerDrawAccountItemId: Number(owner[0].remoteId), outOfScopeTaxCode: resolveTax('out_of_scope', txnDate, false) };
  if (payment?.kind === 'cash') {
    const cash = currentMasters(db, provider, 'walletable').filter((m) => m.data.type === 'wallet' && m.name === '現金');
    if (cash.length !== 1) throw new DealBuildError(`口座「現金」（wallet）が同期済みのマスタに ${cash.length} 件`);
    opts.cashWalletableId = Number(cash[0].data.id);
  } else if (payment?.kind === 'owner') {
    const loan = accounts.filter((m) => m.name === '事業主借');
    if (loan.length !== 1) throw new DealBuildError(`勘定科目「事業主借」が同期済みのマスタに ${loan.length} 件`);
    opts.ownerLoanAccountItemId = Number(loan[0].remoteId);
  }
  return opts;
}

export function reviewForDeal(row: ReviewRow, receiptIds: number[], resolveTax: TaxResolver): ReviewForDeal {
  if (row.txn_date === null || row.amount === null) throw new DealBuildError('確定版に取引日か金額が無い');
  const accountItemId = Number(row.account_id);
  if (!Number.isSafeInteger(accountItemId) || accountItemId <= 0) throw new DealBuildError(`勘定科目 ID が不正: ${row.account_id}`);
  const qualified = row.qualified_invoice === 1;
  const txnDate = row.txn_date;

  // tax_id は freee の税区分コード、または税率の区分（T2-8 の区分か Gemini の区分）。
  const tax = row.tax_id ?? '';
  const taxCat = REVIEW_CATEGORY[tax] ?? ((TAX_CATEGORIES as readonly string[]).includes(tax) ? (tax as TaxCategory) : null);
  const taxCode = (): number | null => (/^\d+$/.test(tax) ? Number(tax) : taxCat ? resolveTax(taxCat, txnDate, qualified) : null);

  let taxLines: TaxLine[];
  const byRate = row.tax_by_rate_json ? (JSON.parse(row.tax_by_rate_json) as { category: string; amount_incl_tax: number }[]) : [];
  if (Array.isArray(byRate) && byRate.length > 0) {
    taxLines = byRate.map((x) => {
      const cat = REVIEW_CATEGORY[x.category];
      if (!cat) throw new DealBuildError(`税率の区分が不正: ${x.category}`);
      return { taxCode: resolveTax(cat, txnDate, qualified), amount: x.amount_incl_tax };
    });
    // 確定の tax_id は人が選んだ税率の区分。内訳（抽出の値）と食い違えば、1 行なら tax_id を優先する（人の上書き）。
    // 複数行で tax_id がどの行の区分とも合わないときは、どの行を直したのか決められないので作らない。
    if (tax !== '') {
      const code = taxCode();
      if (code === null) throw new DealBuildError(`税区分が不正: ${row.tax_id}`);
      if (taxLines.length === 1) taxLines = [{ taxCode: code, amount: taxLines[0].amount }];
      else if (!taxLines.some((l) => l.taxCode === code)) {
        throw new DealBuildError(`確定の税区分 ${row.tax_id} が税率ごとの内訳（${byRate.map((x) => x.category).join(', ')}）のどれとも合わない`);
      }
    }
  } else {
    const code = taxCode();
    if (code === null) throw new DealBuildError(`税区分が不正: ${row.tax_id}`);
    taxLines = [{ taxCode: code, amount: row.amount }];
  }
  return {
    documentId: row.document_id,
    reviewId: row.id,
    txnDate,
    amount: row.amount,
    vendor: row.vendor,
    accountItemId,
    taxLines,
    payment: parsePayment(row.credit_account),
    prorationPct: row.proration_pct ?? 100,
    receiptIds,
  };
}
