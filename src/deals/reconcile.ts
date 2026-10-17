// 日次照合（docs/mvp-plan.md T4-4）。keihi が作った取引を freee から読み、送った内容と比べる。
// - 一致（金額・科目・receipt_ids）なら verified。freee 側で人が編集した差分は報告するだけ（上書きしない）:
//   「取引が消えた」「証憑が外れた」「金額が変わった」「科目が変わった」は needs_attention。
// - 対象: deal_created・receipt_linked・verified（remote_deal_id があるもの）。needs_attention は人の対応待ちなので見ない。
// - deal_created で証憑がアップロード済みになっていれば、照合の前に attachReceipts で付ける（stateMachine.ts）。
// - 取得は発生日の範囲（最小〜最大）の listDeals 1 回。一覧に無いものは getDeal で確かめる（404 = 消えた。
//   人が発生日を変えた取引は一覧から外れるため）。
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

export type ReconcileSummary = { checked: number; verified: number; needsAttention: number; linked: number };

function expectedOf(db: Db, row: DealRow): Expected {
  const d = draftOf(row);
  // 期待する証憑は「アップロード済みの証憑」（下書きを作った時点では無かったものも含む）。
  const receiptIds = row.state === 'deal_created' ? [] : uploadedReceiptIds(db, row.document_id, row.provider);
  return { amount: d.details.reduce((s, x) => s + x.amount, 0), details: d.details, receiptIds };
}

export async function reconcileDeals(
  db: Db,
  provider: Pick<Provider, 'listDeals' | 'getDeal' | 'attachReceipts'>,
  opts: { providerName: string; now: () => Date },
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, verified: 0, needsAttention: 0, linked: 0 };
  let rows = db
    .prepare(`SELECT * FROM deals WHERE provider = ? AND state IN ('deal_created', 'receipt_linked', 'verified') AND remote_deal_id IS NOT NULL ORDER BY issue_date, id`)
    .all(opts.providerName) as DealRow[];
  if (rows.length === 0) return summary;

  // 証憑がまだ付いていない取引に、アップロード済みの証憑を付ける。
  const next: DealRow[] = [];
  for (const r of rows) {
    const after = await linkReceiptsIfReady(db, provider, r, opts.now());
    if (after.state !== r.state) summary.linked++;
    next.push(after);
  }
  rows = next;

  const start = rows[0].issue_date;
  const end = rows[rows.length - 1].issue_date;
  const listed = new Map((await provider.listDeals({ startIssueDate: start, endIssueDate: end })).map((d) => [d.id, d]));

  for (const row of rows) {
    const id = Number(row.remote_deal_id);
    let actual: Deal | null = listed.get(id) ?? null;
    if (!actual) {
      try {
        actual = await provider.getDeal(id);
      } catch (e) {
        if (!(e instanceof ProviderError && e.kind === 'client' && e.status === 404)) throw e;
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
  return summary;
}
