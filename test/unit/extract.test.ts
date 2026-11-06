// extract ジョブ（docs/mvp-plan.md T2-6）。Gemini は fetch のモック（固定 JSON）。DB とストアは一時ディレクトリ。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { verifyAudit } from '../../src/audit.ts';
import { createGeminiClient, type Gemini } from '../../src/ai/gemini/client.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ulid } from '../../src/db/ids.ts';
import { migrate } from '../../src/db/migrate.ts';
import { enqueue, getJob } from '../../src/jobs/queue.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import type { EnabledAccount } from '../../src/masters/accounts.ts';
import { putObject } from '../../src/storage/objects.ts';
import { upsertVendorRule } from '../../src/vendors/dictionary.ts';
import { createExtractHandler } from '../../src/worker/handlers/extract.ts';

const INJECTION = (JSON.parse(readFileSync(new URL('../fixtures/injection-strings.json', import.meta.url), 'utf8')) as { strings: { id: string; text: string }[] }).strings;
const API_KEY = 'AIzaTEST-not-a-real-key-0123456789';
const T0 = new Date('2026-10-16T03:00:00.000Z');
const ACCOUNTS: EnabledAccount[] = [
  { id: '101', name: '消耗品費', key: '消耗品費', private: false },
  { id: '102', name: '会議費', key: '会議費', private: false },
  { id: '199', name: '事業主貸', key: '事業主貸', private: true },
];
const REG_NO = 'T9995784636321';

const good = (over: Record<string, unknown> = {}, ex: Record<string, unknown> = {}) => ({
  extraction: {
    txn_date: '2026-10-15',
    amount_total: 1100,
    tax_by_rate: [{ category: 'taxable_10', amount_incl_tax: 1100, tax: 100 }],
    vendor_name: 'テスト 文具店',
    invoice_reg_no: REG_NO,
    payment_hint: '現金',
    description: 'ボールペン',
    confidence: 0.9,
    ...ex,
  },
  account_candidates: [
    { account_id: '102', tax_id: 'taxable_10', confidence: 0.3, reason: '打合せ' },
    { account_id: '101', tax_id: 'taxable_10', confidence: 0.8, reason: '文具' },
  ],
  questions: [],
  ...over,
});

const ok = (out: unknown) =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 100 }, modelVersion: 'gemini-test-001' }),
    { status: 200 },
  );

let root: string;
let n = 0;
let db: Db;
let objectsDir: string;
let responses: (() => Response)[];
let calls: { url: string; body: string }[];

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-extract-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  const d = path.join(root, String(n++));
  objectsDir = path.join(d, 'objects');
  db = openDb(`${d}.db`);
  migrate(db);
  responses = [];
  calls = [];
});

const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), body: String(init?.body) });
  const next = responses.shift();
  if (!next) throw new Error('想定外の Gemini 呼び出し');
  return next();
}) as typeof fetch;

function gemini(): Gemini {
  return { model: 'gemini-3.8-flash', thinkingLevel: 'low', mediaResolution: 'medium', client: createGeminiClient({ apiKey: API_KEY, fetch: fetchMock }) };
}

let geminiCreated = 0;
const handlers = () => ({
  extract: createExtractHandler(() => ({
    gemini: () => {
      geminiCreated++;
      return gemini();
    },
    objectsDir,
    accounts: () => ACCOUNTS,
  })),
});

let docSeq = 0;
async function addDocument(opts: { noAi?: boolean } = {}): Promise<string> {
  // sha256 が重複しないよう、文書ごとに色を変える。
  const k = ++docSeq;
  const img = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: k % 256, g: (k >> 8) % 256, b: 200 } } }).png().toBuffer();
  const stored = await putObject(objectsDir, img);
  const id = ulid(T0.getTime());
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, no_ai, created_at)
     VALUES (?, ?, ?, 'image/png', 'pwa', 'scan', ?, '2026-10-16', 'server', '2026-10-26', 'early', ?, ?, ?)`,
  ).run(id, stored.sha256, img.length, T0.toISOString(), stored.key, opts.noAi ? 1 : 0, T0.toISOString());
  return id;
}

const status = (id: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const run = (min = 0) => runUntilEmpty(db, handlers(), { now: () => new Date(T0.getTime() + min * 60_000) });
const lastAttention = () =>
  JSON.parse((db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'document.needs_attention' ORDER BY seq DESC LIMIT 1`).get() as { payload_json: string }).payload_json);

