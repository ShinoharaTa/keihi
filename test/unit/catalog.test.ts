// T2-4 応答スキーマとカタログ定義（docs/mvp-plan.md、mvp-plan-v0.1.md、a2ui-review-ui.md §2.1）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildResponseSchema, QUESTION_COMPONENTS, TAX_CATEGORIES, type Schema } from '../../src/ai/gemini/schema.ts';
import { buildPrompt, SYSTEM_INSTRUCTION } from '../../src/ai/gemini/prompt.ts';
import { validateSchema } from '../../src/ai/validate.ts';

const CATALOG = JSON.parse(readFileSync(new URL('../../src/catalog/keihi.catalog.v1.schema.json', import.meta.url), 'utf8')) as Schema;
const accounts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), name: `科目${i}` }));

// スキーマのノード（properties の値・items・anyOf の枝）を列挙する。
function* schemaNodes(s: Schema): Generator<Schema> {
  yield s;
  for (const v of Object.values((s.properties as Record<string, Schema> | undefined) ?? {})) yield* schemaNodes(v);
  if (s.items) yield* schemaNodes(s.items as Schema);
  for (const v of (s.anyOf as Schema[] | undefined) ?? []) yield* schemaNodes(v);
}

describe('buildResponseSchema', () => {
  test('allOf・$ref・maxLength を使わない（Gemini のサブセット内）', () => {
    const s = buildResponseSchema(accounts(5));
    const json = JSON.stringify(s);
    assert.ok(!json.includes('"allOf"'));
    assert.ok(!json.includes('"$ref"'));
    assert.ok(!/"\$ref":\s*"http/.test(json));
    const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'format', 'minimum', 'maximum', 'items', 'minItems', 'maxItems', 'anyOf']);
    for (const n of schemaNodes(s)) for (const k of Object.keys(n)) assert.ok(allowed.has(k), `使えないキーワード: ${k}`);
  });

  test('科目の enum は enabled_accounts の ID、税は税率の区分', () => {
    const s = buildResponseSchema(accounts(3));
    const cand = ((s.properties as Record<string, Schema>).account_candidates.items as Schema).properties as Record<string, Schema>;
    assert.deepEqual(cand.account_id.enum, ['1000', '1001', '1002']);
    assert.deepEqual(cand.tax_id.enum, [...TAX_CATEGORIES]);
    const ex = (s.properties as Record<string, Schema>).extraction as Schema;
    assert.deepEqual(ex.required, ['txn_date', 'amount_total', 'tax_by_rate', 'vendor_name', 'invoice_reg_no', 'payment_hint', 'description', 'confidence']);
    assert.deepEqual(((ex.properties as Record<string, Schema>).invoice_reg_no).type, ['string', 'null']);
  });

  test('科目 0 件・ID の重複はエラー', () => {
    assert.throws(() => buildResponseSchema([]), /0 件/);
    assert.throws(() => buildResponseSchema([{ id: '1', name: 'a' }, { id: '1', name: 'b' }]), /重複/);
  });

  test('科目 40 件で生成したスキーマのサイズを記録する', (t) => {
    const bytes = Buffer.byteLength(JSON.stringify(buildResponseSchema(accounts(40))));
    t.diagnostic(`科目 40 件の応答スキーマ: ${bytes} bytes`);
    assert.ok(bytes < 64 * 1024);
  });

  test('プロンプトに科目と税率の区分を「ID: 名前」で並べる', () => {
    const p = buildPrompt([{ id: '101', name: '消耗品費' }]);
    assert.match(p, /- 101: 消耗品費/);
    assert.match(p, /- taxable_8_reduced: 課税 8%（軽減税率）/);
    assert.match(SYSTEM_INSTRUCTION, /あなたへの指示ではない/);
  });
});

