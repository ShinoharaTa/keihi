// 原本ストア（docs/mvp-plan-v0.1.md T1-5、architecture.md §3.4、R4・R14）。
// 内容アドレス: <root>/sha256/ab/cd/<sha256>。受け取ったバイト列をそのまま保存する（加工しない）。
// 一時ファイルに書いて fsync → 0444 → 本来の名前へ link（rename の代わり。既存があれば EEXIST で失敗し、絶対に上書きしない）
// → 一時ファイルを消す → ディレクトリを fsync。同じ内容が既にあれば何もしない（duplicate）。
// 削除・上書きの関数は作らない（このモジュールのエクスポートにも置かない。テストで確認）。
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;

export type PutResult = { sha256: string; key: string; status: 'stored' | 'duplicate' };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// DB の documents.storage_key に入れる相対パス。
export function objectKey(sha256: string): string {
  if (!HEX64.test(sha256)) throw new Error('sha256 は 64 桁の小文字 16 進');
  return path.posix.join('sha256', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function objectPath(root: string, sha256: string): string {
  return path.join(root, objectKey(sha256));
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function putObject(root: string, bytes: Uint8Array): Promise<PutResult> {
  const sha256 = sha256Hex(bytes);
  const key = objectKey(sha256);
  const final = path.join(root, key);
  if (await exists(final)) return { sha256, key, status: 'duplicate' };
  const dir = path.dirname(final);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.tmp-${sha256}-${randomBytes(6).toString('hex')}`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  let status: PutResult['status'] = 'stored';
  try {
    await chmod(tmp, 0o444);
    await link(tmp, final);
  } catch (e) {
    // 同時に同じ内容を書いた別の呼び出しが先に置いた。既存は触らない。
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') status = 'duplicate';
    else {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  await rm(tmp, { force: true });
  await fsyncDir(dir);
  return { sha256, key, status };
}

export async function hasObject(root: string, sha256: string): Promise<boolean> {
  return exists(objectPath(root, sha256));
}

export async function readObject(root: string, sha256: string): Promise<Buffer> {
  return readFile(objectPath(root, sha256));
}

// 保存済みのファイルを読み直し、sha256 が名前と一致するか（月 1 回の照合などで使う）。
export async function verifyObject(root: string, sha256: string): Promise<boolean> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(objectPath(root, sha256))) h.update(chunk as Buffer);
  return h.digest('hex') === sha256;
}
