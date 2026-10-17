// PWA の送信待ちキュー（docs/mvp-plan-v0.1.md T1-12）。IndexedDB の代わりにメモリの QueueStore で試す。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Fields } from '../../pwa/src/capture/form.ts';
import { classify, createFlusher, flush, markPending, toFormData, type QueueItem, type QueueStore, type Send } from '../../pwa/src/queue/queue.ts';

class MemoryStore implements QueueStore {
  items = new Map<string, QueueItem>();
  async list() {
    return [...this.items.values()];
  }
  async put(item: QueueItem) {
    this.items.set(item.id, item);
  }
  async remove(id: string) {
    this.items.delete(id);
  }
}

const FIELDS: Fields = { kind: 'scan', sizePreset: 'receipt58', receivedOn: '2026-10-16', noAi: false, force: false, source: 'pwa' };

function item(id: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    createdAt: `2026-10-16T00:00:0${id}.000Z`,
    name: `r${id}.jpg`,
    type: 'image/jpeg',
    blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, Number(id)])], { type: 'image/jpeg' }),
    fields: FIELDS,
    state: 'pending',
    attempts: 0,
    lastError: null,
    ...over,
  };
}

async function storeWith(...items: QueueItem[]): Promise<MemoryStore> {
  const s = new MemoryStore();
  for (const i of items) await s.put(i);
  return s;
}

// 応答を順に返す send。'net' は通信失敗。送ったファイル名を記録する。
function sender(responses: (number | 'net' | { status: number; body: unknown })[]) {
  const sent: string[] = [];
  const send: Send = async (fd) => {
    sent.push((fd.get('file') as File).name);
    const r = responses.shift();
    if (r === undefined) throw new Error('想定より多く送った');
    if (r === 'net') throw new TypeError('Failed to fetch');
    return typeof r === 'number' ? { status: r, body: { reason: `r${r}` } } : r;
  };
  return { send, sent };
}

describe('classify', () => {
  test('201 は完了、409 は重複（届いている）', () => {
    assert.equal(classify(201), 'done');
    assert.equal(classify(409), 'duplicate');
  });
  test('5xx・401・403・408・429 は再送', () => {
    for (const s of [500, 502, 503, 401, 403, 408, 429]) assert.equal(classify(s), 'retry', String(s));
  });
  test('それ以外の 4xx は rejected', () => {
    for (const s of [400, 404, 413, 415, 422]) assert.equal(classify(s), 'rejected', String(s));
  });
  test('403 のうちサーバーの設定エラー（forbidden・invalid_origin）は rejected、ほかの 403 は再送', () => {
    assert.equal(classify(403, { reason: 'forbidden' }), 'rejected');
    assert.equal(classify(403, { reason: 'invalid_origin' }), 'rejected');
    assert.equal(classify(403, { reason: 'rate_limited' }), 'retry');
    assert.equal(classify(403, null), 'retry');
  });
});

describe('toFormData', () => {
  test('取り込み API のフィールド名で送る', () => {
    const fd = toFormData(item('1', { fields: { ...FIELDS, noAi: true, force: true, source: 'share' } }));
    assert.equal((fd.get('file') as File).name, 'r1.jpg');
    assert.equal(fd.get('kind'), 'scan');
    assert.equal(fd.get('size_preset'), 'receipt58');
    assert.equal(fd.get('received_on'), '2026-10-16');
    assert.equal(fd.get('no_ai'), 'true');
    assert.equal(fd.get('force'), 'true');
    assert.equal(fd.get('source'), 'share');
  });
  test('e_transaction は size_preset を送らない', () => {
    const fd = toFormData(item('1', { fields: { ...FIELDS, kind: 'e_transaction' } }));
    assert.equal(fd.get('size_preset'), null);
    assert.equal(fd.get('no_ai'), 'false');
  });
});

