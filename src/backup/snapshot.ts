// DB のスナップショット（docs/mvp-plan-v0.1.md T5-1、architecture.md §3.4）。
// - `VACUUM INTO` で <data_dir>/snapshots/keihi-<ts>.db に一貫したコピーを取る（WAL なので worker の書き込み中でも取れる。
//   コミット前の書き込みは入らない）。一時名に書いて fsync → 0600 → 本来の名前へ rename。
// - 同じ名前の manifest（keihi-<ts>.manifest.json）を置く: documents の件数と sha256 一覧のハッシュ、audit の最終 seq と hash、
//   スナップショット自体の sha256。リストア訓練（drill.ts）で照合する。値はスナップショットの DB から数える（本体ではない）。
// - スナップショットは原本ではないので、直近 N 個より古いものは消してよい（pruneSnapshots）。restic 側は消さない。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db/index.ts';

export const SNAPSHOT_RE = /^keihi-(\d{8}T\d{6}Z)\.db$/;
export const MANIFEST_VERSION = 1;

export type Manifest = {
  version: number;
  created_at: string;
  db_file: string;
  db_sha256: string;
  documents: { count: number; sha256_list_hash: string };
  audit: { last_seq: number; last_hash: string | null };
};

export type Snapshot = { dbPath: string; manifestPath: string; manifest: Manifest };

export function snapshotStamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function snapshotName(now: Date): string {
  return `keihi-${snapshotStamp(now)}.db`;
}

export function manifestPathFor(dbPath: string): string {
  return dbPath.replace(/\.db$/, '.manifest.json');
}

export async function fileSha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

// documents.sha256 を昇順に並べ、改行で繋いだものの sha256。
export function sha256ListHash(list: string[]): string {
  return createHash('sha256').update([...list].sort().join('\n')).digest('hex');
}

// 開いた DB（スナップショットや復元したもの）から manifest の中身を数える。
export function describeDb(db: DatabaseSync): Pick<Manifest, 'documents' | 'audit'> {
  const shas = (db.prepare('SELECT sha256 FROM documents').all() as { sha256: string }[]).map((r) => r.sha256);
  const last = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
  return {
    documents: { count: shas.length, sha256_list_hash: sha256ListHash(shas) },
    audit: { last_seq: last?.seq ?? 0, last_hash: last?.hash ?? null },
  };
}

async function fsyncPath(p: string): Promise<void> {
  const fh = await open(p, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// スナップショットを 1 つ取る。dir（<data_dir>/snapshots）が無ければ 0700 で作る。
export async function takeSnapshot(db: Db, dir: string, now: Date = new Date()): Promise<Snapshot> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = snapshotName(now);
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.tmp-${name}`);
  const manifestPath = manifestPathFor(final);
  await rm(tmp, { force: true });
  let placed = false;
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    await chmod(tmp, 0o600);
    await fsyncPath(tmp);
    const snap = new DatabaseSync(tmp, { readOnly: true });
    let desc;
    try {
      desc = describeDb(snap);
    } finally {
      snap.close();
    }
    const manifest: Manifest = { version: MANIFEST_VERSION, created_at: now.toISOString(), db_file: name, db_sha256: await fileSha256(tmp), ...desc };
    // 同じ秒に 2 回取ったら、既存を上書きしない。
    try {
      await open(final, 'wx').then((fh) => fh.close());
      placed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${final} が既にある（同じ秒に 2 回取った）`);
      throw e;
    }
    await rename(tmp, final);
    placed = false;
    const mtmp = `${manifestPath}.tmp`;
    await writeFile(mtmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fsyncPath(mtmp);
    await rename(mtmp, manifestPath);
    await fsyncPath(dir);
    return { dbPath: final, manifestPath, manifest };
  } catch (e) {
    await rm(tmp, { force: true });
    if (placed) await rm(final, { force: true });
    throw e;
  }
}

// dir の中のスナップショット（新しい順）。
export async function listSnapshots(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return names.filter((n) => SNAPSHOT_RE.test(n)).sort().reverse().map((n) => path.join(dir, n));
}

// 直近 keep 個より古いスナップショット（と manifest）を消し、消したパスを返す。
export async function pruneSnapshots(dir: string, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep は 1 以上の整数');
  const old = (await listSnapshots(dir)).slice(keep);
  for (const p of old) {
    await rm(p, { force: true });
    await rm(manifestPathFor(p), { force: true });
  }
  return old;
}