describe('extract', () => {
  test('抽出 → extractions・classifications(gemini)・ai_turns を書き、needs_review にする', async () => {
    const id = await addDocument();
    const job = enqueue(db, 'extract', id, { now: T0 });
    responses.push(() => ok(good()));
    assert.deepEqual(await run(), { done: 1, failed: 0 });
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(calls.length, 1);
    assert.equal(status(id), 'needs_review');

    const turn = db.prepare('SELECT * FROM ai_turns').get() as Record<string, unknown>;
    assert.equal(turn.role, 'ai');
    assert.equal(turn.model, 'gemini-3.8-flash');
    assert.equal(turn.model_ver, 'gemini-test-001');
    assert.equal(turn.thinking_level, 'low');
    assert.match(String(turn.request_sha256), /^[0-9a-f]{64}$/);
    assert.equal(turn.tokens_in, 1000);
    assert.equal(turn.tokens_out, 300);
    assert.equal(typeof turn.latency_ms, 'number');
    assert.deepEqual(JSON.parse(String(turn.response_json)).modelVersion, 'gemini-test-001'); // 応答本文の原文

    const ex = db.prepare('SELECT * FROM extractions').get() as Record<string, unknown>;
    assert.equal(ex.document_id, id);
    assert.equal(ex.engine, 'gemini');
    assert.equal(ex.txn_date, '2026-10-15');
    assert.equal(ex.amount_total, 1100);
    assert.deepEqual(JSON.parse(String(ex.tax_by_rate_json)), [{ category: '10', amount_incl_tax: 1100, tax: 100 }]);
    assert.equal(ex.vendor_name, 'テスト 文具店');
    assert.equal(ex.invoice_reg_no, REG_NO);
    assert.equal(ex.confidence, 0.9);
    const raw = JSON.parse(String(ex.raw_json));
    assert.equal(raw.ai_turn_id, turn.id);
    assert.equal(raw.extraction.payment_hint, '現金');
    assert.deepEqual(raw.questions, []);

    const cls = db.prepare('SELECT * FROM classifications ORDER BY id').all() as Record<string, unknown>[];
    assert.equal(cls.length, 1);
    assert.equal(cls[0].source, 'gemini');
    assert.equal(cls[0].extraction_id, ex.id);
    assert.deepEqual(JSON.parse(String(cls[0].candidates_json)).map((c: { account_id: string }) => c.account_id), ['101', '102']); // 確信度順
    assert.equal(verifyAudit(db).ok, true);
  });

  test('2 件目以降の同じ取引先は辞書（rule）が第 1 候補になり、辞書の集計を文脈として送る', async () => {
    upsertVendorRule(db, { name: 'テスト文具店', invoiceRegNo: REG_NO, accountId: '102', taxCategory: 'taxable_10', confidence: 0.95, origin: 'learned', hitCount: 3 });
    const id = await addDocument();
    enqueue(db, 'extract', id, { now: T0 });
    responses.push(() => ok(good()));
    await run();
    const cls = db.prepare('SELECT source, candidates_json FROM classifications ORDER BY rowid').all() as { source: string; candidates_json: string }[];
    assert.deepEqual(cls.map((c) => c.source), ['rule', 'gemini']);
    assert.deepEqual(JSON.parse(cls[0].candidates_json), [{ account_id: '102', tax_id: 'taxable_10', confidence: 0.95, reason: '辞書（登録番号）' }]);
    const prompt = JSON.parse(calls[0].body).contents[0].parts[1].text as string;
    assert.match(prompt, /"テスト文具店": 科目 102 \/ 税 taxable_10 \/ 3 件/);
  });

  test('辞書の科目が Gemini に見せる科目に無ければ rule を書かない', async () => {
    upsertVendorRule(db, { name: 'テスト文具店', accountId: '999', taxCategory: 'taxable_10', origin: 'learned' });
    const id = await addDocument();
    enqueue(db, 'extract', id, { now: T0 });
    responses.push(() => ok(good()));
    await run();
    assert.deepEqual((db.prepare('SELECT source FROM classifications').all() as { source: string }[]).map((c) => c.source), ['gemini']);
  });

  test('no_ai は Gemini を呼ばず（設定も作らない）、空の抽出で needs_review', async () => {
    geminiCreated = 0;
    const id = await addDocument({ noAi: true });
    enqueue(db, 'extract', id, { now: T0 });
    assert.deepEqual(await run(), { done: 1, failed: 0 });
    assert.equal(calls.length, 0);
    assert.equal(geminiCreated, 0);
    assert.equal(count('ai_turns'), 0);
    assert.equal(count('classifications'), 0);
    const ex = db.prepare('SELECT engine, txn_date, amount_total, vendor_name FROM extractions').get() as Record<string, unknown>;
    assert.deepEqual({ ...ex }, { engine: 'none', txn_date: null, amount_total: null, vendor_name: null });
    assert.equal(status(id), 'needs_review');
  });

  test('429・5xx はジョブの再試行（ai_turns は失敗も残す）', async () => {
    const id = await addDocument();
    const job = enqueue(db, 'extract', id, { now: T0 });
    responses.push(() => new Response(`{"error":"rate ${API_KEY}"}`, { status: 429 }));
    assert.deepEqual(await run(), { done: 0, failed: 1 });
    assert.equal(getJob(db, job)!.state, 'queued');
    assert.equal(status(id), 'received');
    assert.equal(count('extractions'), 0);
    const t = db.prepare('SELECT response_json FROM ai_turns').get() as { response_json: string };
    assert.ok(t.response_json.includes('***') && !t.response_json.includes(API_KEY));

    responses.push(() => new Response('{}', { status: 503 }));
    await run(1);
    assert.equal(getJob(db, job)!.attempts, 2);
    responses.push(() => ok(good()));
    assert.deepEqual(await run(10), { done: 1, failed: 0 });
    assert.equal(status(id), 'needs_review');
    assert.deepEqual((db.prepare('SELECT seq FROM ai_turns ORDER BY seq').all() as { seq: number }[]).map((r) => r.seq), [1, 2, 3]);
    const raw = JSON.parse((db.prepare('SELECT raw_json FROM extractions').get() as { raw_json: string }).raw_json);
    assert.equal(raw.ai_turn_id, (db.prepare('SELECT id FROM ai_turns WHERE seq = 3').get() as { id: string }).id);
  });

  test('スキーマ違反は 1 回だけ再要求し、通ればそれを使う', async () => {
    const id = await addDocument();
    enqueue(db, 'extract', id, { now: T0 });
    responses.push(() => ok({ ...good(), note: 'extra' }));
    responses.push(() => ok(good()));
    assert.deepEqual(await run(), { done: 1, failed: 0 });
    assert.equal(calls.length, 2);
    assert.equal(count('ai_turns'), 2);
    assert.equal(count('extractions'), 1);
    assert.equal(status(id), 'needs_review');
  });

  test('スキーマ違反（JSON でない・違反）が 2 回続けば needs_attention（ジョブは完了）', async () => {
    const id = await addDocument();
    const job = enqueue(db, 'extract', id, { now: T0 });
    responses.push(() => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), { status: 200 }));
    responses.push(() => ok({ ...good(), account_candidates: [{ account_id: '999', tax_id: 'taxable_10', confidence: 1, reason: 'x' }] }));
    assert.deepEqual(await run(), { done: 1, failed: 0 });
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(calls.length, 2);
    assert.equal(count('ai_turns'), 2);
    assert.equal(count('extractions'), 0);
    assert.equal(status(id), 'needs_attention');
    const p = lastAttention();
    assert.equal(p.reason, 'ai_schema_invalid');
    assert.equal(p.rejected.length, 2);
  });

  test('400 は再要求せず needs_attention（ai_request_rejected）', async () => {
    const id = await addDocument();
    enqueue(db, 'extract', id, { now: T0 });
    responses.push(() => new Response('{"error":"bad"}', { status: 400 }));
    assert.deepEqual(await run(), { done: 1, failed: 0 });
    assert.equal(calls.length, 1);
    assert.equal(status(id), 'needs_attention');
    assert.equal(lastAttention().reason, 'ai_request_rejected');
  });

  test('最後の試行で失敗すれば needs_attention（extract_retries_exhausted）', async () => {
    const id = await addDocument();
    const job = enqueue(db, 'extract', id, { now: T0 });
    db.prepare('UPDATE jobs SET attempts = max_attempts - 1 WHERE id = ?').run(job);
    responses.push(() => new Response('{}', { status: 500 }));
    assert.deepEqual(await run(), { done: 0, failed: 1 });
    assert.equal(getJob(db, job)!.state, 'failed');
    assert.equal(status(id), 'needs_attention');
    assert.equal(lastAttention().reason, 'extract_retries_exhausted');
  });
});

