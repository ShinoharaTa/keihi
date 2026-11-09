// 明細の選択モードと一括の操作（#74 PR4。pwa/src/money/selection.ts・BulkBar.tsx・Txns.tsx の TxnList）。
// 純関数（選択・範囲・全選択・長押し・Esc・絞り込み結果の収集・結果の文）と、描画だけの部品の SSR スナップショット（wide=false / true の 2 通り）。
// スナップショットは money-select.test.ts.snapshot。描画を変えたら `node --test --test-update-snapshots test/unit/money-select.test.ts` で作り直して差分を見る。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import type { ViteDevServer } from 'vite';
import type { Categories, Txn, TxnPage } from '../../pwa/src/money/model.ts';
import {
  allSelected,
  applyEffective,
  BULK_MAX,
  bulkBody,
  bulkNotice,
  clearSel,
  collectFiltered,
  emptySelection,
  escAction,
  LONG_PRESS_MS,
  longPress,
  rangeSel,
  revertFailText,
  revertNotice,
  rowAction,
  selectAll,
  toggleSel,
  TOO_MANY_TEXT,
  type Selection,
} from '../../pwa/src/money/selection.ts';
import { lines, pretty, renderHtml, startSsr } from './pwa-ssr-helpers.ts';

process.env.TZ = 'Asia/Tokyo';
const TODAY = '2026-11-06';
const noop = () => {};
const ORDER = ['A', 'B', 'C', 'D', 'E'];
const sel = (ids: string[], anchor: string | null = null): Selection => ({ ids: new Set(ids), anchor });
const ids = (s: Selection) => [...s.ids].sort();

const cats: Categories = {
  items: [
    { id: 'food', label: '食費' },
    { id: 'daily', label: '日用品' },
    { id: 'telecom', label: '通信' },
  ],
  uncategorized_label: '未分類',
};

const txn = (over: Partial<Txn> = {}): Txn => ({
  id: 'T1',
  account_id: 'A1',
  account_name: 'テスト銀行 普通',
  txn_date: '2026-11-05',
  amount: 2000,
  side: 'expense',
  description: 'テスト通信 ご利用料金',
  balance: null,
  tag: 'business',
  category: 'telecom',
  tag_source: 'rule',
  excluded: false,
  transfer_kind: null,
  ...over,
});

