// upload_receipt ジョブ（docs/mvp-plan.md T1-11、R7）。fake の Provider を予算（T1-15）で包んで使う。DB とストアは一時ディレクトリ。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ulid } from '../../src/db/ids.ts';
import { migrate } from '../../src/db/migrate.ts';
import { enqueue, getJob } from '../../src/jobs/queue.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake/index.ts';
import { createBudget, withBudget } from '../../src/providers/freee/budget.ts';
import { objectPath, putObject, sha256Hex } from '../../src/storage/objects.ts';
import { setReauthRequired } from '../../src/providers/freee/state.ts';
import { createUploadReceiptHandler, matchKey, REAUTH_PENDING, wakeReauthPending } from '../../src/worker/handlers/uploadReceipt.ts';

const T0 = new Date('2026-10-16T03:00:00.000Z'); // JST 2026-10-16(金) 12:00
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ORIGINAL = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0xff, 0xd9]);

let root: string;
let n = 0;
let db: Db;
let objectsDir: string;
let fake: FakeProvider;
let clock: Date;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-upload-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  const d = path.join(root, String(n++));
  objectsDir = path.join(d, 'objects');
  db = openDb(`${d}.db`);
  migrate(db);
  fake = createFakeProvider();
  clock = T0;
});

async function addDocument(opts: { receivedOn?: string; deadlineOn?: string; bytes?: Buffer } = {}): Promise<string> {
  const bytes = opts.bytes ?? ORIGINAL;
  const stored = await putObject(objectsDir, bytes);
  const id = ulid(T0.getTime());
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, orig_name, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, created_at)
     VALUES (?, ?, ?, 'image/jpeg', 'IMG_0001.jpg', 'pwa', 'e_transaction', ?, ?, 'server', ?, 'early', ?, ?)`,
  ).run(id, stored.sha256, bytes.length, T0.toISOString(), opts.receivedOn ?? '2026-10-16', opts.deadlineOn ?? '2026-10-26', stored.key, T0.toISOString());
  return id;
}

function handlers() {
  const provider = withBudget(fake, createBudget({ db, now: () => clock }));
  return { upload_receipt: createUploadReceiptHandler(() => ({ provider, objectsDir })) };
}

async function runAt(min: number) {
  clock = at(min);
  return runUntilEmpty(db, handlers(), { now: () => clock });
}

const upload = (docId: string) => db.prepare('SELECT * FROM provider_uploads WHERE document_id = ?').get(docId) as Record<string, unknown>;
const status = (docId: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(docId) as { status: string }).status;
const audits = () => (db.prepare('SELECT action, payload_json FROM audit_log ORDER BY seq').all() as { action: string; payload_json: string }[]).map((r) => ({ action: r.action, payload: JSON.parse(r.payload_json) }));
const methods = () => fake.calls.map((c) => `${c.method}:${c.outcome}`);

describe('upload_receipt', () => {
  test('成功: 原本をそのまま 1 回送り、uploaded・remote_receipt_id・監査ログを記録', async () => {
    const id = await addDocument();
    const job = enqueue(db, 'upload_receipt', id, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 1, failed: 0 });
    assert.deepEqual(methods(), ['uploadReceipt:ok']);
    const r = fake.state.receipts.get(1)!;
    assert.equal(r.sha256, sha256Hex(ORIGINAL)); // 加工しない（R4）
    assert.equal(r.key, matchKey(id));
    assert.equal(r.key, `kh-${id}`);
    assert.deepEqual(r.meta, {}); // メタデータは空
    assert.equal(r.fileName, 'IMG_0001.jpg');
    const u = upload(id);
    assert.equal(u.state, 'uploaded');
    assert.equal(u.remote_receipt_id, '1');
    assert.equal(u.uploaded_at, T0.toISOString());
    assert.equal(u.meta_deadline_on, '2026-12-25');
    assert.equal(u.attempts, 1);
    assert.equal(getJob(db, job)!.state, 'done');
    const a = audits().at(-1)!;
    assert.equal(a.action, 'receipt.uploaded');
    assert.equal(a.payload.remote_receipt_id, 1);
    assert.equal(a.payload.sha256, sha256Hex(ORIGINAL));
    assert.ok(verifyAudit(db).ok);
    assert.equal(status(id), 'received');
    // 予算: 用途 upload で記録
    assert.deepEqual((db.prepare('SELECT purpose, endpoint FROM freee_calls').all()).map((x) => ({ ...x })), [{ purpose: 'upload', endpoint: 'uploadReceipt' }]);
  });

  test('済みのものは送り直さない', async () => {
    const id = await addDocument();
    enqueue(db, 'upload_receipt', id, { now: T0 });
    enqueue(db, 'upload_receipt', id, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 2, failed: 0 });
    assert.deepEqual(methods(), ['uploadReceipt:ok']);
  });

  test('タイムアウトの後に実は成功していた: 再送の前に照合キーで見つけて採用し、二重に上げない', async () => {
    const id = await addDocument();
    const job = enqueue(db, 'upload_receipt', id, { now: T0 });
    fake.failNext('timeout', { butSucceed: true });
    assert.deepEqual(await runAt(0), { done: 0, failed: 1 });
    assert.equal(upload(id).state, 'queued');
    assert.match(String(upload(id).last_error), /^timeout/);
    assert.deepEqual(await runAt(1), { done: 1, failed: 0 });
    assert.deepEqual(methods(), ['uploadReceipt:timeout', 'findReceiptsByKey:ok']);
    assert.equal(fake.state.receipts.size, 1);
    assert.equal(upload(id).state, 'uploaded');
    assert.equal(upload(id).remote_receipt_id, '1');
    assert.equal(audits().at(-1)!.action, 'receipt.upload_adopted');
    assert.equal(getJob(db, job)!.state, 'done');
  });

  test('5xx は再試行し、照合で無ければ送り直す', async () => {
    const id = await addDocument();
    fake.failNext('server');
    enqueue(db, 'upload_receipt', id, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 0, failed: 1 });
    assert.deepEqual(await runAt(0.5), { done: 0, failed: 0 }); // バックオフ（1 分）の間は動かない
    assert.deepEqual(await runAt(1), { done: 1, failed: 0 });
    assert.deepEqual(methods(), ['uploadReceipt:server', 'findReceiptsByKey:ok', 'uploadReceipt:ok']);
    assert.equal(fake.state.receipts.size, 1);
    assert.equal(upload(id).attempts, 2);
    assert.equal(status(id), 'received');
  });

  test('403（使用制限）の後 10 分は呼ばない。止まっている間も再試行に回し、明けたら送る', async () => {
    const id = await addDocument();
    fake.failNext('usage_limited');
    enqueue(db, 'upload_receipt', id, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 0, failed: 1 });
    assert.deepEqual(await runAt(1), { done: 0, failed: 1 }); // 停止中（〜T0+10 分）
    assert.deepEqual(await runAt(6), { done: 0, failed: 1 });
    assert.deepEqual(methods(), ['uploadReceipt:usage_limited']);
    assert.match(String(upload(id).last_error), /usage_limited/);
    assert.deepEqual(await runAt(36), { done: 1, failed: 0 });
    assert.deepEqual(methods(), ['uploadReceipt:usage_limited', 'findReceiptsByKey:ok', 'uploadReceipt:ok']);
    assert.equal(status(id), 'received');
  });

  test('401 invalid_grant: 再認可待ち。status を変えず、回数を数えずに 6 時間後へ延期する', async () => {
    const id = await addDocument();
    fake.failNext('auth_invalid_grant');
    const job = enqueue(db, 'upload_receipt', id, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 0, failed: 0 });
    const j = getJob(db, job)!;
    assert.equal(j.state, 'queued');
    assert.equal(j.attempts, 0);
    assert.equal(j.run_after, at(360).toISOString());
    assert.match(j.last_error!, new RegExp(`^${REAUTH_PENDING} since=${T0.toISOString()}: auth_invalid_grant`));
    assert.equal(status(id), 'received');
    assert.equal(audits().filter((x) => x.action === 'document.needs_attention').length, 0);
    assert.deepEqual(await runAt(359), { done: 0, failed: 0 });
    assert.deepEqual(await runAt(360), { done: 1, failed: 0 });
    assert.equal(upload(id).state, 'uploaded');
    assert.ok(verifyAudit(db).ok);
  });

  test('freee_reauth_required 中は呼ばずに延期し、開始時刻を引き継ぐ。再認可後は wakeReauthPending で即時に動く', async () => {
    const id = await addDocument();
    setReauthRequired(db, true, T0);
    const job = enqueue(db, 'upload_receipt', id, { now: T0 });
    await runAt(0);
    await runAt(360);
    assert.deepEqual(methods(), []);
    assert.equal(getJob(db, job)!.attempts, 0);
    assert.match(getJob(db, job)!.last_error!, new RegExp(`since=${T0.toISOString()}:`));
    assert.equal(getJob(db, job)!.run_after, at(720).toISOString());
    assert.equal(wakeReauthPending(db, at(400)), 0); // まだ再認可されていない
    setReauthRequired(db, false, at(400));
    assert.equal(wakeReauthPending(db, at(400)), 1);
    assert.deepEqual(await runAt(400), { done: 1, failed: 0 });
    assert.deepEqual(methods(), ['uploadReceipt:ok']);
    assert.equal(status(id), 'received');
  });

  test('再認可待ちが reauth_wait_days を超えたら needs_attention（upload_reauth_expired）にしてジョブを終える', async () => {
    const id = await addDocument({ deadlineOn: '2026-12-25' });
    setReauthRequired(db, true, T0);
    const job = enqueue(db, 'upload_receipt', id, { now: T0 });
    const h = { upload_receipt: createUploadReceiptHandler(() => ({ provider: fake, objectsDir, reauthWaitDays: 1 })) };
    await runUntilEmpty(db, h, { now: () => T0 });
    clock = at(24 * 60);
    await runUntilEmpty(db, h, { now: () => clock });
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(status(id), 'needs_attention');
    const a = audits().filter((x) => x.action === 'document.needs_attention');
    assert.equal(a.length, 1);
    assert.equal(a[0].payload.reason, 'upload_reauth_expired');
    assert.equal(a[0].payload.reauth_pending_since, T0.toISOString());
  });

  test('4xx は needs_attention（upload_rejected）にして 1 回で終える（再スローしない）', async () => {
    const id = await addDocument();
    fake.failNext('client');
    const job = enqueue(db, 'upload_receipt', id, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 1, failed: 0 });
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(status(id), 'needs_attention');
    assert.equal(audits().at(-1)!.payload.reason, 'upload_rejected');
    assert.match(String(upload(id).last_error), /^client/);
    assert.deepEqual(await runAt(60), { done: 0, failed: 0 });
    assert.deepEqual(methods(), ['uploadReceipt:client']);
  });

  test('サイズ超過は送らずに needs_attention（upload_rejected）で終える', async () => {
    const id = await addDocument();
    const big = { ...fake, capabilities: () => ({ ...fake.capabilities(), maxReceiptBytes: 4 }) };
    const job = enqueue(db, 'upload_receipt', id, { now: T0 });
    const s = await runUntilEmpty(db, { upload_receipt: createUploadReceiptHandler(() => ({ provider: big, objectsDir })) }, { now: () => T0 });
    assert.deepEqual(s, { done: 1, failed: 0 });
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(audits().at(-1)!.payload.reason, 'upload_rejected');
    assert.deepEqual(methods(), []);
  });

  test('期限の 2 営業日前を過ぎて未送信なら needs_attention（その前は付けない）', async () => {
    // 期限 10/22(木) の 2 営業日前 = 10/20(火)。T0 = 10/16(金)。
    const id = await addDocument({ deadlineOn: '2026-10-22' });
    fake.failNext('server', { times: 3 });
    enqueue(db, 'upload_receipt', id, { now: T0 });
    await runAt(0);
    assert.equal(status(id), 'received');
    clock = new Date('2026-10-20T00:00:00Z'); // JST 10/20 09:00
    db.prepare(`UPDATE jobs SET run_after = ?`).run(clock.toISOString());
    await runUntilEmpty(db, handlers(), { now: () => clock });
    assert.equal(status(id), 'needs_attention');
    const a = audits().filter((x) => x.action === 'document.needs_attention');
    assert.equal(a.length, 1);
    assert.equal(a[0].payload.reason, 'upload_deadline_near');
    assert.equal(a[0].payload.warn_on, '2026-10-20');
    // 2 度目の失敗では重ねて記録しない
    db.prepare(`UPDATE jobs SET run_after = ?`).run(clock.toISOString());
    await runUntilEmpty(db, handlers(), { now: () => clock });
    assert.equal(audits().filter((x) => x.action === 'document.needs_attention').length, 1);
  });

  test('最後の試行で失敗したら needs_attention（以降は自動で送らない）', async () => {
    const id = await addDocument();
    fake.failNext('server', { times: 10 });
    const job = enqueue(db, 'upload_receipt', id, { now: T0 });
    for (let i = 0; i < 6; i++) {
      db.prepare(`UPDATE jobs SET run_after = ? WHERE id = ?`).run(T0.toISOString(), job);
      await runAt(0);
      if (i < 5) assert.equal(status(id), 'received', `試行 ${i + 1}`);
    }
    assert.equal(getJob(db, job)!.state, 'failed');
    assert.equal(status(id), 'needs_attention');
    assert.equal(audits().at(-1)!.payload.reason, 'upload_retries_exhausted');
  });

  test('原本が記録の sha256 と違えば送らない', async () => {
    const id = await addDocument();
    const file = objectPath(objectsDir, sha256Hex(ORIGINAL));
    await chmod(file, 0o644);
    await writeFile(file, Buffer.from('tampered'));
    const job = enqueue(db, 'upload_receipt', id, { now: T0 });
    assert.deepEqual(await runAt(0), { done: 0, failed: 1 });
    assert.deepEqual(methods(), []);
    assert.match(getJob(db, job)!.last_error!, /sha256 が記録と一致しない/);
  });
});
