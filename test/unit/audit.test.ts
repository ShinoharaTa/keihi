// 監査ログのハッシュチェーン（docs/mvp-plan-v0.1.md T1-4）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { appendAudit, canonicalJson, verifyAudit } from '../../src/audit.ts';

const AUDIT_TS = fileURLToPath(new URL('../../src/audit.ts', import.meta.url));
const DB_TS = fileURLToPath(new URL('../../src/db/index.ts', import.meta.url));
let root: string;
let n = 0;
const fresh = (): { db: Db; file: string } => {
  const file = path.join(root, `a${n++}.db`);
  const db = openDb(file);
  migrate(db);
  return { db, file };
};

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-audit-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('canonicalJson はキー順に依存しない', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 'x'], c: null }, u: undefined }), '{"a":{"c":null,"d":[1,"x"]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

describe('verify', () => {
  test('空のログは ok', () => {
    const { db } = fresh();
    assert.deepEqual(verifyAudit(db), { ok: true, count: 0, lastHash: '0'.repeat(64) });
    db.close();
  });

  test('1,000 行追加後に ok。途中 1 行の payload を書き換えるとその seq を報告', async () => {
    const { db, file } = fresh();
    for (let i = 0; i < 1000; i++) appendAudit(db, { actor: 'user', action: 'document.received', entity: 'document', entityId: `D${i}`, payload: { i, sha256: 'ab'.repeat(32) } });
    const r = verifyAudit(db);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.count, 1000);

    // トリガを一時的に外して直接書き換える（改ざんの再現）。
    db.exec('DROP TRIGGER audit_log_no_update');
    db.exec(`UPDATE audit_log SET payload_json = '{"i":999999}' WHERE seq = 500`);
    assert.deepEqual(verifyAudit(db), { ok: false, seq: 500, reason: 'hash が内容と一致しない' });
    db.close();

    const cli = await run(process.execPath, [AUDIT_TS, 'verify', '--db', file]);
    assert.equal(cli.code, 1);
    assert.match(cli.out, /seq 500/);
  });

  test('hash ごと書き換えても次の行で検出する。削除は欠番として検出する', () => {
    const { db } = fresh();
    for (let i = 0; i < 10; i++) appendAudit(db, { actor: 'worker', action: 'x', entity: 'e', payload: { i } });
    db.exec('DROP TRIGGER audit_log_no_update');
    db.exec('DROP TRIGGER audit_log_no_delete');
    db.exec(`UPDATE audit_log SET hash = (CASE WHEN substr(hash, 1, 1) = 'f' THEN 'e' ELSE 'f' END) || substr(hash, 2) WHERE seq = 3`);
    const r = verifyAudit(db);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.seq, 3);
    db.close();

    const b = fresh().db;
    for (let i = 0; i < 5; i++) appendAudit(b, { actor: 'worker', action: 'x', entity: 'e' });
    b.exec('DROP TRIGGER audit_log_no_delete');
    b.exec('DELETE FROM audit_log WHERE seq = 2');
    assert.deepEqual(verifyAudit(b), { ok: false, seq: 2, reason: 'seq 2 が欠けている' });
    b.close();
  });

  test('トリガが有効な間は書き換えられない', () => {
    const { db } = fresh();
    appendAudit(db, { actor: 'user', action: 'a', entity: 'e' });
    assert.throws(() => db.exec(`UPDATE audit_log SET payload_json = '{}'`), /追記専用/);
    db.close();
  });

  test('外側のトランザクションが ROLLBACK すれば監査行も残らない', () => {
    const { db } = fresh();
    db.exec('BEGIN IMMEDIATE');
    appendAudit(db, { actor: 'user', action: 'a', entity: 'e' });
    db.exec('ROLLBACK');
    assert.equal((db.prepare('SELECT count(*) n FROM audit_log').get() as { n: number }).n, 0);
    db.close();
  });
});

test('並行 append（2 プロセス）で seq が欠番・重複しない', async () => {
  const { db, file } = fresh();
  db.close();
  // append の後に 20ms 譲る（#77）。続けざまに BEGIN IMMEDIATE すると、相手は busy_timeout の間
  // ロックを見に来る隙が無く、負荷が高いと 5 秒待って database is locked になる（交互に書かせたいので間を空ける）。
  const script = `
    import { openDb } from ${JSON.stringify(DB_TS)};
    import { appendAudit } from ${JSON.stringify(AUDIT_TS)};
    const db = openDb(process.argv[1]);
    const gap = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 200; i++) {
      appendAudit(db, { actor: process.argv[2], action: 'x', entity: 'e', payload: { i } });
      Atomics.wait(gap, 0, 0, 20);
    }
    db.close();`;
  const rs = await Promise.all(['web', 'worker'].map((who) => run(process.execPath, ['--input-type=module', '-e', script, file, who])));
  for (const r of rs) assert.equal(r.code, 0, r.out);
  const d = openDb(file);
  const v = verifyAudit(d);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.ok && v.count, 400);
  const by = d.prepare('SELECT actor, count(*) n FROM audit_log GROUP BY actor ORDER BY actor').all() as { actor: string; n: number }[];
  assert.deepEqual(by.map((r) => [r.actor, r.n]), [['web', 200], ['worker', 200]]);
  d.close();
});