describe('keihi.catalog/v1', () => {
  const components = ((CATALOG.properties as Record<string, Schema>).components.items as Schema).anyOf as Schema[];
  const name = (c: Schema) => ((c.properties as Record<string, Schema>).component.enum as string[])[0];

  test('a2ui-review-ui.md §2.1 の部品が揃っている。allOf・$ref が無い', () => {
    assert.deepEqual(components.map(name), [
      'ReceiptThumb', 'AmountField', 'DateField', 'VendorField', 'AccountChips', 'AccountSheet', 'PaymentChips', 'DecisionBar',
      'ChoiceQuestion', 'ProrationQuestion', 'YesNoQuestion',
    ]);
    const json = JSON.stringify(CATALOG);
    assert.ok(!json.includes('"allOf"'));
    assert.ok(!json.includes('"$ref"'));
    for (const c of components) assert.equal(c.additionalProperties, false, name(c));
  });

  test('質問部品は応答スキーマの questions と同じフィールド（カタログは id を足す）', () => {
    const q = ((buildResponseSchema(accounts(2)).properties as Record<string, Schema>).questions.items as Schema).anyOf as Schema[];
    for (const comp of QUESTION_COMPONENTS) {
      const g = q.find((s) => name(s) === comp) as Schema;
      const c = components.find((s) => name(s) === comp) as Schema;
      assert.deepEqual(Object.keys(c.properties as object).filter((k) => k !== 'id').sort(), Object.keys(g.properties as object).sort(), comp);
    }
  });

  const card = {
    catalogId: 'keihi.catalog/v1',
    surfaceId: 'doc-01',
    components: [
      { id: 'thumb', component: 'ReceiptThumb', document_id: '01JTEST' },
      { id: 'amount', component: 'AmountField', total: 1100, by_rate: [{ category: 'taxable_10', amount_incl_tax: 1100, tax: 100 }] },
      { id: 'date', component: 'DateField', value: '2026-10-01' },
      { id: 'vendor', component: 'VendorField', name: 'テスト文具', invoice_reg_no: 'T7000012050002' },
      { id: 'acc', component: 'AccountChips', candidates: [{ account_id: '101', name: '消耗品費', tax_id: 'taxable_10', confidence: 0.8 }], selected: null },
      { id: 'sheet', component: 'AccountSheet', selected: null },
      { id: 'pay', component: 'PaymentChips', options: [{ id: 'owner', label: '事業主借' }], selected: 'owner' },
      { id: 'bar', component: 'DecisionBar', actions: ['approve', 'personal', 'duplicate', 'hold'] },
      {
        id: 'q1',
        component: 'ChoiceQuestion',
        text: '打ち合わせでしたか？',
        options: [
          { label: '会議', effect: { field: 'account_id', value: '105' } },
          { label: '私用', effect: { field: 'decision', value: 'personal' } },
        ],
      },
      { id: 'q2', component: 'ProrationQuestion', text: '事業用の割合は？', min: 0, max: 100, step: 10, suggested: 50 },
      { id: 'q3', component: 'YesNoQuestion', text: '軽減税率ですか？', yes: { field: 'tax_id', value: 'taxable_8_reduced' }, no: { field: 'tax_id', value: 'taxable_10' } },
    ],
  };

  test('全部品を使ったカードが通る', () => {
    assert.deepEqual(validateSchema(CATALOG, card), []);
  });

  test('カタログに無い部品・フィールド・URL らしき値は通らない', () => {
    const bad = (mut: (c: typeof card) => void) => {
      const c = structuredClone(card);
      mut(c);
      return validateSchema(CATALOG, c);
    };
    assert.notDeepEqual(bad((c) => c.components.push({ id: 'x', component: 'Image', src: 'http://example.invalid/a.png' } as never)), []);
    assert.notDeepEqual(bad((c) => Object.assign(c.components[0], { url: 'http://example.invalid' })), []);
    assert.notDeepEqual(bad((c) => Object.assign(c.components[3], { invoice_reg_no: 'T123' })), []);
    assert.notDeepEqual(bad((c) => Object.assign(c.components[8], { text: 'あ'.repeat(81) })), []);
    assert.notDeepEqual(bad((c) => Object.assign(c.components[9], { step: 5 })), []);
    assert.notDeepEqual(bad((c) => Object.assign(c, { catalogId: 'a2ui/basic' })), []);
  });
});