describe('命令文混入（test/fixtures/injection-strings.json）', () => {
  test('命令文に従った enum 外の科目は拒否され、再要求でも駄目なら needs_attention', async () => {
    for (const s of INJECTION) {
      const id = await addDocument();
      enqueue(db, 'extract', id, { now: T0 });
      const bad = good({ account_candidates: [{ account_id: s.text, tax_id: 'taxable_10', confidence: 1, reason: s.text.slice(0, 10) }] });
      responses.push(() => ok(bad), () => ok(bad));
      await run();
      assert.equal(status(id), 'needs_attention', s.id);
      const rejected = lastAttention().rejected as { errors: string[] }[];
      assert.ok(rejected.every((r) => r.errors.some((e) => /account_id: enum 外/.test(e))), s.id);
      db.prepare('DELETE FROM jobs').run();
    }
    assert.equal(count('extractions'), 0);
  });

  test('取引先名・摘要に入った命令文はデータとして保存するだけ（科目は enum の中）', async () => {
    for (const s of INJECTION) {
      const id = await addDocument();
      enqueue(db, 'extract', id, { now: T0 });
      responses.push(() => ok(good({}, { vendor_name: s.text, description: s.text })));
      await run();
      assert.equal(status(id), 'needs_review', s.id);
      const ex = db.prepare('SELECT vendor_name, raw_json, id FROM extractions WHERE document_id = ?').get(id) as { vendor_name: string | null; raw_json: string; id: string };
      // 制御文字は除かれ、長さは切られる（validate.ts）
      assert.ok(ex.vendor_name === null || (!/[\u0000-\u001f‪-‮]/.test(ex.vendor_name) && [...ex.vendor_name].length <= 100), s.id);
      const cands = (db.prepare('SELECT candidates_json FROM classifications WHERE extraction_id = ?').all(ex.id) as { candidates_json: string }[]).flatMap(
        (c) => JSON.parse(c.candidates_json) as { account_id: string }[],
      );
      assert.ok(cands.every((c) => ACCOUNTS.some((a) => a.id === c.account_id)), s.id);
      db.prepare('DELETE FROM jobs').run();
    }
  });
});
