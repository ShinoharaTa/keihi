// 取引先名の正規化（docs/mvp-plan-v0.1.md T2-2、classification-ocr.md A-5）。vendor_rules のキー（vendor_norm）にする。
// 1. NFKC（全角英数・記号 → 半角、半角カナ → 全角カナ、㈱ → (株)）
// 2. 小文字化
// 3. ハイフン類を "-" に揃える
// 4. 法人格（株式会社・(株)・有限会社・合同会社…、Inc.・Co., Ltd. など）を除く
// 5. 空白を除く
// ひらがなとカタカナは揃えない（別の取引先を同じキーにしないため）。支店名も除かない（区切りが一定しないため）。

const CORP_JA = [
  '株式会社', '有限会社', '合同会社', '合資会社', '合名会社',
  '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人', '特定非営利活動法人', 'npo法人',
  '医療法人社団', '医療法人財団', '医療法人', '社会福祉法人', '学校法人', '宗教法人', '独立行政法人', '国立大学法人',
];
// NFKC 後の括弧付きの略記（㈱ → (株) など）。
const CORP_ABBR = ['株', '有', '合', '同', '名', '資', '社', '財', '医', '学', '特非'];

const HYPHENS = /[‐-―−]/g; // ‐‑‒–—―−（長音「ー」は含めない）
const CORP_JA_RE = new RegExp(CORP_JA.join('|'), 'g');
const CORP_ABBR_RE = new RegExp(`\\((?:${CORP_ABBR.join('|')})\\)`, 'g');
// 英語の法人格。語の区切り（空白・カンマ・ピリオド・端）に挟まれたものだけ。
const CORP_EN_RE = /(^|[\s,.])(?:co\.?,?\s*ltd|co\.?,?\s*inc|inc|ltd|llc|corp|corporation|limited|k\.k|g\.k)\.?(?=$|[\s,.])/g;

export function normalizeVendor(name: string): string {
  let s = name.normalize('NFKC').toLowerCase();
  s = s.replace(HYPHENS, '-');
  s = s.replace(CORP_JA_RE, ' ').replace(CORP_ABBR_RE, ' ');
  // 英語は語の区切りが要るので、空白を除く前に。繰り返し出る（Foo Co., Ltd. Inc.）ことがあるので 2 回。
  for (let i = 0; i < 2; i++) s = s.replace(CORP_EN_RE, '$1');
  s = s.replace(/\s+/g, '');
  // 法人格を除いた後に端に残った区切り記号（", " など）を落とす。
  s = s.replace(/^[,.\-・]+|[,.\-・]+$/g, '');
  return s;
}