describe('選択の純関数（selection.ts）', () => {
  test('toggle: 選ぶと anchor をその行に、外しても anchor は変えない', () => {
    const a = toggleSel(emptySelection(), 'B');
    assert.deepEqual(ids(a), ['B']);
    assert.equal(a.anchor, 'B');
    const b = toggleSel(a, 'D');
    assert.deepEqual(ids(b), ['B', 'D']);
    assert.equal(b.anchor, 'D');
    const c = toggleSel(b, 'B');
    assert.deepEqual(ids(c), ['D']);
    assert.equal(c.anchor, 'D');
    assert.deepEqual(ids(a), ['B'], '元の選択は変えない');
  });

  test('範囲: anchor から対象まで（順方向・逆方向）、見えている行の順で間を全部。anchor は変えない', () => {
    const fwd = rangeSel(sel(['B'], 'B'), 'D', ORDER);
    assert.deepEqual(ids(fwd), ['B', 'C', 'D']);
    assert.equal(fwd.anchor, 'B');
    const back = rangeSel(sel(['D'], 'D'), 'A', ORDER);
    assert.deepEqual(ids(back), ['A', 'B', 'C', 'D']);
    assert.equal(back.anchor, 'D');
    // 前から選んでいた行は残す
    assert.deepEqual(ids(rangeSel(sel(['E', 'B'], 'B'), 'C', ORDER)), ['B', 'C', 'E']);
    // 順は id の並びではなく見えている行の順
    assert.deepEqual(ids(rangeSel(sel(['X'], 'X'), 'Z', ['X', 'M', 'Z', 'A'])), ['M', 'X', 'Z']);
  });

  test('範囲: anchor が無い・見えていなければ 1 件の切り替え', () => {
    const none = rangeSel(emptySelection(), 'C', ORDER);
    assert.deepEqual(ids(none), ['C']);
    assert.equal(none.anchor, 'C');
    assert.deepEqual(ids(rangeSel(sel(['Q'], 'Q'), 'C', ORDER)), ['C', 'Q']);
  });

  test('全選択（見えている行）・すべて選ばれているか・解除', () => {
    const all = selectAll(sel(['Q'], 'Q'), ORDER);
    assert.deepEqual(ids(all), ['A', 'B', 'C', 'D', 'E', 'Q']);
    assert.equal(all.anchor, 'Q');
    assert.equal(allSelected(all, ORDER), true);
    assert.equal(allSelected(sel(['A', 'B']), ORDER), false);
    assert.equal(allSelected(emptySelection(), []), false, '行が無ければ選ばれていない');
    const c = clearSel();
    assert.equal(c.ids.size, 0);
    assert.equal(c.anchor, null);
  });

  test('行の操作: スマホは押下で開く/切り替え・長押しで入る/範囲、PC はチェック（Shift で範囲）だけで選び、行は開く', () => {
    assert.equal(rowAction({ wide: false, selecting: false, via: 'tap' }), 'open');
    assert.equal(rowAction({ wide: false, selecting: true, via: 'tap' }), 'toggle');
    assert.equal(rowAction({ wide: false, selecting: false, via: 'long' }), 'toggle');
    assert.equal(rowAction({ wide: false, selecting: true, via: 'long' }), 'range');
    assert.equal(rowAction({ wide: false, selecting: true, via: 'check' }), 'toggle');
    assert.equal(rowAction({ wide: true, selecting: false, via: 'check' }), 'toggle');
    assert.equal(rowAction({ wide: true, selecting: true, via: 'check', shift: true }), 'range');
    assert.equal(rowAction({ wide: true, selecting: true, via: 'tap' }), 'open', 'PC は選択中も行を押すとシート');
    assert.equal(rowAction({ wide: true, selecting: true, via: 'long' }), null, 'PC は長押しを使わない');
  });

  test('Esc: カテゴリの一覧 → 選択の解除。シートを開いている間はシートに任せる', () => {
    assert.equal(escAction({ key: 'Escape', sheetOpen: false, pickerOpen: true, selecting: true }), 'picker');
    assert.equal(escAction({ key: 'Escape', sheetOpen: false, pickerOpen: false, selecting: true }), 'clear');
    assert.equal(escAction({ key: 'Escape', sheetOpen: false, pickerOpen: false, selecting: false }), null);
    assert.equal(escAction({ key: 'Escape', sheetOpen: true, pickerOpen: false, selecting: true }), null);
    assert.equal(escAction({ key: 'Enter', sheetOpen: false, pickerOpen: false, selecting: true }), null);
  });

  test('長押し: 500ms で発火し、その後の click を 1 回だけ捨てる。動いた・離した・取り消しでは発火しない', () => {
    let pending: { fn: () => void; ms: number } | null = null;
    const timers = { set: (fn: () => void, ms: number) => (pending = { fn, ms }), clear: () => (pending = null) };
    const fired: string[] = [];
    const p = longPress((id) => fired.push(id), timers);
    p.down('A', 100, 100);
    assert.equal(pending!.ms, LONG_PRESS_MS);
    p.move(104, 103); // 5px は許す
    pending!.fn();
    assert.deepEqual(fired, ['A']);
    assert.equal(p.consumeClick(), true);
    assert.equal(p.consumeClick(), false, '捨てるのは 1 回だけ');
    p.down('B', 0, 0);
    p.move(0, 12); // スクロール
    assert.equal(pending, null);
    p.down('C', 0, 0);
    p.up(); // 離した・pointercancel
    assert.equal(pending, null);
    assert.deepEqual(fired, ['A']);
    assert.equal(p.consumeClick(), false, '発火していなければ click は通す');
  });

  test('絞り込み結果をすべて選択: next_cursor をたどって集める。500 件を超えたら選ばない。失敗はそのまま返す', async () => {
    const pages = (n: number, size: number) => {
      const calls: (string | null)[] = [];
      const page = async (cursor: string | null) => {
        calls.push(cursor);
        const i = cursor === null ? 0 : Number(cursor);
        const items = Array.from({ length: Math.min(size, n - i * size) }, (_, k) => txn({ id: `T${i * size + k}` }));
        const data: TxnPage = { items, next_cursor: (i + 1) * size < n ? String(i + 1) : null };
        return { ok: true as const, data };
      };
      return { calls, page };
    };
    const a = pages(250, 100);
    const r = await collectFiltered(a.page);
    assert.equal(r.kind, 'ok');
    assert.equal(r.kind === 'ok' && r.ids.length, 250);
    assert.deepEqual(a.calls, [null, '1', '2']);
    const exact = pages(BULK_MAX, 100);
    assert.equal((await collectFiltered(exact.page)).kind, 'ok', 'ちょうど 500 件は選べる');
    const over = pages(BULK_MAX + 1, 100);
    assert.deepEqual(await collectFiltered(over.page), { kind: 'too_many' });
    assert.equal(over.calls.length, 6, '超えた所で止める');
    assert.equal(TOO_MANY_TEXT, '500 件までです。絞り込んでください。');
    const fail = await collectFiltered(async () => ({ ok: false as const, status: 0, body: null }));
    assert.deepEqual(fail, { kind: 'error', status: 0, body: null });
  });

  test('一括の本文・結果の文（作ったルールだけ「消す」）・取り消しの結果と 409 の文', () => {
    assert.deepEqual(bulkBody(new Set(['A', 'B']), { tag: 'business' }), { ids: ['A', 'B'], tag: 'business' });
    assert.deepEqual(bulkBody(['A'], { category: null }), { ids: ['A'], category: null });
    const rule = (id: string, action: 'created' | 'hit' | 'superseded') => ({ rule: { id }, action });
    const n = bulkNotice({ batch_id: 'B1', changed: 12, unchanged: 3, learned_rules: [rule('R1', 'created'), rule('R2', 'hit'), rule('R3', 'superseded')], effective: [] });
    assert.deepEqual(n, { text: '12 件を変えました（3 件は変わらず）', undo: 'B1', rules: ['R1'], rulesText: 'ルールを 1 件作りました' });
    assert.equal(bulkNotice({ batch_id: 'B2', changed: 5, unchanged: 0, learned_rules: [], effective: [] }).text, '5 件を変えました');
    assert.deepEqual(bulkNotice({ batch_id: null, changed: 0, unchanged: 4, learned_rules: [], effective: [] }), { text: '変わった明細はありません（4 件は変わらず）', undo: null, rules: [], rulesText: '' });
    assert.equal(revertNotice({ batch_id: 'B1', revert_batch_id: 'B9', reverted: 10, skipped: 2, learned_rule_ids: [] }).text, '10 件を元に戻しました（2 件は後から変更済みのため戻せません）');
    const rv = revertNotice({ batch_id: 'B1', revert_batch_id: 'B9', reverted: 3, skipped: 0, learned_rule_ids: ['R1'] });
    assert.deepEqual(rv, { text: '3 件を元に戻しました', undo: null, rules: ['R1'], rulesText: 'この一括で作ったルール 1 件は残っています' });
    assert.equal(revertFailText(409, { error: 'nothing_to_revert' }), 'すべて後から変更済みのため戻せません');
    assert.equal(revertFailText(409, { error: 'already_reverted' }), 'もう戻してあります');
    assert.equal(revertFailText(404, { error: 'not_found' }), null);
  });

  test('一括の effective で行を差し替える（事業でなくなったら receipt を外す）', () => {
    const items = [txn({ id: 'A', receipt: 'waiting' }), txn({ id: 'B' }), txn({ id: 'C', tag: 'unset', category: null, tag_source: 'none' })];
    const out = applyEffective(items, [
      { id: 'A', tag: 'private', category: 'telecom', tag_source: 'override' },
      { id: 'C', tag: 'business', category: 'food', tag_source: 'override' },
    ]);
    assert.deepEqual(
      out.map((t) => [t.id, t.tag, t.category, t.tag_source, t.receipt ?? null]),
      [
        ['A', 'private', 'telecom', 'override', null],
        ['B', 'business', 'telecom', 'rule', null],
        ['C', 'business', 'food', 'override', null],
      ],
    );
    assert.equal(out[1], items[1], '変わらない行はそのまま');
  });
});

