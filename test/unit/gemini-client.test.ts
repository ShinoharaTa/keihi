// Gemini クライアント（docs/mvp-plan.md T2-3）。実 API は呼ばない（fetch をモック）。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { createGeminiFromConfig, extractReceipt, GeminiError } from '../../src/ai/gemini/client.ts';
import { buildResponseSchema } from '../../src/ai/gemini/schema.ts';

const API_KEY = 'AIzaTEST-not-a-real-key-0123456789';
const MARK = 'EXIF-MARK-should-not-leave';
const ACCOUNTS = [{ id: '101', name: '消耗品費' }, { id: '102', name: '会議費' }];

let root: string;
let n = 0;
let jpeg: Buffer;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-gemini-client-'));
  jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).jpeg().withExif({ IFD0: { Artist: MARK } }).toBuffer();
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function cfg(toml: string, env = `GEMINI_API_KEY=${API_KEY}\n`) {
  const d = path.join(root, String(n++));
  await mkdir(d);
  await writeFile(path.join(d, 'config.toml'), toml);
  await writeFile(path.join(d, 'secrets.env'), env);
  await chmod(path.join(d, 'secrets.env'), 0o600);
  return loadConfig({ configDir: d, dataDir: path.join(d, 'data') });
}

function mock(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, modelVersion: 'v-test' }), { status: 200 });

describe('createGeminiFromConfig', () => {
  test('paid_tier_confirmed が無い・キーが無いなら ConfigError（キーは出さない）', async () => {
    assert.throws(() => createGeminiFromConfig(cfgSync()), ConfigError);
    const noKey = await cfg('[gemini]\npaid_tier_confirmed = true\n', '');
    assert.throws(() => createGeminiFromConfig(noKey), /GEMINI_API_KEY/);
  });

  test('U7 の既定（low / medium）と設定の上書き', async () => {
    const g = createGeminiFromConfig(await cfg('[gemini]\npaid_tier_confirmed = true\n'));
    assert.deepEqual([g.model, g.thinkingLevel, g.mediaResolution], ['gemini-3.8-flash', 'low', 'medium']);
    const h = createGeminiFromConfig(await cfg('[gemini]\npaid_tier_confirmed = true\nthinking_level = "medium"\nmedia_resolution = "high"\n'));
    assert.deepEqual([h.thinkingLevel, h.mediaResolution], ['medium', 'high']);
  });
});

function cfgSync() {
  return loadConfig({ configDir: path.join(root, 'none') });
}

describe('extractReceipt', () => {
  test('派生画像（EXIF なし）を inline で送り、科目の enum を持つ構造化出力を要求する', async () => {
    const m = mock(() => ok('{"a":1}'));
    const g = createGeminiFromConfig(await cfg('[gemini]\npaid_tier_confirmed = true\n'), { fetch: m.fetch });
    const r = await extractReceipt(g, { original: jpeg, accounts: ACCOUNTS, context: '辞書の集計: なし' });
    assert.deepEqual(r.json, { a: 1 });
    assert.match(r.requestSha256, /^[0-9a-f]{64}$/);
    assert.equal(r.modelVersion, 'v-test');
    assert.equal(m.calls.length, 1);
    const body = JSON.parse(String(m.calls[0].init.body));
    const inline = body.contents[0].parts[0].inlineData;
    assert.equal(inline.mimeType, 'image/jpeg');
    assert.ok(!Buffer.from(inline.data, 'base64').includes(MARK));
    assert.ok(jpeg.includes(MARK)); // 原本は書き換えない
    assert.deepEqual(body.generationConfig.responseJsonSchema, buildResponseSchema(ACCOUNTS));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
    assert.equal(body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_MEDIUM');
    assert.match(body.contents[0].parts[1].text, /101: 消耗品費/);
    assert.match(body.contents[0].parts[1].text, /辞書の集計: なし/);
    assert.ok(!/fileData|fileUri|cachedContent|"store"/.test(String(m.calls[0].init.body)));
    assert.ok(!m.calls[0].url.includes(API_KEY));
  });

  test('429・5xx・接続失敗は retryable、400 は違う。応答本文のキーは *** になる', async () => {
    const c = await cfg('[gemini]\npaid_tier_confirmed = true\n');
    for (const [status, retryable] of [[429, true], [500, true], [503, true], [400, false], [403, false]] as const) {
      const g = createGeminiFromConfig(c, { fetch: mock(() => new Response(`{"error":"key ${API_KEY}"}`, { status })).fetch });
      await assert.rejects(extractReceipt(g, { original: jpeg, accounts: ACCOUNTS }), (e: unknown) => {
        assert.ok(e instanceof GeminiError);
        assert.equal(e.retryable, retryable, String(status));
        assert.ok(!e.message.includes(API_KEY) && !String(e.responseBody).includes(API_KEY));
        assert.match(String(e.responseBody), /\*\*\*/);
        return true;
      });
    }
    const down = createGeminiFromConfig(c, { fetch: (async () => { throw new TypeError(`fetch failed ${API_KEY}`); }) as typeof fetch });
    await assert.rejects(extractReceipt(down, { original: jpeg, accounts: ACCOUNTS }), (e: unknown) => e instanceof GeminiError && e.retryable && !e.message.includes(API_KEY));
    const bad = createGeminiFromConfig(c, { fetch: mock(() => ok('not json')).fetch });
    await assert.rejects(extractReceipt(bad, { original: jpeg, accounts: ACCOUNTS }), (e: unknown) => e instanceof GeminiError && e.malformed && !e.retryable);
  });
});
