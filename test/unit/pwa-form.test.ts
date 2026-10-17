// PWA の撮影フォームの純関数（docs/mvp-plan-v0.1.md T1-12）。SSR の代わりに、送信ボタンの可否を canSend で試す。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { canSend, emptyFields, isHeic, reasonText, SIZE_PRESETS, todayLocal, type Fields } from '../../pwa/src/capture/form.ts';
import { SIZE_PRESETS as SERVER_PRESETS } from '../../src/ingest/validate.ts';

const TODAY = '2026-10-16';
const base = (over: Partial<Fields> = {}): Fields => ({ ...emptyFields(TODAY, 'pwa'), ...over });

describe('canSend（送信ボタンの disabled）', () => {
  test('既定（種類が未選択）では押せない', () => {
    assert.equal(base().kind, null);
    assert.equal(base().receivedOn, TODAY);
    assert.equal(canSend(base(), TODAY), false);
  });
  test('scan はサイズのプリセットも要る', () => {
    assert.equal(canSend(base({ kind: 'scan' }), TODAY), false);
    assert.equal(canSend(base({ kind: 'scan', sizePreset: 'nope' }), TODAY), false);
    assert.equal(canSend(base({ kind: 'scan', sizePreset: 'a4' }), TODAY), true);
  });
  test('e_transaction は種類だけで押せる', () => {
    assert.equal(canSend(base({ kind: 'e_transaction' }), TODAY), true);
  });
  test('受領日が空・不正・未来なら押せない', () => {
    for (const receivedOn of ['', '2026-02-30', '2026/10/16', '2026-10-17']) {
      assert.equal(canSend(base({ kind: 'e_transaction', receivedOn }), TODAY), false, receivedOn);
    }
    assert.equal(canSend(base({ kind: 'e_transaction', receivedOn: '2026-10-01' }), TODAY), true);
  });
});

describe('isHeic', () => {
  test('MIME か拡張子で HEIC / HEIF を見分ける', () => {
    assert.equal(isHeic('IMG_0001.HEIC', ''), true);
    assert.equal(isHeic('a.heif', 'application/octet-stream'), true);
    assert.equal(isHeic('a', 'image/heic'), true);
    assert.equal(isHeic('a.jpg', 'image/jpeg'), false);
    assert.equal(isHeic('a.pdf', 'application/pdf'), false);
  });
});

describe('その他', () => {
  test('todayLocal は端末のローカル日付', () => {
    assert.equal(todayLocal(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  });
  test('サイズのプリセットはサーバーと同じキー', () => {
    assert.deepEqual(SIZE_PRESETS.map((p) => p.value).sort(), Object.keys(SERVER_PRESETS).sort());
  });
  test('reason の文面（知らないものはそのまま）', () => {
    assert.match(reasonText('resolution_too_low'), /解像度/);
    assert.equal(reasonText('something_new'), 'something_new');
    assert.equal(reasonText(null), '');
  });
});
