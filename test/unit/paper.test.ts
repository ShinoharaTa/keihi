// 紙原本のステータス（docs/mvp-plan.md T4-6、legal.md R8・R9）。
// 3 条件（期限内の保存完了・期限内の同等確認・期限内か）の 8 通りの表と、force 受理・解像度不足・税理士 #1 の回答待ち。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import type { Db } from '../../src/db/index.ts';
import { computePaperStatus, markPaperDiscarded, paperStatusOf, refreshPaperStatuses, type PaperInput } from '../../src/deals/paper.ts';
import { addDocument, markUploaded, openTestDb, T0 } from './deals-helpers.ts';

const DEADLINE = '2026-10-27';
const base = (o: Partial<PaperInput> = {}): PaperInput => ({
  kind: 'scan',
  deadlineOn: DEADLINE,
  uploadedOn: null,
  integrityCheckedOn: null,
  paperRequired: false,
  resolutionOk: true,
  discardedAt: null,
  today: '2026-10-20',
  discardAllowed: true,
  ...o,
});

describe('computePaperStatus', () => {
  // [保存完了, 同等確認, 期限を過ぎたか] → 期待
  const table: [boolean, boolean, boolean, string][] = [
    [true, true, false, 'discard_ok'],
    [true, false, false, 'unknown'],
    [false, true, false, 'unknown'],
    [false, false, false, 'unknown'],
    [true, true, true, 'discard_ok'], // 両方とも期限内に済んでいれば、期限の後も廃棄可
    [true, false, true, 'keep_required'],
    [false, true, true, 'keep_required'],
    [false, false, true, 'keep_required'],
  ];
  for (const [uploaded, checked, overdue, want] of table) {
    test(`保存=${uploaded} 確認=${checked} 期限超過=${overdue} → ${want}`, () => {
      const r = computePaperStatus(
        base({ uploadedOn: uploaded ? '2026-10-16' : null, integrityCheckedOn: checked ? '2026-10-17' : null, today: overdue ? '2026-10-28' : '2026-10-27' }),
      );
      assert.equal(r.status, want);
    });
  }

  test('期限の後に済ませても keep_required のまま（以後 discard_ok にならない）', () => {
    const r = computePaperStatus(base({ uploadedOn: '2026-10-28', integrityCheckedOn: '2026-10-16', today: '2026-11-30' }));
    assert.deepEqual(r, { status: 'keep_required', reasons: ['upload_after_deadline'] });
    assert.equal(computePaperStatus(base({ uploadedOn: '2026-10-16', integrityCheckedOn: '2026-10-29', today: '2026-10-29' })).status, 'keep_required');
  });

  test('force 受理・解像度不足は keep_required', () => {
    const ok = { uploadedOn: '2026-10-16', integrityCheckedOn: '2026-10-16' };
    assert.deepEqual(computePaperStatus(base({ ...ok, paperRequired: true })), { status: 'keep_required', reasons: ['accepted_with_force'] });
    assert.deepEqual(computePaperStatus(base({ ...ok, resolutionOk: false })), { status: 'keep_required', reasons: ['resolution_insufficient'] });
  });

  test('税理士 #1 の回答前（discardAllowed=false）は discard_ok を出さない', () => {
    assert.deepEqual(computePaperStatus(base({ uploadedOn: '2026-10-16', integrityCheckedOn: '2026-10-16', discardAllowed: false })), {
      status: 'keep_required',
      reasons: ['tax_advisor_pending'],
    });
  });

  test('廃棄済・電子取引', () => {
    assert.equal(computePaperStatus(base({ discardedAt: '2026-10-20T00:00:00.000Z', paperRequired: true })).status, 'discarded');
    assert.equal(computePaperStatus(base({ kind: 'e_transaction', today: '2026-12-01' })).status, 'unknown');
  });
});

describe('DB', () => {
  let root: string;
  let n = 0;
  let db: Db;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'keihi-paper-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    db = openTestDb(path.join(root, `${n++}.db`));
  });
  const allowDiscard = () =>
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('paper_discard_allowed', 'true', ?)`).run(T0.toISOString());
  const stored = (id: string) => (db.prepare('SELECT paper_status FROM documents WHERE id = ?').get(id) as { paper_status: string }).paper_status;

  test('既定（settings なし）は全件保管: discard_ok にならず、廃棄済にもできない', () => {
    const id = addDocument(db, { integrityCheckedAt: T0.toISOString() });
    markUploaded(db, id, 1);
    assert.equal(paperStatusOf(db, id, T0)!.status, 'keep_required');
    assert.equal(markPaperDiscarded(db, id, { actor: 'user' }, T0).ok, false);
  });

  test('refreshPaperStatuses は変わったものだけ保存して監査ログに残す', () => {
    allowDiscard();
    const a = addDocument(db, { integrityCheckedAt: T0.toISOString() });
    markUploaded(db, a, 1);
    const b = addDocument(db, { deadlineOn: '2026-10-15' }); // 期限切れ・未アップロード
    const c = addDocument(db); // まだ決まらない
    assert.equal(refreshPaperStatuses(db, T0), 2);
    assert.equal(stored(a), 'discard_ok');
    assert.equal(stored(b), 'keep_required');
    assert.equal(stored(c), 'unknown');
    assert.equal(refreshPaperStatuses(db, T0), 0);
    assert.equal(verifyAudit(db).ok, true);
  });

  test('廃棄済: discard_ok のときだけ。2 回目は already。時刻は変えられない', () => {
    allowDiscard();
    const id = addDocument(db, { integrityCheckedAt: T0.toISOString() });
    assert.deepEqual(markPaperDiscarded(db, id, { actor: 'user' }, T0), { ok: false, status: 'unknown', reasons: [] });
    markUploaded(db, id, 1);
    assert.deepEqual(markPaperDiscarded(db, id, { actor: 'user', user: 'a@example.com' }, T0), { ok: true, status: 'discarded', already: false });
    assert.deepEqual(markPaperDiscarded(db, id, { actor: 'user' }, T0), { ok: true, status: 'discarded', already: true });
    assert.equal(paperStatusOf(db, id, T0)!.status, 'discarded');
    assert.throws(() => db.prepare('UPDATE documents SET paper_discarded_at = NULL WHERE id = ?').run(id), /変えられない/);
    const audit = db.prepare(`SELECT actor, payload_json FROM audit_log WHERE action = 'document.paper_discarded'`).all() as { actor: string; payload_json: string }[];
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0].payload_json).user, 'a@example.com');
    assert.deepEqual(markPaperDiscarded(db, 'nope', { actor: 'user' }, T0), { ok: false, status: null, reasons: ['not_found'] });
  });
});
