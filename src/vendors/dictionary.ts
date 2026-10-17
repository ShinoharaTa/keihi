// 取引先の辞書（docs/mvp-plan-v0.1.md T2-2、a2ui-review-ui.md §3.5）。vendor_rules を引く。
// 引く順: 登録番号（T + 13 桁）→ 正規化名。登録番号が一致すれば名前が違っても当たる。
// 同じ登録番号の行が複数あれば hit_count の多い順、次に last_used_at の新しい順で 1 件。
// 書き込み（upsertVendorRule・recordVendorHit）は T2-9（学習）が使う。どちらを呼ぶか（上書きするか）の方針は T2-9 で決める。
import type { Db } from '../db/index.ts';
import { normalizeVendor } from './normalize.ts';

export type VendorRule = {
  vendorNorm: string;
  invoiceRegNo: string | null;
  accountId: string | null; // freee の勘定科目 ID
  taxCategory: string | null; // 税率の区分（src/masters/tax-map.ts TAX_CATEGORIES）。列は vendor_rules.tax_id
  creditAccount: string | null;
  confidence: number | null;
  hitCount: number;
  lastUsedAt: string | null;
  origin: 'manual' | 'learned';
};

export type VendorHit = VendorRule & { matchedBy: 'invoice_reg_no' | 'vendor_norm' };

type Row = {
  vendor_norm: string;
  invoice_reg_no: string | null;
  account_id: string | null;
  tax_id: string | null;
  credit_account: string | null;
  confidence: number | null;
  hit_count: number;
  last_used_at: string | null;
  origin: 'manual' | 'learned';
};

const toRule = (r: Row): VendorRule => ({
  vendorNorm: r.vendor_norm,
  invoiceRegNo: r.invoice_reg_no,
  accountId: r.account_id,
  taxCategory: r.tax_id,
  creditAccount: r.credit_account,
  confidence: r.confidence,
  hitCount: r.hit_count,
  lastUsedAt: r.last_used_at,
  origin: r.origin,
});

const REG_NO = /^T\d{13}$/;

export function lookupVendor(db: Db, q: { name?: string | null; invoiceRegNo?: string | null }): VendorHit | null {
  if (q.invoiceRegNo && REG_NO.test(q.invoiceRegNo)) {
    const r = db
      .prepare(
        `SELECT * FROM vendor_rules WHERE invoice_reg_no = ?
         ORDER BY hit_count DESC, last_used_at IS NULL, last_used_at DESC, vendor_norm LIMIT 1`,
      )
      .get(q.invoiceRegNo) as Row | undefined;
    if (r) return { ...toRule(r), matchedBy: 'invoice_reg_no' };
  }
  const norm = q.name ? normalizeVendor(q.name) : '';
  if (norm) {
    const r = db.prepare('SELECT * FROM vendor_rules WHERE vendor_norm = ?').get(norm) as Row | undefined;
    if (r) return { ...toRule(r), matchedBy: 'vendor_norm' };
  }
  return null;
}

export type UpsertVendorRuleInput = {
  name: string; // 正規化前の取引先名
  invoiceRegNo?: string | null;
  accountId: string | null;
  taxCategory: string | null;
  creditAccount?: string | null;
  confidence?: number | null;
  origin: 'manual' | 'learned';
  hitCount?: number; // 省略時は既存の値を保つ（新規は 0）
  now?: Date;
};

// 正規化名をキーに、行を丸ごと書く（既存なら上書き）。書いた行を返す。
export function upsertVendorRule(db: Db, input: UpsertVendorRuleInput): VendorRule {
  const norm = normalizeVendor(input.name);
  if (!norm) throw new Error('正規化した取引先名が空');
  if (input.invoiceRegNo != null && !REG_NO.test(input.invoiceRegNo)) throw new Error('登録番号の形式が T + 13 桁ではない');
  if (input.confidence != null && !(input.confidence >= 0 && input.confidence <= 1)) throw new Error('確信度が 0〜1 ではない');
  if (input.hitCount !== undefined && !(Number.isInteger(input.hitCount) && input.hitCount >= 0)) throw new Error('hit_count が 0 以上の整数ではない');
  const now = (input.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO vendor_rules (vendor_norm, invoice_reg_no, account_id, tax_id, credit_account, confidence, hit_count, last_used_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (vendor_norm) DO UPDATE SET
       invoice_reg_no = excluded.invoice_reg_no, account_id = excluded.account_id, tax_id = excluded.tax_id,
       credit_account = excluded.credit_account, confidence = excluded.confidence,
       hit_count = CASE WHEN ? THEN excluded.hit_count ELSE vendor_rules.hit_count END,
       last_used_at = excluded.last_used_at, origin = excluded.origin`,
  ).run(
    norm,
    input.invoiceRegNo ?? null,
    input.accountId,
    input.taxCategory,
    input.creditAccount ?? null,
    input.confidence ?? null,
    input.hitCount ?? 0,
    now,
    input.origin,
    input.hitCount !== undefined ? 1 : 0,
  );
  return toRule(db.prepare('SELECT * FROM vendor_rules WHERE vendor_norm = ?').get(norm) as Row);
}

// 辞書の提案が使われた（確定された）ときに hit_count を 1 増やす。行が無ければ false。
export function recordVendorHit(db: Db, vendorNorm: string, now: Date = new Date()): boolean {
  const r = db.prepare('UPDATE vendor_rules SET hit_count = hit_count + 1, last_used_at = ? WHERE vendor_norm = ?').run(now.toISOString(), vendorNorm);
  return Number(r.changes) === 1;
}
