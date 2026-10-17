// 証憑の照合（docs/mvp-plan.md T5-6）。fake の Provider を予算（用途 sync）で包んで使う。DB とストアは一時ディレクトリ。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import { verifyRemoteReceipts, type RemoteVerifyDeps } from '../../src/backup/verifyRemote.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake/index.ts';
import { createBudget, DEFAULT_LIMITS, DEFAULT_PURPOSES, withBudget, type BudgetLimits } from '../../src/providers/freee/budget.ts';
import { objectPath, putObject } from '../../src/storage/objects.ts';

const T0 = new Date('2026-11-01T01:00:00.000Z');

let root: string;
let n = 0;
let db: Db;
let objectsDir: string;
let fake: FakeProvider;
let clock: number;
let sleeps: number[];

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-verify-remote-'));
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
  clock = T0.getTime();
  sleeps = [];
});

// 原本を置き、fake に上げ（remoteBytes を指定すると freee 側だけ別の中身にする）、uploaded の行を作る。
async function addUploaded(i: number, opts: { remoteBytes?: Buffer; uploadedAt?: string } = {}): Promise<{ id: string; sha256: string; remoteId: number }> {
  const bytes = Buffer.from(`receipt-${i}`);
  const s = await putObject(objectsDir, bytes);
  const id = `doc-${String(i).padStart(4, '0')}`;
  const at = opts.uploadedAt ?? new Date(T0.getTime() - (1000 - i) * 60_000).toISOString();
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, status, created_at)
     VALUES (?, ?, ?, 'image/jpeg', 'pwa', 'scan', ?, '2026-10-17', 'server', '2026-10-27', 'early', ?, 'uploaded', ?)`,
  ).run(id, s.sha256, bytes.length, at, s.key, at);
  const r = await fake.uploadReceipt({ bytes: opts.remoteBytes ?? bytes, fileName: `${id}.jpg`, mime: 'image/jpeg', key: `kh-${id}` });
  fake.calls.length = 0;
  db.prepare(`INSERT INTO provider_uploads (id, document_id, provider, state, remote_receipt_id, uploaded_at, created_at) VALUES (?, ?, 'freee', 'uploaded', ?, ?, ?)`).run(
    `pu-${i}`,
    id,
    String(r.id),
    at,
    at,
  );
  return { id, sha256: s.sha256, remoteId: r.id };
}

function deps(over: Partial<RemoteVerifyDeps> & { limits?: BudgetLimits } = {}): RemoteVerifyDeps {
  const budget = createBudget({ db, now: () => new Date(clock), limits: over.limits });
  const provider = withBudget(fake, budget, { ...DEFAULT_PURPOSES, downloadReceipt: 'sync' });
  return {
    db,
    provider,
    objectsDir,
    mode: 'sha256',
    now: () => new Date(clock),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...over,
  };
}

const status = (id: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status;
const audits = (action: string) =>
  (db.prepare('SELECT entity_id, payload_json FROM audit_log WHERE action = ? ORDER BY seq').all(action) as { entity_id: string; payload_json: string }[]).map((r) => ({ id: r.entity_id, ...JSON.parse(r.payload_json) }));

describe('verifyRemoteReceipts', () => {
  test('sha256: 一致は ok、freee 側が違えば needs_attention（remote_sha256_mismatch）。audit に 1 件ずつと要約', async () => {
    const a = await addUploaded(1);
    const b = await addUploaded(2, { remoteBytes: Buffer.from('recompressed') });
    const r = await verifyRemoteReceipts(deps());
    assert.equal(r.checked, 2);
    assert.equal(r.ok, 1);
    assert.equal(r.attention, 1);
    assert.equal(r.stopped, null);
    assert.deepEqual(r.items.map((x) => [x.documentId, x.result]), [[a.id, 'match'], [b.id, 'mismatch']]);
    assert.equal(status(a.id), 'uploaded');
    assert.equal(status(b.id), 'needs_attention');
    const na = audits('document.needs_attention');
    assert.deepEqual(na.map((x) => [x.id, x.reason]), [[b.id, 'remote_sha256_mismatch']]);
    assert.equal(audits('receipt.remote_verified').length, 2);
    const [sum] = audits('backup.remote_verify');
    assert.deepEqual({ mode: sum.mode, checked: sum.checked, ok: sum.ok, attention: sum.attention, stopped: sum.stopped }, { mode: 'sha256', checked: 2, ok: 1, attention: 1, stopped: null });
    assert.equal(verifyAudit(db).ok, true);
    // 予算は sync で数える
    const rows = db.prepare('SELECT purpose, endpoint FROM freee_calls').all() as { purpose: string; endpoint: string }[];
    assert.deepEqual(rows.map((x) => `${x.purpose}:${x.endpoint}`), ['sync:downloadReceipt', 'sync:downloadReceipt']);
  });

  test('download_only（既定）: 中身が違っても needs_attention にせず、一致したかは audit に残す', async () => {
    const b = await addUploaded(1, { remoteBytes: Buffer.from('recompressed') });
    const r = await verifyRemoteReceipts(deps({ mode: 'download_only' }));
    assert.equal(r.ok, 1);
    assert.equal(r.attention, 0);
    assert.equal(r.items[0].result, 'downloaded');
    assert.equal(status(b.id), 'uploaded');
    const [v] = audits('receipt.remote_verified');
    assert.equal(v.sha256_match, false);
    assert.equal(v.mode, 'download_only');
  });

  test('sha256: 手元の原本が壊れていれば local_object_corrupt', async () => {
    const a = await addUploaded(1);
    const p = objectPath(objectsDir, a.sha256);
    await chmod(p, 0o644);
    await writeFile(p, 'broken');
    const r = await verifyRemoteReceipts(deps());
    assert.equal(r.items[0].result, 'local_corrupt');
    assert.equal(audits('document.needs_attention')[0].reason, 'local_object_corrupt');
  });

  test('1 秒 3 回以内（呼び出しの開始を 334ms 以上あける）、1 回 200 件まで、照合の古い順', async () => {
    for (let i = 0; i < 205; i++) await addUploaded(i);
    const starts: number[] = [];
    const d = deps({ mode: 'download_only' });
    const inner = d.provider.downloadReceipt.bind(d.provider);
    d.provider = {
      downloadReceipt: (id: number) => {
        starts.push(clock);
        return inner(id);
      },
    };
    const r = await verifyRemoteReceipts(d);
    assert.equal(r.checked, 200);
    for (let i = 3; i < starts.length; i++) assert.ok(starts[i] - starts[i - 3] >= 1000, `${i}`);
    assert.ok(sleeps.every((ms) => ms > 0 && ms <= 334));
    // 次の回は未照合の 5 件から
    const r2 = await verifyRemoteReceipts({ ...deps({ mode: 'download_only' }), limit: 7 });
    assert.deepEqual(r2.items.slice(0, 5).map((x) => x.documentId), ['doc-0200', 'doc-0201', 'doc-0202', 'doc-0203', 'doc-0204']);
    assert.deepEqual(r2.items.slice(5).map((x) => x.documentId), ['doc-0000', 'doc-0001']);
    await assert.rejects(verifyRemoteReceipts({ ...deps(), limit: 201 }), /limit/);
  });

  test('予算（sync 枠）が尽きたらそこで止める', async () => {
    for (let i = 0; i < 4; i++) await addUploaded(i);
    const limits: BudgetLimits = { ...DEFAULT_LIMITS, perPurpose: { ...DEFAULT_LIMITS.perPurpose, sync: 2 } };
    const r = await verifyRemoteReceipts(deps({ limits }));
    assert.equal(r.checked, 2);
    assert.equal(r.stopped, 'budget');
    assert.equal(audits('backup.remote_verify')[0].stopped, 'budget');
  });

  test('4xx（消された等）は needs_attention（remote_download_failed）で続ける。429・再認可はそこで止める', async () => {
    const a = await addUploaded(1);
    await addUploaded(2);
    fake.failNext('client');
    const r = await verifyRemoteReceipts(deps());
    assert.deepEqual(r.items.map((x) => x.result), ['failed', 'match']);
    assert.equal(status(a.id), 'needs_attention');
    assert.equal(audits('document.needs_attention')[0].reason, 'remote_download_failed');
    assert.equal(audits('receipt.remote_verify_failed').length, 1);

    fake.failNext('rate_limited');
    const r2 = await verifyRemoteReceipts(deps());
    assert.equal(r2.stopped, 'rate_limited');
    assert.equal(r2.checked, 0);
    fake.failNext('auth_invalid_grant');
    const r3 = await verifyRemoteReceipts(deps());
    assert.equal(r3.stopped, 'freee_reauth_required');
  });

  test('uploaded 以外・remote_receipt_id の無いものは対象外', async () => {
    const a = await addUploaded(1);
    db.prepare(`UPDATE provider_uploads SET state = 'queued' WHERE document_id = ?`).run(a.id);
    const r = await verifyRemoteReceipts(deps());
    assert.equal(r.checked, 0);
  });
});
