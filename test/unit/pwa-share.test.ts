// 共有シート（Android Web Share Target）の SW ハンドラのロジック（docs/mvp-plan-v0.1.md T1-13）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { QueueItem, QueueStore } from '../../pwa/src/queue/queue.ts';
import { acceptShare, SHARE_FILES_FIELD, SHARE_PATH, shareRedirect } from '../../pwa/src/queue/share.ts';

class MemoryStore implements QueueStore {
  items: QueueItem[] = [];
  async list() {
    return this.items;
  }
  async put(item: QueueItem) {
    this.items.push(item);
  }
  async remove(id: string) {
    this.items = this.items.filter((i) => i.id !== id);
  }
}

const NOW = new Date(2026, 9, 16, 12, 0);

describe('acceptShare', () => {
  test('ファイルを draft（種類は未選択、source=share）で積み、HEIC は数えて積まない', async () => {
    const fd = new FormData();
    fd.append('title', 'タイトル');
    fd.append(SHARE_FILES_FIELD, new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'invoice.pdf', { type: 'application/pdf' }));
    fd.append(SHARE_FILES_FIELD, new File([new Uint8Array([1])], 'IMG_1.HEIC', { type: 'image/heic' }));
    fd.append(SHARE_FILES_FIELD, new File([], 'empty.jpg', { type: 'image/jpeg' }));
    fd.append(SHARE_FILES_FIELD, 'not a file');
    fd.append(SHARE_FILES_FIELD, new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', { type: 'image/jpeg' }));
    const s = new MemoryStore();
    let n = 0;
    const r = await acceptShare(fd, s, { now: NOW, newId: () => `id${n++}` });
    assert.deepEqual(r, { queued: 2, unsupported: 1 });
    assert.deepEqual(
      s.items.map((i) => [i.id, i.name, i.state, i.fields.kind, i.fields.source, i.fields.receivedOn]),
      [
        ['id0', 'invoice.pdf', 'draft', null, 'share', '2026-10-16'],
        ['id1', 'photo.jpg', 'draft', null, 'share', '2026-10-16'],
      ],
    );
    assert.ok(s.items[0].createdAt < s.items[1].createdAt);
    assert.equal(s.items[0].blob.size, 5);
  });
  test('ファイルが無ければ何も積まない', async () => {
    const s = new MemoryStore();
    assert.deepEqual(await acceptShare(new FormData(), s, { now: NOW, newId: () => 'x' }), { queued: 0, unsupported: 0 });
    assert.equal(s.items.length, 0);
  });
});

describe('shareRedirect と manifest', () => {
  test('戻り先の URL', () => {
    assert.equal(shareRedirect({ queued: 2, unsupported: 1 }), '/?share=2&unsupported=1');
    assert.equal(shareRedirect(null), '/?share=error');
  });
  test('manifest の share_target が SW の受け口と一致する（POST multipart、files）', async () => {
    const m = JSON.parse(await readFile('pwa/public/manifest.webmanifest', 'utf8'));
    assert.equal(m.share_target.action, SHARE_PATH);
    assert.equal(m.share_target.method, 'POST');
    assert.equal(m.share_target.enctype, 'multipart/form-data');
    assert.equal(m.share_target.params.files[0].name, SHARE_FILES_FIELD);
    assert.equal(m.start_url, '/');
  });
});
