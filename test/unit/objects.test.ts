// 原本ストア（docs/mvp-plan-v0.1.md T1-5）。一時ディレクトリだけを使う。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as objects from '../../src/storage/objects.ts';
import { hasObject, objectKey, putObject, readObject, verifyObject } from '../../src/storage/objects.ts';

let root: string;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-objects-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(path.join(e.parentPath, e.name));
  return out;
}

test('内容アドレスで保存し、2 回目は duplicate でファイルは 1 つ', async () => {
  const bytes = Buffer.from('receipt-bytes-\u0000ÿ');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const a = await putObject(root, bytes);
  assert.deepEqual(a, { sha256: sha, key: `sha256/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`, status: 'stored' });
  const b = await putObject(root, bytes);
  assert.equal(b.status, 'duplicate');
  assert.deepEqual(await files(root), [path.join(root, a.key)]);

  const st = await stat(path.join(root, a.key));
  assert.equal(st.mode & 0o777, 0o444);
  assert.deepEqual(await readFile(path.join(root, a.key)), bytes);
  assert.equal(createHash('sha256').update(await readObject(root, sha)).digest('hex'), sha);
  assert.equal(await verifyObject(root, sha), true);
  assert.equal(await hasObject(root, sha), true);
});

test('同じ内容を同時に入れても 1 つだけ stored、一時ファイルが残らない', async () => {
  const bytes = Buffer.alloc(1 << 20, 7);
  const rs = await Promise.all([putObject(root, bytes), putObject(root, bytes), putObject(root, bytes)]);
  assert.ok(rs.every((r) => r.sha256 === rs[0].sha256));
  assert.equal(rs.filter((r) => r.status === 'stored').length, 1);
  assert.ok((await files(root)).every((f) => !path.basename(f).startsWith('.tmp-')));
  assert.equal(await verifyObject(root, rs[0].sha256), true);
});

test('削除・上書きの関数をエクスポートしない', () => {
  const names = Object.keys(objects).sort();
  assert.deepEqual(names, ['hasObject', 'objectKey', 'objectPath', 'putObject', 'readObject', 'sha256Hex', 'verifyObject']);
  for (const n of names) assert.doesNotMatch(n, /delete|remove|unlink|rm|overwrite|replace|write/i);
});

test('不正な sha256 は拒否（パスの外に出ない）', () => {
  assert.throws(() => objectKey('../../etc/passwd'), /64 桁/);
  assert.throws(() => objectKey('A'.repeat(64)), /64 桁/);
});
