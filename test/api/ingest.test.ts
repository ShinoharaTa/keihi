// 取り込み API（docs/mvp-plan-v0.1.md T1-6、R1〜R5）。app.request() で叩く（ポートを開かない）。DB とストアは一時ディレクトリ。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/web/app.ts';
import type { Hono } from 'hono';

const FX = 'test/fixtures/receipts';
const NOW = new Date('2026-10-16T03:00:00.000Z'); // JST 2026-10-16(金) 12:00
const allow: MiddlewareHandler = async (_c, next) => next();

let root: string;
let n = 0;
let db: Db;
let objectsDir: string;
let app: Hono;
let triggered: number;

function make(opts: { maxBytes?: number; auth?: MiddlewareHandler } = {}) {
  const dir = path.join(root, String(n++));
  objectsDir = path.join(dir, 'objects');
  db = openDb(path.join(root, `${n}.db`));
  migrate(db);
  triggered = 0;
  app = createApp({
    db,
    objectsDir,
    config: {
      ingest: { maxBytes: opts.maxBytes ?? 20 * 1024 * 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
    },
    auth: opts.auth ?? allow,
    triggerWorker: () => triggered++,
    now: () => NOW,
  });
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-ingest-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => make());

async function post(fields: Record<string, string>, file?: { bytes: Uint8Array<ArrayBuffer>; name: string; type?: string }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', new File([file.bytes], file.name, { type: file.type ?? 'application/octet-stream' }));
  const res = await app.request('/api/documents', { method: 'POST', body: fd });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const fx = async (name: string) => ({ bytes: new Uint8Array(await readFile(path.join(FX, name))), name });
const count = (t: string) => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;
async function objectFiles(): Promise<string[]> {
  try {
    return (await readdir(objectsDir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

describe('POST /api/documents', () => {
  test('scan の領収書を受理: 原本・documents・audit・jobs を記録して worker を起動', async () => {
    const f = await fx('r01_receipt58.jpg');
    const r = await post({ kind: 'scan', size_preset: 'receipt58' }, { ...f, type: 'text/plain' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const sha = createHash('sha256').update(f.bytes).digest('hex');
    assert.equal(r.json.sha256, sha);
    assert.equal(r.json.deadline_on, '2026-10-26');
    assert.deepEqual(r.json.warnings, []);

    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(r.json.id) as Record<string, any>;
    assert.equal(d.mime, 'image/jpeg'); // 宣言（text/plain）ではなく中身で判定
    assert.equal(d.kind, 'scan');
    assert.equal(d.received_on, '2026-10-16');
    assert.equal(d.received_on_source, 'server');
    assert.equal(d.resolution_ok, 1);
    assert.equal(d.color_ok, 1);
    assert.equal(d.paper_required, 0);
    assert.equal(d.width_px, 685);
    // R4: 保存したバイト列は送ったものと同一
    const saved = await readFile(path.join(objectsDir, d.storage_key));
    assert.equal(createHash('sha256').update(saved).digest('hex'), sha);

    const audit = db.prepare('SELECT action, entity_id, payload_json FROM audit_log').all() as Record<string, any>[];
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'document.received');
    assert.equal(audit[0].entity_id, r.json.id);
    assert.equal(verifyAudit(db).ok, true);
    const jobs = db.prepare('SELECT kind, ref_id, state FROM jobs ORDER BY id').all() as Record<string, any>[];
    assert.deepEqual(jobs.map((j) => [j.kind, j.ref_id, j.state]), [['upload_receipt', r.json.id, 'queued'], ['extract', r.json.id, 'queued']]);
    assert.equal(triggered, 1);
  });

  test('同じバイト列は 409 duplicate。原本・行は増えない', async () => {
    const f = await fx('r11_receipt80.jpg');
    const a = await post({ kind: 'scan', size_preset: 'receipt80' }, f);
    assert.equal(a.status, 201);
    const b = await post({ kind: 'e_transaction' }, { ...f, name: 'other.jpg' });
    assert.equal(b.status, 409);
    assert.deepEqual([b.json.reason, b.json.id], ['duplicate', a.json.id]);
    assert.equal(count('documents'), 1);
    assert.equal(count('audit_log'), 1);
    assert.equal((await objectFiles()).length, 1);
  });

  test('kind が無ければ 422（R1）', async () => {
    const r = await post({ size_preset: 'receipt58' }, await fx('r01_receipt58.jpg'));
    assert.deepEqual([r.status, r.json.reason], [422, 'kind_required']);
    const r2 = await post({ kind: 'paper' }, await fx('r01_receipt58.jpg'));
    assert.deepEqual([r2.status, r2.json.reason], [422, 'invalid_kind']);
  });

  test('scan で size_preset が無ければ 422', async () => {
    const r = await post({ kind: 'scan' }, await fx('r01_receipt58.jpg'));
    assert.deepEqual([r.status, r.json.reason], [422, 'size_preset_required']);
  });

  for (const [file, preset] of [['r06_receipt58_under-200dpi.jpg', 'receipt58'], ['r16_receipt80_under-200dpi.jpg', 'receipt80']] as const) {
    test(`200dpi 未満は 422 resolution_too_low、何も保存しない（${file}）`, async () => {
      const r = await post({ kind: 'scan', size_preset: preset }, await fx(file));
      assert.deepEqual([r.status, r.json.reason], [422, 'resolution_too_low']);
      assert.equal(r.json.required.shortPx, preset === 'receipt58' ? 457 : 630);
      assert.equal(count('documents'), 0);
      assert.equal(count('audit_log'), 0);
      assert.equal(count('jobs'), 0);
      assert.deepEqual(await objectFiles(), []);
      assert.equal(triggered, 0);
    });
  }

  for (const [file, preset] of [['r07_receipt58_grayscale.jpg', 'receipt58'], ['r29_invoice-a4_grayscale.png', 'a4']] as const) {
    test(`グレースケールは 422（R3、${file}）`, async () => {
      const r = await post({ kind: 'scan', size_preset: preset }, await fx(file));
      assert.deepEqual([r.status, r.json.reason], [422, 'grayscale_or_low_bit_depth']);
      assert.equal(count('documents'), 0);
    });
  }

  test('A4 は長辺も判定する（受理できる寸法）', async () => {
    const r = await post({ kind: 'scan', size_preset: 'a4' }, await fx('r28_invoice-a4_over-5mb.jpg'));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const r2 = await post({ kind: 'scan', size_preset: 'a4' }, await fx('r11_receipt80.jpg'));
    assert.deepEqual([r2.status, r2.json.reason], [422, 'resolution_too_low']);
  });

  test('force=true なら解像度不足でも受理し、紙原本の保管が必要として記録', async () => {
    const r = await post({ kind: 'scan', size_preset: 'receipt58', force: 'true' }, await fx('r06_receipt58_under-200dpi.jpg'));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.deepEqual(r.json.warnings, ['resolution_too_low', 'paper_required']);
    const d = db.prepare('SELECT resolution_ok, color_ok, paper_required, paper_status FROM documents').get() as Record<string, any>;
    assert.deepEqual({ ...d }, { resolution_ok: 0, color_ok: 1, paper_required: 1, paper_status: 'keep_required' });
    const p = JSON.parse((db.prepare('SELECT payload_json FROM audit_log').get() as { payload_json: string }).payload_json);
    assert.equal(p.forced, true);
    assert.equal(p.paper_required, true);
    assert.deepEqual((db.prepare('SELECT kind FROM jobs ORDER BY id').all() as { kind: string }[]).map((j) => j.kind), ['upload_receipt', 'extract']);
  });

  test('force=true でグレースケール + 解像度不足も受理（color_ok=0）', async () => {
    const r = await post({ kind: 'scan', size_preset: 'receipt58', force: '1' }, await fx('r10_receipt58_under-200dpi_grayscale.jpg'));
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.warnings, ['resolution_too_low', 'grayscale_or_low_bit_depth', 'paper_required']);
    const d = db.prepare('SELECT resolution_ok, color_ok, paper_required FROM documents').get() as Record<string, any>;
    assert.deepEqual({ ...d }, { resolution_ok: 0, color_ok: 0, paper_required: 1 });
  });

  test('e_transaction の PDF は R2・R3 を適用しない。scan の PDF は 422', async () => {
    const f = await fx('r23_invoice-a4.pdf');
    const s = await post({ kind: 'scan', size_preset: 'a4' }, f);
    assert.deepEqual([s.status, s.json.reason], [422, 'scan_requires_image']);
    const r = await post({ kind: 'e_transaction' }, f);
    assert.equal(r.status, 201);
    const d = db.prepare('SELECT mime, resolution_ok, color_ok, paper_required FROM documents').get() as Record<string, any>;
    assert.deepEqual({ ...d }, { mime: 'application/pdf', resolution_ok: null, color_ok: null, paper_required: 0 });
  });

  test('許可外の中身は 415', async () => {
    const r = await post({ kind: 'e_transaction' }, { bytes: new TextEncoder().encode('GIF89a....'), name: 'x.jpg', type: 'image/jpeg' });
    assert.deepEqual([r.status, r.json.reason], [415, 'unsupported_media_type']);
  });

  test('サイズ上限を超えたら 413', async () => {
    make({ maxBytes: 10_000 });
    const r = await post({ kind: 'scan', size_preset: 'receipt58' }, await fx('r01_receipt58.jpg'));
    assert.deepEqual([r.status, r.json.reason], [413, 'too_large']);
    assert.equal(count('documents'), 0);
  });

  test('受領日: クライアントの値を記録し、期限はそこから。未来日・不正値は 422', async () => {
    const r = await post({ kind: 'scan', size_preset: 'receipt58', received_on: '2026-10-09' }, await fx('r02_receipt58.png'));
    assert.equal(r.status, 201);
    assert.equal(r.json.deadline_on, '2026-10-20');
    const d = db.prepare('SELECT received_on, received_on_source FROM documents').get() as Record<string, any>;
    assert.deepEqual({ ...d }, { received_on: '2026-10-09', received_on_source: 'client' });
    const f = await post({ kind: 'scan', size_preset: 'receipt58', received_on: '2026-10-17' }, await fx('r03_receipt58_reduced-rate-mix.jpg'));
    assert.deepEqual([f.status, f.json.reason], [422, 'received_on_in_future']);
    const x = await post({ kind: 'scan', size_preset: 'receipt58', received_on: '2026-02-30' }, await fx('r03_receipt58_reduced-rate-mix.jpg'));
    assert.deepEqual([x.status, x.json.reason], [422, 'invalid_received_on']);
  });

  test('no_ai なら extract を積まない（D12）', async () => {
    const r = await post({ kind: 'scan', size_preset: 'receipt80', no_ai: 'true' }, await fx('r12_receipt80.png'));
    assert.equal(r.status, 201);
    assert.deepEqual((db.prepare('SELECT kind FROM jobs').all() as { kind: string }[]).map((j) => j.kind), ['upload_receipt']);
    assert.equal((db.prepare('SELECT no_ai FROM documents').get() as { no_ai: number }).no_ai, 1);
  });

  test('file が無ければ 422', async () => {
    const r = await post({ kind: 'scan', size_preset: 'receipt58' });
    assert.deepEqual([r.status, r.json.reason], [422, 'file_required']);
  });

  test('認証ミドルウェアの差し込み口が /api/* の前に効く', async () => {
    make({ auth: async (c) => c.json({ reason: 'unauthorized' }, 401) });
    const r = await post({ kind: 'scan', size_preset: 'receipt58' }, await fx('r01_receipt58.jpg'));
    assert.equal(r.status, 401);
    assert.equal(count('documents'), 0);
  });
});