describe('SSR スナップショット（選択モード・一括）', () => {
  let vite: ViteDevServer;
  const load = (p: string) => vite.ssrLoadModule(p) as Promise<Record<string, (props: any) => unknown>>;
  before(async () => {
    vite = await startSsr();
  });
  after(async () => {
    await vite.close();
  });
  const html = (c: (props: never) => unknown, props: object) => pretty(renderHtml(h(c as never, props as never)));
  const rows = [
    txn({ id: 'T0', txn_date: TODAY, description: 'テストストア', account_name: 'テスト Pay', amount: 1300, tag: 'unset', category: null, tag_source: 'none' }),
    txn({ id: 'T1', txn_date: TODAY }),
    txn({ id: 'T2', side: 'income', amount: 300000, description: '振込 テスト商事', tag: 'private', category: null }),
    txn({ id: 'T3', amount: 10000, description: 'テスト Pay チャージ', excluded: true, transfer_kind: 'charge', tag: 'private', category: null }),
  ];
  const f = { period: 'this', accountId: '', tag: '', category: '', q: '' };
  const listProps = { items: rows, f, today: TODAY, more: true, cats, busyIds: [], hint: false, onHint: noop, onOpen: noop, onToggle: noop, onCheck: noop };
  const amounts = ['−1,300', '−2,000', '+300,000', '10,000'];
  const BUTTONS = ['事業', '私用', '未設定', 'カテゴリ ▾', '選択を外す'];
  const buttonTexts = (s: string) => [...s.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!.trim());

  test('一覧: 通常（モード外のスマホは今までと同じ）・スマホの選択モード・PC（行頭に常にチェック）。同じ金額', async (t) => {
    const m = await load('/src/money/Txns.tsx');
    const before = html(m.TxnList!, listProps);
    const phone = html(m.TxnList!, { ...listProps, sel: { wide: false, selecting: false, ids: new Set() } });
    assert.equal(phone, before, 'モードに入らなければスマホの一覧の DOM は変えない');
    const phoneSel = html(m.TxnList!, { ...listProps, sel: { wide: false, selecting: true, ids: new Set(['T1', 'T2']) } });
    const pc = html(m.TxnList!, { ...listProps, sel: { wide: true, selecting: false, ids: new Set() } });
    const pcSel = html(m.TxnList!, { ...listProps, sel: { wide: true, selecting: true, ids: new Set(['T1', 'T2']) } });
    for (const out of [phone, phoneSel, pc, pcSel]) for (const a of amounts) assert.ok(out.includes(`>${a}<`), `金額 ${a}`);
    assert.doesNotMatch(phone, /m-check/);
    assert.equal((phoneSel.match(/class="m-check"/g) ?? []).length, 4, 'モード中は各行の左にチェック');
    assert.doesNotMatch(phoneSel, /m-tagbtn|m-tagspace/, 'モード中は右端のタグのトグルを隠す');
    assert.match(phoneSel, /m-txn m-txn-sel m-txn-on"><span class="m-checkwrap"><input type="checkbox" class="m-check" checked aria-label="選ぶ: テスト通信 ご利用料金">/);
    assert.equal((pc.match(/class="m-check"/g) ?? []).length, 4, 'PC は行頭に常にチェック');
    assert.match(pc, /m-tagbtn/, 'PC は右端のタグも残す');
    assert.equal((pcSel.match(/ checked /g) ?? []).length, 2);
    t.assert.snapshot(lines([phoneSel, pc, pcSel].join('\n')));
  });

  test('上の帯: スマホは「n 件選択中 ・ すべて選択 ・ 完了」、PC はチェック・件数・完了。絞り込み結果をすべて選択・直前の一括を元に戻す', async (t) => {
    const m = await load('/src/money/BulkBar.tsx');
    const phone = html(m.SelectBand!, { wide: false, count: 12, allChecked: false, onAll: noop, onDone: noop });
    const pc = html(m.SelectBand!, { wide: true, count: 12, allChecked: false, onAll: noop, onDone: noop });
    const pc0 = html(m.SelectBand!, { wide: true, count: 0, allChecked: false, onAll: noop, onDone: noop });
    const pcAll = html(m.SelectBand!, { wide: true, count: 4, allChecked: true, onAll: noop, onDone: noop });
    for (const out of [phone, pc]) {
      assert.match(out, /12 件選択中/);
      assert.match(out, /すべて選択/);
      assert.ok(buttonTexts(out).includes('完了'));
    }
    assert.match(phone, /^<header class="m-head m-head-flat m-selhead">/);
    assert.doesNotMatch(pc0, /完了|件選択中/);
    assert.match(pcAll, /class="m-check" checked aria-label="すべて選択（見えている行）"/);
    const tools = html(m.SelectTools!, { filtered: '50+', busy: false, notice: TOO_MANY_TEXT, undoLast: true, onFiltered: noop, onUndoLast: noop });
    assert.deepEqual(buttonTexts(tools), ['絞り込み結果をすべて選択（50+ 件）', '直前の一括を元に戻す']);
    assert.match(tools, /500 件までです。絞り込んでください。/);
    const busy = html(m.SelectTools!, { filtered: '50+', busy: true, notice: '', undoLast: false, onFiltered: noop, onUndoLast: noop });
    assert.match(busy, /<button type="button" class="m-btn" disabled>絞り込み結果をすべて選択/);
    t.assert.snapshot(lines([phone, pc, pc0, pcAll, tools, busy].join('\n')));
  });

  test('操作の帯・カテゴリの一覧（スマホはシート、PC はポップオーバー）: 同じボタン', async (t) => {
    const m = await load('/src/money/BulkBar.tsx');
    const bar = (wide: boolean, busy = false) => html(m.BulkBar!, { wide, count: 12, busy, picker: false, onTag: noop, onPicker: noop, onClear: noop });
    const phone = bar(false);
    const pc = bar(true);
    assert.deepEqual(buttonTexts(phone), BUTTONS);
    assert.deepEqual(buttonTexts(pc), BUTTONS);
    for (const out of [phone, pc]) assert.match(out, /<span class="m-bulk-count">12 件<\/span>/);
    assert.match(phone, /^<div class="m-bulkbar" role="toolbar"/);
    assert.match(pc, /^<div class="m-bulkbar m-bulkbar-wide" role="toolbar"/);
    assert.equal((bar(false, true).match(/ disabled>/g) ?? []).length, 5, '送っている間は押せない');
    const pick = (wide: boolean) => html(m.CategoryPicker!, { wide, count: 12, cats, onPick: noop, onClose: noop });
    const sheet = pick(false);
    const pop = pick(true);
    const CATS = ['食費', '日用品', '通信', '未分類'];
    assert.deepEqual(buttonTexts(sheet).filter((x) => x !== ''), CATS, 'シートは閉じる（アイコン）とカテゴリ + 未分類');
    assert.deepEqual(buttonTexts(pop), CATS);
    assert.match(sheet, /class="m-scrim"[\s\S]*class="m-sheet" role="dialog" aria-modal="true"[\s\S]*カテゴリを変える（12 件）/);
    assert.match(pop, /class="m-pop" role="dialog" aria-label="カテゴリを変える（12 件）"/);
    assert.doesNotMatch(pop + sheet, /新しく作る/);
    t.assert.snapshot(lines([phone, pc, sheet, pop].join('\n')));
  });

  test('結果の帯: 「n 件を変えました（m 件は変わらず）・元に戻す」「ルールを k 件作りました・消す」。同じ文と同じボタン', async (t) => {
    const m = await load('/src/money/BulkBar.tsx');
    const n = bulkNotice({ batch_id: 'B1', changed: 12, unchanged: 3, learned_rules: [{ rule: { id: 'R1' }, action: 'created' }], effective: [] });
    const band = (wide: boolean, notice = n) => html(m.BulkNoticeBand!, { wide, notice, busy: false, onUndo: noop, onDeleteRules: noop });
    const phone = band(false);
    const pc = band(true);
    for (const out of [phone, pc]) {
      assert.match(out, /12 件を変えました（3 件は変わらず）/);
      assert.match(out, /ルールを 1 件作りました/);
      assert.deepEqual(buttonTexts(out), ['元に戻す', '消す']);
    }
    const rv = band(false, revertNotice({ batch_id: 'B1', revert_batch_id: 'B9', reverted: 10, skipped: 2, learned_rule_ids: [] }));
    assert.deepEqual(buttonTexts(rv), [], '戻した後は「元に戻す」を出さない');
    assert.match(rv, /10 件を元に戻しました（2 件は後から変更済みのため戻せません）/);
    const none = band(true, bulkNotice({ batch_id: null, changed: 0, unchanged: 4, learned_rules: [], effective: [] }));
    assert.deepEqual(buttonTexts(none), []);
    t.assert.snapshot(lines([phone, pc, rv, none].join('\n')));
  });
});
