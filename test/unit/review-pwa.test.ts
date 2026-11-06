// PWA の確認画面の純関数（docs/mvp-plan.md T2-10）。描画する部品の選別と、確定で送る本文（U8）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderableComponents } from '../../pwa/src/review/catalog.ts';
import { reasonText, resolveMessage, resolveUrl } from '../../pwa/src/review/attention.ts';
import { backupWarning } from '../../pwa/src/status.ts';
import { canApprove, changedValues, errorText, missingRequired, parseAmount, pickCandidate, requestBody, type DataModel, type Values } from '../../pwa/src/review/model.ts';

const values = (over: Partial<Values> = {}): Values => ({
  txn_date: '2026-10-14',
  amount: 1100,
  tax_by_rate: [],
  vendor: '店',
  invoice_reg_no: null,
  qualified_invoice: false,
  account_id: '1',
  tax_id: 'taxable_10',
  payment: 'cash',
  proration_pct: 100,
  memo: null,
  ...over,
});
const dm = (v: Values): DataModel => ({ document_id: 'D', status: 'needs_review', deadline_on: '2026-10-26', days_left: 6, version: 2, values: v, sources: {}, accounts: [], warnings: [] });

describe('renderableComponents', () => {
  const surface = (components: unknown[]) => ({ catalogId: 'keihi.catalog/v1', surfaceId: 's', components });

  test('カタログの固定部品だけを通す。知らない部品・質問部品・形の合わない部品は捨てる', () => {
    const r = renderableComponents(
      surface([
        { id: 'a', component: 'DateField', value: '2026-10-14' },
        { id: 'b', component: 'Script', src: 'http://evil/x.js' },
        { id: 'c', component: 'YesNoQuestion', text: 'q', yes: {}, no: {} },
        { id: 'd', component: 'AmountField', total: '1100', by_rate: [] },
        { id: 'e', component: 'VendorField', name: '<script>alert(1)</script><img src=http://x/a.png>', invoice_reg_no: null },
        { id: 'f', component: 'DecisionBar', actions: ['approve', 'hold', 'explode', 'personal'] },
        { id: 'g', component: 'toString' },
        { id: 'h', component: '__proto__' },
        null,
      ]),
    );
    assert.deepEqual(r.map((c) => c.id), ['a', 'e', 'f']);
    // 文字列は加工しない（JSX のテキストとして描画され、エスケープは描画側がする）
    assert.equal((r[1] as { name: string }).name, '<script>alert(1)</script><img src=http://x/a.png>');
    assert.deepEqual((r[2] as { actions: string[] }).actions, ['approve', 'personal']);
  });

  test('カタログ ID が違う surface は何も描画しない', () => {
    assert.deepEqual(renderableComponents({ catalogId: 'other', components: [{ id: 'a', component: 'DateField', value: null }] }), []);
    assert.deepEqual(renderableComponents(null), []);
  });
});

describe('確定の本文（U8）', () => {
  test('変えていなければ values を送らない（1 タップ確定）', () => {
    const v = values();
    assert.deepEqual(requestBody('C', dm(v), v), { card_id: 'C', expected_version: 2 });
  });
  test('第 2 候補を選ぶと科目と税区分が変わり、その項目だけ送る', () => {
    const v = values();
    const d = pickCandidate(v, { account_id: '2', tax_id: 'taxable_8_reduced' });
    assert.deepEqual(changedValues(v, d), { account_id: '2', tax_id: 'taxable_8_reduced' });
    assert.deepEqual(requestBody('C', dm(v), d).values, { account_id: '2', tax_id: 'taxable_8_reduced' });
  });
  test('スキャンのカードだけ integrity_checked を送る（T004）', () => {
    const v = values();
    const scan = { ...dm(v), integrity_checked: false };
    assert.deepEqual(requestBody('C', scan, v, true), { card_id: 'C', expected_version: 2, integrity_checked: true });
    assert.deepEqual(requestBody('C', scan, v, false), { card_id: 'C', expected_version: 2, integrity_checked: false });
    assert.deepEqual(requestBody('C', dm(v), v, true), { card_id: 'C', expected_version: 2 });
  });
  test('確定ボタンは R10 の必須がそろったときだけ押せる', () => {
    assert.equal(canApprove(values()), true);
    assert.equal(canApprove(values({ payment: null })), false);
    assert.deepEqual(missingRequired(values({ payment: null, txn_date: null })), ['txn_date', 'payment']);
  });
});

describe('入力と表示', () => {
  test('parseAmount', () => {
    assert.equal(parseAmount('1,100'), 1100);
    assert.equal(parseAmount('１１００円'), 1100);
    assert.equal(parseAmount('¥ 980'), 980);
    assert.equal(parseAmount('0'), null);
    assert.equal(parseAmount('-5'), null);
    assert.equal(parseAmount('1.5'), null);
    assert.equal(parseAmount(''), null);
  });
  test('errorText', () => {
    assert.equal(errorText(422, { reason: 'missing_required', fields: ['txn_date', 'payment'] }), '未入力: 日付・支払手段');
    assert.match(errorText(409, {}), /読み直しました/);
    assert.match(errorText(0, null), /通信できません/);
    assert.equal(errorText(422, { reason: 'not_sendable', messages: ['内訳を直してください。', '按分を直してください。'] }), '内訳を直してください。 按分を直してください。');
  });
});

describe('要対応タブ（T4-5）', () => {
  test('理由の文言・解消の URL と結果の文', () => {
    assert.equal(reasonText('upload_rejected'), 'freee に証憑を送れませんでした');
    assert.equal(reasonText('something_new'), '要対応（something_new）');
    assert.equal(resolveUrl('01 X'), '/api/documents/01%20X/attention/resolve');
    assert.equal(resolveMessage('retry', 200), 'もう一度試します。');
    assert.equal(resolveMessage('dismiss', 200), '対応済みにしました。');
    assert.match(resolveMessage('retry', 409), /自動では直せません/);
    assert.match(resolveMessage('retry', 0), /通信できません/);
  });
});

describe('バックアップの警告帯', () => {
  const now = new Date('2026-10-17T03:00:00.000Z');
  const drill = (ok: boolean) => ({ at: '2026-10-16T00:00:00.000Z', ok, failure_count: ok ? 0 : 2 });
  test('2 日以内に成功し drill も成功なら出さない。古い・一度も無い・drill 失敗なら出す', () => {
    assert.equal(backupWarning({ last_success_at: '2026-10-15T04:00:00.000Z', last_drill: drill(true) }, now), null);
    assert.equal(backupWarning({ last_success_at: '2026-10-15T04:00:00.000Z', last_drill: null }, now), null);
    assert.match(backupWarning({ last_success_at: '2026-10-15T02:59:59.000Z', last_drill: drill(true) }, now)!, /2026-10-15 から止まっています/);
    assert.match(backupWarning({ last_success_at: null, last_drill: null }, now)!, /一度も成功していません/);
    assert.match(backupWarning({ last_success_at: '2026-10-16T04:00:00.000Z', last_drill: drill(false) }, now)!, /drill/);
    assert.equal(backupWarning(undefined, now), null);
  });
});
