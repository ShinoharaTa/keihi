// 日次照合（docs/mvp-plan.md T4-4）。keihi が作った取引を freee から読み、送った内容と比べる。
// - 一致（金額・科目・receipt_ids）なら verified。freee 側で人が編集した差分は報告するだけ（上書きしない）:
//   「取引が消えた」「証憑が外れた」「金額が変わった」「科目が変わった」は needs_attention。
// - 対象: deal_created・receipt_linked と、verified のうち発生日が直近 verifiedLookbackDays 日のもの（remote_deal_id が
//   あるもの）。needs_attention は人の対応待ちなので見ない。
// - deal_created で証憑がアップロード済みになっていれば、照合の前に attachReceipts で付ける（stateMachine.ts）。
// - 取得は発生日の範囲（対象の最小〜最大）の listDeals を 1 ページずつ、maxPages まで。一覧に無いものは getDeal で
//   確かめる（404 = 消えた。人が発生日を変えた取引は一覧から外れるため）。上限で打ち切ったときは、一覧に無いものは
//   翌日に回す（deferred）。
// - 1 件の失敗で全体を止めない。4xx はその取引だけ needs_attention にして続ける。再試行できる失敗（5xx・タイムアウト・
//   予算・再認可待ちなど）はその取引を飛ばし、最後にまとめて ReconcileIncompleteError を投げる（ジョブのバックオフ）。
import { addDays, todayInTokyo } from '../calendar/businessDays.ts';
import type { Db } from '../db/index.ts';
import { ProviderError, type Deal, type DealDetail, type Provider } from '../providers/types.ts';
import { draftOf, linkReceiptsIfReady, markNeedsAttention, transition, uploadedReceiptIds, type AttentionReason, type DealRow } from './stateMachine.ts';

export type Diff =
  | { kind: 'deal_missing' }
  | { kind: 'receipt_detached'; expected: number[]; actual: number[] }
  | { kind: 'amount_changed'; expected: number; actual: number }
  | { kind: 'account_changed'; expected: number[]; actual: number[] };

export type Expected = { amount: number; details: DealDetail[]; receiptIds: number[] };

// 送った内容と freee の取引の差分。空なら一致。税区分・取引先・発生日の違いは見ない（T4-4 の対象外）。
export function compareDeal(expected: Expected, actual: Deal | null): Diff[] {
  if (!actual) return [{ kind: 'deal_missing' }];
  const diffs: Diff[] = [];
  const missing = expected.receiptIds.filter((r) => !actual.receiptIds.includes(r));
  if (missing.length) diffs.push({ kind: 'receipt_detached', expected: [...expected.receiptIds], actual: [...actual.receiptIds] });
  if (actual.amount !== expected.amount) diffs.push({ kind: 'amount_changed', expected: expected.amount, actual: actual.amount });
  const accounts = (ds: DealDetail[]) => [...ds.map((d) => d.accountItemId)].sort((a, b) => a - b);
  const ea = accounts(expected.details);
  const aa = accounts(actual.details);
  if (ea.length !== aa.length || ea.some((v, i) => v !== aa[i])) diffs.push({ kind: 'account_changed', expected: ea, actual: aa });
  // 行ごとの金額（按分・税率の内訳）が変わった場合も金額の変更として扱う。
  if (!diffs.some((d) => d.kind === 'amount_changed')) {
    const key = (ds: DealDetail[]) => ds.map((d) => `${d.accountItemId}:${d.amount}`).sort().join(',');
    if (key(expected.details) !== key(actual.details) && !diffs.some((d) => d.kind === 'account_changed')) {
      diffs.push({ kind: 'amount_changed', expected: expected.amount, actual: actual.amount });
    }
  }
  return diffs;
}

export type ReconcileSummary = { checked: number; verified: number; needsAttention: number; linked: number; deferred: number; failed: number };

export const VERIFIED_LOOKBACK_DAYS = 35;
export const MAX_LIST_PAGES = 20;
export const LIST_PAGE_SIZE = 100; // freee の deals の limit の上限

export type ReconcileOptions = {
  providerName: string;
  now: () => Date;
  verifiedLookbackDays?: number;
  maxPages?: number;
};

// 再試行できる失敗があった（その取引は飛ばした）。照合の結果（summary）は持つ。
export class ReconcileIncompleteError extends Error {
  readonly summary: ReconcileSummary;
  readonly errors: { dealId: string; error: string }[];
  constructor(summary: ReconcileSummary, errors: { dealId: string; error: string }[]) {
    super(`照合で ${errors.length} 件が再試行待ち: ${errors.map((e) => `${e.dealId} ${e.error}`).join('; ').slice(0, 1000)}`);
    this.name = 'ReconcileIncompleteError';
    this.summary = summary;
    this.errors = errors;
  }
}

