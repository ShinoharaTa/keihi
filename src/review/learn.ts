// 学習（docs/mvp-plan.md T2-9、mvp-plan-v0.1.md T2-9、a2ui-review-ui.md §3.5）。確定（approve・personal）のたびに vendor_rules を更新する。
// - 行が無い: origin=learned、hit_count=1 で作る。
// - learned の行: 科目が同じなら hit_count + 1（税率の区分・支払手段・登録番号は確定の値で上書き）。
//   科目が変わったら確定の科目で上書きし、hit_count を 1 からにする（hit_count は「同じ科目で確定した回数」）。
// - manual の行: 上書きしない。科目が同じなら hit_count + 1 だけ（recordVendorHit）。
// - 確信度（confidence）は変えない（規則が仕様に無いので、既存の値を保つ。新しい行は null）。
// - 提案（カードの第 1 候補）と確定の科目が食い違ったら vendor_rules.mismatch_count + 1。
// - 私用（personal）は事業主貸として学習する（科目が空なら学習しない）。取引先名が無いものも学習しない。
// - audit に rule.learned（actor = keihi）を残す。
import { appendAudit } from '../audit.ts';
import type { Db } from '../db/index.ts';
import { recordVendorHit, upsertVendorRule } from '../vendors/dictionary.ts';
import { normalizeVendor } from '../vendors/normalize.ts';
import type { Values } from './fields.ts';

export type LearnResult = {
  vendor_norm: string;
  op: 'created' | 'hit' | 'replaced' | 'manual_hit' | 'manual_kept';
  hit_count: number;
  mismatch: boolean;
};

export type LearnInput = { documentId: string; reviewId: string; values: Values; proposedAccountId: string | null; now: Date };

type RuleRow = { vendor_norm: string; account_id: string | null; invoice_reg_no: string | null; confidence: number | null; hit_count: number; origin: 'manual' | 'learned' };

export function learnFromReview(db: Db, input: LearnInput): LearnResult | null {
  const v = input.values;
  if (!v.vendor || !v.account_id) return null;
  const norm = normalizeVendor(v.vendor);
  if (!norm) return null;
  const mismatch = input.proposedAccountId !== null && input.proposedAccountId !== v.account_id;
  const row = db.prepare('SELECT vendor_norm, account_id, invoice_reg_no, confidence, hit_count, origin FROM vendor_rules WHERE vendor_norm = ?').get(norm) as RuleRow | undefined;

  let op: LearnResult['op'];
  if (!row) {
    upsertVendorRule(db, { name: v.vendor, invoiceRegNo: v.invoice_reg_no, accountId: v.account_id, taxCategory: v.tax_id, creditAccount: v.payment, origin: 'learned', hitCount: 1, now: input.now });
    op = 'created';
  } else if (row.origin === 'manual') {
    if (row.account_id === v.account_id) {
      recordVendorHit(db, norm, input.now);
      op = 'manual_hit';
    } else op = 'manual_kept';
  } else {
    const sameAccount = row.account_id === v.account_id;
    upsertVendorRule(db, {
      name: v.vendor,
      invoiceRegNo: v.invoice_reg_no ?? row.invoice_reg_no,
      accountId: v.account_id,
      taxCategory: v.tax_id,
      creditAccount: v.payment,
      confidence: row.confidence,
      origin: 'learned',
      hitCount: sameAccount ? row.hit_count + 1 : 1,
      now: input.now,
    });
    op = sameAccount ? 'hit' : 'replaced';
  }
  if (mismatch) db.prepare('UPDATE vendor_rules SET mismatch_count = mismatch_count + 1 WHERE vendor_norm = ?').run(norm);
  const after = db.prepare('SELECT hit_count FROM vendor_rules WHERE vendor_norm = ?').get(norm) as { hit_count: number };
  const result: LearnResult = { vendor_norm: norm, op, hit_count: after.hit_count, mismatch };
  appendAudit(
    db,
    {
      actor: 'keihi',
      action: 'rule.learned',
      entity: 'vendor_rule',
      entityId: norm,
      payload: { ...result, document_id: input.documentId, review_id: input.reviewId, account_id: v.account_id, tax_id: v.tax_id, credit_account: v.payment },
    },
    input.now,
  );
  return result;
}
