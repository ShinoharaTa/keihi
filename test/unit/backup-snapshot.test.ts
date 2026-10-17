// DB のスナップショット（docs/mvp-plan-v0.1.md T5-1）。一時ディレクトリだけを使う。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appendAudit } from '../../src/audit.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { fileSha256, listSnapshots, pruneSnapshots, sha256ListHash, snapshotName, takeSnapshot, type Manifest } from '../../src/backup/snapshot.ts';

const T0 = new Date('2026-10-17T03:04:05.678Z');

let root: string;
let n = 0;
let dir: string;
let dbFile: string;
let db: Db;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-snap-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  const d = path.join(root, String(n++));
  dir = path.join(d, 'snapshots');
  dbFile = `${d}.db`;
  db = openDb(dbFile);
  migrate(db);
});

function addDoc(sha: string): void {
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, created_at)
     VALUES (?, ?, 1, 'image/jpeg', 'pwa', 'scan', ?, '2026-10-17', 'server', '2026-10-27', 'early', ?, ?)`,
  ).run(`doc-${sha.slice(0, 6)}`, sha, T0.toISOString(), `sha256/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`, T0.toISOString());
}

describe('takeSnapshot', () => {
  test('名前は keihi-<UTC の秒>.db。0600 で、manifest に件数・一覧のハッシュ・audit の最終行・ファイルの sha256', async () => {
    addDoc('b'.repeat(64));
    addDoc('a'.repeat(64));
    const last = appendAudit(db, { actor: 't', action: 'x', entity: 'e' }, T0);
    const s = await takeSnapshot(db, dir, T0);
    assert.equal(path.basename(s.dbPath), 'keihi-20261017T030405Z.db');
    assert.equal(snapshotName(T0), 'keihi-20261017T030405Z.db');
    assert.equal((await stat(s.dbPath)).mode & 0o777, 0o600);
    assert.equal((await stat(s.manifestPath)).mode & 0o777, 0o600);
    const m = JSON.parse(await readFile(s.manifestPath, 'utf8')) as Manifest;
    assert.deepEqual(m, s.manifest);
    assert.equal(m.db_file, 'keihi-20261017T030405Z.db');
    assert.equal(m.db_sha256, await fileSha256(s.dbPath));
    assert.deepEqual(m.documents, { count: 2, sha256_list_hash: sha256ListHash(['a'.repeat(64), 'b'.repeat(64)]) });
    assert.deepEqual(m.audit, { last_seq: last.seq, last_hash: last.hash });
    // 一時ファイルが残らない
    assert.deepEqual((await readdir(dir)).sort(), ['keihi-20261017T030405Z.db', 'keihi-20261017T030405Z.manifest.json']);
    // 開ける
    const c = new DatabaseSync(s.dbPath, { readOnly: true });
    assert.equal((c.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n, 2);
    c.close();
  });

  test('別の接続が書き込み中（未コミット）でも取れ、未コミットの行は入らない', async () => {
    addDoc('c'.repeat(64));
    const writer = openDb(dbFile);
    writer.exec('BEGIN IMMEDIATE');
    writer
      .prepare(
        `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, created_at)
         VALUES ('doc-uncommitted', ?, 1, 'image/jpeg', 'pwa', 'scan', 'x', '2026-10-17', 'server', '2026-10-27', 'early', 'k', 'x')`,
      )
      .run('d'.repeat(64));
    try {
      const s = await takeSnapshot(db, dir, T0);
      assert.equal(s.manifest.documents.count, 1);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  test('同じ秒に 2 回取ると失敗し、既存を上書きしない', async () => {
    const s = await takeSnapshot(db, dir, T0);
    const before = await fileSha256(s.dbPath);
    addDoc('e'.repeat(64));
    await assert.rejects(takeSnapshot(db, dir, T0), /既にある/);
    assert.equal(await fileSha256(s.dbPath), before);
    assert.deepEqual((await readdir(dir)).sort(), ['keihi-20261017T030405Z.db', 'keihi-20261017T030405Z.manifest.json']);
  });
});

describe('pruneSnapshots', () => {
  test('新しい順に keep 個だけ残し、manifest も一緒に消す。関係ないファイルは触らない', async () => {
    for (let i = 0; i < 5; i++) await takeSnapshot(db, dir, new Date(T0.getTime() + i * 86_400_000));
    const all = await listSnapshots(dir);
    assert.equal(all.length, 5);
    assert.equal(path.basename(all[0]), 'keihi-20261021T030405Z.db');
    const removed = await pruneSnapshots(dir, 2);
    assert.deepEqual(removed.map((p) => path.basename(p)), ['keihi-20261019T030405Z.db', 'keihi-20261018T030405Z.db', 'keihi-20261017T030405Z.db']);
    assert.deepEqual((await readdir(dir)).sort(), [
      'keihi-20261020T030405Z.db',
      'keihi-20261020T030405Z.manifest.json',
      'keihi-20261021T030405Z.db',
      'keihi-20261021T030405Z.manifest.json',
    ]);
    await assert.rejects(pruneSnapshots(dir, 0), /keep/);
  });

  test('ディレクトリが無ければ何もしない', async () => {
    assert.deepEqual(await pruneSnapshots(path.join(root, 'none'), 3), []);
  });
});