describe('flush', () => {
  test('古い順に送り、201 と 409 はキューから消す', async () => {
    const s = await storeWith(item('2'), item('1'), item('3'));
    const { send, sent } = sender([201, { status: 409, body: { reason: 'duplicate', id: 'X' } }, 201]);
    const r = await flush(s, send);
    assert.deepEqual(sent, ['r1.jpg', 'r2.jpg', 'r3.jpg']);
    assert.equal(s.items.size, 0);
    assert.deepEqual(
      r.sent.map((x) => x.outcome),
      ['done', 'duplicate', 'done'],
    );
    assert.equal(r.retryLater, 0);
  });
  test('通信できなければ残して止める（attempts を増やす）', async () => {
    const s = await storeWith(item('1'), item('2'));
    const { send, sent } = sender(['net']);
    const r = await flush(s, send);
    assert.deepEqual(sent, ['r1.jpg']);
    assert.equal(r.retryLater, 2);
    assert.equal(s.items.get('1')!.attempts, 1);
    assert.equal(s.items.get('1')!.lastError, 'network');
    assert.equal(s.items.get('1')!.state, 'pending');
    assert.equal(s.items.get('2')!.attempts, 0);
  });
  test('503・401 は残して止める', async () => {
    for (const status of [503, 401]) {
      const s = await storeWith(item('1'), item('2'));
      const { send, sent } = sender([status]);
      const r = await flush(s, send);
      assert.deepEqual(sent, ['r1.jpg']);
      assert.equal(r.retryLater, 2);
      assert.equal(s.items.get('1')!.state, 'pending');
      assert.equal(s.items.get('1')!.lastError, `r${status}`);
    }
  });
  test('422 は rejected にして残し、次へ進む（捨てない）', async () => {
    const s = await storeWith(item('1'), item('2'));
    const { send } = sender([{ status: 422, body: { reason: 'resolution_too_low' } }, 201]);
    const r = await flush(s, send);
    assert.equal(r.rejected, 1);
    assert.equal(s.items.size, 1);
    assert.equal(s.items.get('1')!.state, 'rejected');
    assert.equal(s.items.get('1')!.lastError, 'resolution_too_low');
  });
  test('403 forbidden は rejected にして、後ろの項目を塞がない', async () => {
    const s = await storeWith(item('1'), item('2'));
    const { send } = sender([{ status: 403, body: { reason: 'forbidden' } }, 201]);
    const r = await flush(s, send);
    assert.equal(r.rejected, 1);
    assert.equal(r.retryLater, 0);
    assert.equal(s.items.size, 1);
    assert.equal(s.items.get('1')!.state, 'rejected');
    assert.equal(s.items.get('1')!.lastError, 'forbidden');
  });
  test('reason の無い応答は http_<status>', async () => {
    const s = await storeWith(item('1'));
    await flush(s, async () => ({ status: 413, body: null }));
    assert.equal(s.items.get('1')!.lastError, 'http_413');
  });
  test('draft と rejected は送らない', async () => {
    const s = await storeWith(item('1', { state: 'draft', fields: { ...FIELDS, kind: null } }), item('2', { state: 'rejected' }));
    const { send, sent } = sender([]);
    const r = await flush(s, send);
    assert.deepEqual(sent, []);
    assert.equal(s.items.size, 2);
    assert.deepEqual(r, { sent: [], rejected: 0, retryLater: 0 });
  });
});

describe('markPending', () => {
  test('入力が揃えば pending に戻し、エラーを消す', () => {
    const it = item('1', { state: 'rejected', lastError: 'resolution_too_low' });
    const next = markPending(it, { ...FIELDS, force: true }, '2026-10-16');
    assert.equal(next!.state, 'pending');
    assert.equal(next!.lastError, null);
    assert.equal(next!.fields.force, true);
  });
  test('種類が未選択なら null', () => {
    assert.equal(markPending(item('1', { state: 'draft' }), { ...FIELDS, kind: null }, '2026-10-16'), null);
  });
});

describe('createFlusher', () => {
  test('重なった呼び出しは 1 回にまとめる', async () => {
    const s = await storeWith(item('1'));
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = createFlusher(s, async () => {
      calls++;
      await gate;
      return { status: 201, body: {} };
    });
    const a = f();
    const b = f();
    release();
    assert.equal(await a, await b);
    assert.equal(calls, 1);
    await f();
    assert.equal(calls, 1); // もう空
  });
});
