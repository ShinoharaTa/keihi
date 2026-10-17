// T2-2 取引先の正規化と辞書引き（docs/mvp-plan-v0.1.md）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { normalizeVendor } from '../../src/vendors/normalize.ts';
import { lookupVendor, recordVendorHit, upsertVendorRule } from '../../src/vendors/dictionary.ts';

// [入力, 期待値]
const CASES: [string, string][] = [
  // 全角半角
  ['ＡＢＣ商店', 'abc商店'],
  ['ABC商店', 'abc商店'],
  ['ｶﾌｪ ﾄﾞﾄｰﾙ', 'カフェドトール'],
  ['カフェ　ドトール', 'カフェドトール'],
  ['１２３ストア', '123ストア'],
  ['ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ', 'セブン-イレブン'],
  // 空白
  ['  テスト  文具店  ', 'テスト文具店'],
  ['テスト\t文具店\n', 'テスト文具店'],
  ['テ ス ト', 'テスト'],
  // 法人格（前・後・略記）
  ['株式会社テスト文具', 'テスト文具'],
  ['テスト文具株式会社', 'テスト文具'],
  ['テスト文具 株式会社', 'テスト文具'],
  ['(株)テスト文具', 'テスト文具'],
  ['（株）テスト文具', 'テスト文具'],
  ['㈱テスト文具', 'テスト文具'],
  ['テスト文具㈱', 'テスト文具'],
  ['有限会社テスト', 'テスト'],
  ['㈲テスト', 'テスト'],
  ['合同会社テスト', 'テスト'],
  ['一般社団法人テスト協会', 'テスト協会'],
  ['特定非営利活動法人テスト', 'テスト'],
  ['NPO法人テスト', 'テスト'],
  ['医療法人社団テスト会', 'テスト会'],
  // 英語の法人格と小文字化
  ['Example Inc.', 'example'],
  ['EXAMPLE INC', 'example'],
  ['Example Co., Ltd.', 'example'],
  ['Example Co.,Ltd.', 'example'],
  ['Example Corporation', 'example'],
  ['Example LLC', 'example'],
  ['Example K.K.', 'example'],
  ['Ｅｘａｍｐｌｅ　Ｉｎｃ．', 'example'],
  // 語の途中の inc / ltd は除かない
  ['Incredible Shop', 'incredibleshop'],
  ['Saltdome', 'saltdome'],
  // ハイフン類（長音は揃えない）
  ['セブン‐イレブン', 'セブン-イレブン'],
  ['セブン－イレブン', 'セブン-イレブン'],
  ['セブン−イレブン', 'セブン-イレブン'],
  ['コーヒー', 'コーヒー'],
  // ひらがなとカタカナは別
  ['すき家', 'すき家'],
  // 法人格だけ・空
  ['株式会社', ''],
  ['', ''],
];

describe('normalizeVendor', () => {
  test(`表駆動 ${CASES.length} 件`, () => {
    assert.ok(CASES.length >= 30);
    for (const [input, want] of CASES) assert.equal(normalizeVendor(input), want, JSON.stringify(input));
  });

  test('冪等', () => {
    for (const [input] of CASES) {
      const once = normalizeVendor(input);
      assert.equal(normalizeVendor(once), once, JSON.stringify(input));
    }
  });
});

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const T1 = 'T1234567890123';
const T2 = 'T9999999999999';