function expectedOf(db: Db, row: DealRow): Expected {
  const d = draftOf(row);
  // 期待する証憑は「アップロード済みの証憑」（下書きを作った時点では無かったものも含む）。
  const receiptIds = row.state === 'deal_created' ? [] : uploadedReceiptIds(db, row.document_id, row.provider);
  return { amount: d.details.reduce((s, x) => s + x.amount, 0), details: d.details, receiptIds };
}

// その取引だけの失敗（4xx）。再認可待ちは全体の失敗なので含めない。
const isDealError = (e: unknown): e is ProviderError => e instanceof ProviderError && !e.retryable && e.kind !== 'auth_invalid_grant';
const describeErr = (e: unknown) => (e instanceof ProviderError ? `${e.kind}${e.status ? `(${e.status})` : ''}: ${e.message}` : e instanceof Error ? e.message : String(e));

export async function reconcileDeals(db: Db, provider: Pick<Provider, 'listDeals' | 'getDeal' | 'attachReceipts'>, opts: ReconcileOptions): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, verified: 0, needsAttention: 0, linked: 0, deferred: 0, failed: 0 };
  const errors: { dealId: string; error: string }[] = [];
  const since = addDays(todayInTokyo(opts.now()), -(opts.verifiedLookbackDays ?? VERIFIED_LOOKBACK_DAYS));
  let rows = db
    .prepare(
      `SELECT * FROM deals WHERE provider = ? AND remote_deal_id IS NOT NULL
         AND (state IN ('deal_created', 'receipt_linked') OR (state = 'verified' AND issue_date >= ?))
       ORDER BY issue_date, id`,
    )
    .all(opts.providerName, since) as DealRow[];
  if (rows.length === 0) return summary;

  // 4xx はその取引を needs_attention に、それ以外は集めて飛ばす。
  const onError = (row: DealRow, e: unknown, reason: AttentionReason) => {
    if (isDealError(e)) {
      markNeedsAttention(db, row.id, reason, { remote_deal_id: Number(row.remote_deal_id), error: describeErr(e), status: e.status }, opts.now());
      summary.needsAttention++;
    } else {
      errors.push({ dealId: row.id, error: describeErr(e) });
      summary.failed++;
    }
  };

  // 証憑がまだ付いていない取引に、アップロード済みの証憑を付ける。
  const next: DealRow[] = [];
  for (const r of rows) {
    try {
      const after = await linkReceiptsIfReady(db, provider, r, opts.now());
      if (after.state !== r.state) summary.linked++;
      next.push(after);
    } catch (e) {
      onError(r, e, e instanceof ProviderError && e.status === 404 ? 'deal_missing' : 'send_rejected');
    }
  }
  rows = next;
  if (rows.length === 0) return finish();

  const start = rows[0].issue_date;
  const end = rows[rows.length - 1].issue_date;
  const listed = new Map<number, Deal>();
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      truncated = true;
      break;
    }
    const got = await provider.listDeals({ startIssueDate: start, endIssueDate: end, limit: LIST_PAGE_SIZE, offset: page * LIST_PAGE_SIZE });
    for (const d of got) listed.set(d.id, d);
    if (got.length < LIST_PAGE_SIZE) break;
  }

  for (const row of rows) {
    const id = Number(row.remote_deal_id);
    let actual: Deal | null = listed.get(id) ?? null;
    if (!actual) {
      if (truncated) {
        summary.deferred++; // 読んでいないページにあるかもしれない。翌日に回す
        continue;
      }
      try {
        actual = await provider.getDeal(id);
      } catch (e) {
        if (!(e instanceof ProviderError && e.kind === 'client' && e.status === 404)) {
          onError(row, e, 'deal_missing');
          continue;
        }
        actual = null;
      }
    }
    summary.checked++;
    const now = opts.now();
    const diffs = compareDeal(expectedOf(db, row), actual);
    if (diffs.length) {
      const reason: AttentionReason = diffs[0].kind;
      markNeedsAttention(db, row.id, reason, { remote_deal_id: id, diffs }, now);
      summary.needsAttention++;
      continue;
    }
    // deal_created（証憑がまだ無い）は一致していても verified にしない（証憑の紐付けが済んでいない）。
    if (row.state === 'deal_created') continue;
    transition(db, row.id, 'verified', { verifiedAt: now.toISOString() }, now, { remote_deal_id: id });
    summary.verified++;
  }
  return finish();

  function finish(): ReconcileSummary {
    if (errors.length) throw new ReconcileIncompleteError(summary, errors);
    return summary;
  }
}
