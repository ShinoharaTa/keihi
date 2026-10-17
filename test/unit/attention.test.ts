// needs_attention と settings の共通ヘルパ（src/attention.ts）。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearNeedsAttention, describeError, getSetting, lastAttentionReason, markNeedsAttention, setSetting } from '../../src/attention.ts';
import { verifyAudit } from '../../src/audit.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { BudgetExceededError } from '../../src/providers/freee/budget.ts';
import { ProviderError } from '../../src/providers/types.ts';

const T0 = new Date('2026-10-16T03:00:00.000Z');

let root: string;
let n = 0;
let db: Db;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-attention-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
});

function addDocument(id: string, status = 'received'): void {
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, orig_name, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, status, created_at)
     VALUES (?, ?, 1, 'image/jpeg', 'a.jpg', 'pwa', 'e_transaction', ?, '2026-10-16', 'server', '2026-10-26', 'early', 'k', ?, ?)`,
  ).run(id, id.padEnd(64, '0'), T0.toISOString(), status, T0.toISOString());
}

const status = (id: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status;

describe('attention', () => {
  test('markNeedsAttention は最初の理由だけ残し、clearNeedsAttention は needs_attention のときだけ戻す', () => {
    addDocument('d1');
    assert.equal(markNeedsAttention(db, 'd1', 'upload_rejected', { error: 'x' }, { now: T0 }), true);
    assert.equal(markNeedsAttention(db, 'd1', 'other', {}, { now: T0 }), false);
    assert.equal(status('d1'), 'needs_attention');
    assert.equal(lastAttentionReason(db, 'd1'), 'upload_rejected');
    assert.equal(clearNeedsAttention(db, 'd1', 'received', { now: T0 }), true);
    assert.equal(status('d1'), 'received');
    assert.equal(clearNeedsAttention(db, 'd1', 'needs_review', { now: T0 }), false);
    assert.equal(status('d1'), 'received');
    const a = db.prepare(`SELECT actor, payload_json FROM audit_log WHERE action = 'document.needs_attention_cleared'`).get() as { actor: string; payload_json: string };
    assert.equal(a.actor, 'worker');
    assert.deepEqual(JSON.parse(a.payload_json), { reason: 'upload_rejected', to: 'received' });
    assert.equal(verifyAudit(db).ok, true);
  });

  test('actor を指定できる', () => {
    addDocument('d2');
    markNeedsAttention(db, 'd2', 'remote_download_failed', {}, { now: T0, actor: 'backup' });
    assert.equal((db.prepare(`SELECT actor FROM audit_log WHERE action = 'document.needs_attention'`).get() as { actor: string }).actor, 'backup');
  });

  test('getSetting は JSON として読めない値を undefined にする', () => {
    setSetting(db, 'k', { a: 1 }, T0);
    assert.deepEqual(getSetting(db, 'k'), { a: 1 });
    assert.equal(getSetting(db, 'none'), undefined);
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('bad', '{', ?)`).run(T0.toISOString());
    assert.equal(getSetting(db, 'bad'), undefined);
  });

  test('describeError', () => {
    assert.equal(describeError(new ProviderError('client', 'too big')), 'client: too big');
    assert.equal(describeError(new BudgetExceededError('upload', 'day' as never, T0)).startsWith('budget: '), true);
    assert.equal(describeError('s'), 's');
  });
});