describe('vendor_rules の辞書引き', () => {
  test('正規化名で当たる（表記ゆれを吸収）', () => {
    const db = freshDb();
    upsertVendorRule(db, { name: '株式会社テスト文具', accountId: '101', taxCategory: 'taxable_10', confidence: 0.9, origin: 'manual' });
    const hit = lookupVendor(db, { name: 'ﾃｽﾄ文具 (株)' });
    assert.equal(hit?.matchedBy, 'vendor_norm');
    assert.equal(hit?.accountId, '101');
    assert.equal(hit?.taxCategory, 'taxable_10');
    assert.equal(hit?.confidence, 0.9);
    assert.equal(hit?.hitCount, 0);
  });

  test('登録番号が一致すれば名前が違っても当たり、名前より優先する', () => {
    const db = freshDb();
    upsertVendorRule(db, { name: 'テスト文具', invoiceRegNo: T1, accountId: '101', taxCategory: 'taxable_10', origin: 'learned' });
    upsertVendorRule(db, { name: '別の店', accountId: '102', taxCategory: 'taxable_8_reduced', origin: 'learned' });
    const hit = lookupVendor(db, { name: '別の店', invoiceRegNo: T1 });
    assert.equal(hit?.matchedBy, 'invoice_reg_no');
    assert.equal(hit?.accountId, '101');
    // 登録番号が外れれば名前で引く
    assert.equal(lookupVendor(db, { name: '別の店', invoiceRegNo: T2 })?.accountId, '102');
    // 形式の違う登録番号では引かない
    assert.equal(lookupVendor(db, { name: null, invoiceRegNo: '1234567890123' }), null);
  });

  test('同じ登録番号が複数あれば hit_count の多いほう', () => {
    const db = freshDb();
    upsertVendorRule(db, { name: 'A 店', invoiceRegNo: T1, accountId: '101', taxCategory: null, origin: 'learned', hitCount: 1 });
    upsertVendorRule(db, { name: 'B 店', invoiceRegNo: T1, accountId: '102', taxCategory: null, origin: 'learned', hitCount: 5 });
    assert.equal(lookupVendor(db, { invoiceRegNo: T1 })?.vendorNorm, 'b店');
  });

  test('当たらなければ null。空の名前でも null', () => {
    const db = freshDb();
    assert.equal(lookupVendor(db, { name: 'どこか' }), null);
    assert.equal(lookupVendor(db, { name: '株式会社' }), null);
    assert.equal(lookupVendor(db, {}), null);
  });

  test('recordVendorHit で hit_count と last_used_at が更新される。upsert は hitCount 省略時に値を保つ', () => {
    const db = freshDb();
    upsertVendorRule(db, { name: 'テスト', accountId: '101', taxCategory: null, origin: 'learned', now: new Date('2026-10-01T00:00:00Z') });
    assert.equal(recordVendorHit(db, 'テスト', new Date('2026-10-02T00:00:00Z')), true);
    assert.equal(recordVendorHit(db, 'テスト', new Date('2026-10-03T00:00:00Z')), true);
    let r = lookupVendor(db, { name: 'テスト' });
    assert.equal(r?.hitCount, 2);
    assert.equal(r?.lastUsedAt, '2026-10-03T00:00:00.000Z');
    upsertVendorRule(db, { name: 'テスト', accountId: '102', taxCategory: 'taxable_10', origin: 'manual' });
    r = lookupVendor(db, { name: 'テスト' });
    assert.equal(r?.hitCount, 2);
    assert.equal(r?.accountId, '102');
    assert.equal(r?.origin, 'manual');
    upsertVendorRule(db, { name: 'テスト', accountId: '102', taxCategory: 'taxable_10', origin: 'manual', hitCount: 0 });
    assert.equal(lookupVendor(db, { name: 'テスト' })?.hitCount, 0);
    assert.equal(recordVendorHit(db, '無い', new Date()), false);
  });

  test('書き込みの入力検査', () => {
    const db = freshDb();
    const base = { name: 'テスト', accountId: '101', taxCategory: null, origin: 'learned' as const };
    assert.throws(() => upsertVendorRule(db, { ...base, name: '(株)' }), /空/);
    assert.throws(() => upsertVendorRule(db, { ...base, invoiceRegNo: 'T123' }), /登録番号/);
    assert.throws(() => upsertVendorRule(db, { ...base, confidence: 1.5 }), /確信度/);
    assert.throws(() => upsertVendorRule(db, { ...base, hitCount: -1 }), /hit_count/);
  });
});
