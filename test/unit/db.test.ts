// DB とマイグレーション（docs/mvp-plan.md T1-3）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { integrityCheck, openDb, type Db } from '../../src/db/index.ts';
import { listMigrations, migrate } from '../../src/db/migrate.ts';

let root: string;
let db: Db;
const now = '2026-10-17T00:00:00.000Z';

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-db-'));
  db = openDb(path.join(root, 'keihi.db'));
});
after(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

function insertDocument(id: string) {
  db.prepare(`INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source,
    deadline_on, deadline_mode, storage_key, created_at) VALUES (?, ?, 1, 'image/jpeg', 'pwa', 'scan', ?, '2026-10-17', 'server',
    '2026-10-28', 'early', 'x', ?)`).run(id, id.padEnd(64, '0'), now, now);
}

describe('migrate', () => {
  test('空 DB に全マイグレーションを適用し integrity_check が ok', () => {
    assert.deepEqual(migrate(db), listMigrations().map((m) => m.name));
    assert.deepEqual(integrityCheck(db), []);
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  });
  test('2 回目は何もしない', () => {
    assert.deepEqual(migrate(db), []);
  });
  test('適用済みのファイルが変わっていたら止める', () => {
    const ms = listMigrations().map((m) => ({ ...m, sha256: 'x' }));
    assert.throws(() => migrate(db, ms), /書き換えられている/);
  });
});

describe('追記専用の表', () => {
  const appendOnly: [string, string][] = [
    ['audit_log', `INSERT INTO audit_log (ts, actor, action, entity, payload_json, prev_hash, hash) VALUES ('${now}', 'user', 'a', 'e', '{}', 'p', 'h1')`],
    ['extractions', `INSERT INTO extractions (id, document_id, engine, raw_json, created_at) VALUES ('ex1', 'D1', 'gemini', '{}', '${now}')`],
    ['classifications', `INSERT INTO classifications (id, extraction_id, source, candidates_json, created_at) VALUES ('c1', 'ex1', 'rule', '[]', '${now}')`],
    ['reviews', `INSERT INTO reviews (id, document_id, version, decision, decided_at) VALUES ('r1', 'D1', 1, 'approve', '${now}')`],
    ['ai_turns', `INSERT INTO ai_turns (id, document_id, seq, role, created_at) VALUES ('t1', 'D1', 1, 'ai', '${now}')`],
    ['answers', `INSERT INTO answers (id, card_id, answered_at) VALUES ('an1', 'card1', '${now}')`],
  ];
  before(() => {
    insertDocument('D1');
    db.exec(`INSERT INTO ui_cards (id, document_id, kind, card_json) VALUES ('card1', 'D1', 'confirm', '{}')`);
  });
  for (const [table, ins] of appendOnly) {
    test(`${table} は UPDATE / DELETE を拒否`, () => {
      db.exec(ins);
      const pk = table === 'audit_log' ? 'seq' : 'id';
      assert.throws(() => db.exec(`UPDATE ${table} SET ${pk} = ${pk}`), /追記専用/);
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /追記専用/);
      assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 1);
    });
  }

  test('documents は削除できず、不変の列は更新できない。状態の列は更新できる', () => {
    insertDocument('D2');
    assert.throws(() => db.exec(`DELETE FROM documents WHERE id = 'D2'`), /削除できない/);
    for (const set of [`sha256 = 'x'`, `kind = 'e_transaction'`, `received_on = '2026-10-18'`, `deadline_on = '2027-01-01'`, `storage_key = 'y'`, `resolution_ok = 1`]) {
      assert.throws(() => db.exec(`UPDATE documents SET ${set} WHERE id = 'D2'`), /不変の列/, set);
    }
    db.exec(`UPDATE documents SET status = 'uploaded', paper_status = 'keep_required', integrity_checked_at = '${now}', paper_required = 1 WHERE id = 'D2'`);
    assert.throws(() => db.exec(`UPDATE documents SET paper_required = 0 WHERE id = 'D2'`), /不変の列/);
  });

  test('provider_uploads は削除できず、外部 ID は一度入れたら変えられない', () => {
    db.exec(`INSERT INTO provider_uploads (id, document_id, provider, created_at) VALUES ('u1', 'D2', 'freee', '${now}')`);
    db.exec(`UPDATE provider_uploads SET state = 'uploaded', remote_receipt_id = '42', uploaded_at = '${now}', attempts = 1 WHERE id = 'u1'`);
    assert.throws(() => db.exec(`UPDATE provider_uploads SET remote_receipt_id = '43' WHERE id = 'u1'`), /不変の列/);
    assert.throws(() => db.exec(`UPDATE provider_uploads SET uploaded_at = NULL WHERE id = 'u1'`), /不変の列/);
    assert.throws(() => db.exec(`UPDATE provider_uploads SET document_id = 'D1' WHERE id = 'u1'`), /不変の列/);
    assert.throws(() => db.exec(`DELETE FROM provider_uploads`), /削除できない/);
    db.exec(`UPDATE provider_uploads SET meta_state = 'sent' WHERE id = 'u1'`);
  });

  test('外部キーが効く', () => {
    assert.throws(() => db.exec(`INSERT INTO extractions (id, document_id, engine, raw_json, created_at) VALUES ('ex9', 'NOPE', 'g', '{}', '${now}')`), /FOREIGN KEY/);
  });
});
