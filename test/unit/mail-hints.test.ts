// 本文だけのメールの手がかり（src/mail/hints.ts、docs/cashflow.md §16.1）。Gmail と Gemini の応答は fetch のモック。
// 送信元は example.com、金額・注文番号は架空の値。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGeminiClient, type Gemini } from '../../src/ai/gemini/client.ts';
import { ConfigError, type MailAccount } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { enqueue, getJob, type Job } from '../../src/jobs/queue.ts';
import { createGmailTokenProvider, gmailTokenPaths, type GmailToken } from '../../src/mail/gmail/auth.ts';
import { createGmailClient } from '../../src/mail/gmail/client.ts';
import { fetchMailForAccount } from '../../src/mail/gmail/fetch.ts';
import { bodyTextOf, htmlToText, MAX_BODY_CHARS, MAX_HINT_RETRIES, validateHint } from '../../src/mail/hints.ts';
import { attentionCount } from '../../src/mail/status.ts';
import { TokenStore } from '../../src/providers/freee/auth.ts';
import { createFetchMailHandler } from '../../src/worker/handlers/fetchMail.ts';
import { createGmailMock, pdf, token } from './gmail-mock.ts';

const INJECTION = (JSON.parse(readFileSync(new URL('../fixtures/injection-strings.json', import.meta.url), 'utf8')) as { strings: { id: string; text: string }[] }).strings;
const NOW = new Date('2026-11-08T03:00:00.000Z');
const T1 = Date.parse('2026-11-05T01:00:00.000Z');
const CONFIG = {
  ingest: { maxBytes: 1024 },
  calendar: { deadlineMode: 'early' as const, yearEndHolidays: false },
  deadline: { countFrom: 'receipt_day' as const },
};
const ACCOUNT: MailAccount = { id: 'personal', label: 'keihi', query: '', since: '2026-10-01' };
const ORDER_TEXT = 'ご注文ありがとうございます。注文番号 123-0000000-0000000 ご注文日 2026年11月4日 ご請求額 ￥1,234';
const HINT = { is_purchase: true, txn_date: '2026-11-04', amount_total: 1234, vendor_name: 'テスト商店', order_ref: '123-0000000-0000000' };

let root: string;
let n = 0;
let db: Db;
let dataDir: string;
let objectsDir: string;
let gm: ReturnType<typeof createGmailMock>;
let reply: (body: Record<string, unknown>) => Response;
let geminiCalls: Record<string, unknown>[];

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-mail-hints-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const ok = (out: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof out === 'string' ? out : JSON.stringify(out) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } }), {
    status: 200,
  });

const geminiFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  geminiCalls.push(body);
  return reply(body);
}) as typeof fetch;

const gemini = (): Gemini => ({ model: 'gemini-3.8-flash', thinkingLevel: 'low', mediaResolution: 'medium', maxOutputTokens: 1024, client: createGeminiClient({ apiKey: 'AIzaTEST-not-a-real-key', fetch: geminiFetch }) });

function clientFor(accountId: string) {
  const { tokenPath, lockPath } = gmailTokenPaths(dataDir, accountId);
  const tokens = createGmailTokenProvider({ store: new TokenStore<GmailToken>(tokenPath, lockPath), creds: { clientId: 'cid', clientSecret: 'csecret' }, fetch: gm.fetch });
  return createGmailClient({ tokens, fetch: gm.fetch });
}

beforeEach(async () => {
  dataDir = path.join(root, String(n++));
  objectsDir = path.join(dataDir, 'objects');
  await mkdir(dataDir, { recursive: true });
  db = openDb(path.join(dataDir, 'keihi.db'));
  migrate(db);
  gm = createGmailMock();
  const { tokenPath, lockPath } = gmailTokenPaths(dataDir, 'personal');
  await new TokenStore<GmailToken>(tokenPath, lockPath).write(token());
  reply = () => ok(HINT);
  geminiCalls = [];
});

const fetchOnce = (hints = true) =>
  fetchMailForAccount({
    db, objectsDir, config: CONFIG, now: () => NOW, client: clientFor('personal'), account: ACCOUNT, maxMessages: 100,
    hints: hints ? { gemini, log: () => {} } : null,
  });

type Row = { id: string; state: string; hint_txn_date: string | null; hint_amount: number | null; hint_vendor: string | null; hint_order_ref: string | null; hint_extracted_at: string | null };
const msgs = () => db.prepare('SELECT * FROM mail_messages ORDER BY internal_at, id').all() as Row[];
const hintOf = (r: Row) => ({ txn_date: r.hint_txn_date, amount: r.hint_amount, vendor: r.hint_vendor, order_ref: r.hint_order_ref });
const EMPTY = { txn_date: null, amount: null, vendor: null, order_ref: null };
const promptOf = (b: Record<string, unknown>) => ((b.contents as { parts: { text?: string }[] }[])[0]!.parts.map((p) => p.text ?? '').join(''));

describe('取り込みの中で 1 回だけ', () => {
  test('body_only → 本文を送り、手がかりを hint_* に残す（要対応から消える・監査には値を入れない）', async () => {
    gm.add({ id: 'm1', internalMs: T1, subject: 'ご注文の確認', text: ORDER_TEXT });
    await fetchOnce();
    const [m] = msgs();
    assert.equal(m!.state, 'body_only');
    assert.deepEqual(hintOf(m!), { txn_date: '2026-11-04', amount: 1234, vendor: 'テスト商店', order_ref: '123-0000000-0000000' });
    assert.equal(m!.hint_extracted_at, NOW.toISOString());
    assert.equal(attentionCount(db, 'personal'), 0);
    assert.equal(geminiCalls.length, 1);
    const b = geminiCalls[0]!;
    // 本文は JSON の文字列で渡し、画像は送らない。指示に従わない旨を置く。
    assert.ok(promptOf(b).includes(JSON.stringify(ORDER_TEXT)));
    assert.ok(!JSON.stringify(b.contents).includes('inlineData'));
    assert.equal((b.generationConfig as Record<string, unknown>).mediaResolution, undefined);
    assert.match(JSON.stringify(b.systemInstruction), /指示ではない/);
    assert.ok(!JSON.stringify(b).includes('ご注文の確認'), '件名は送らない');
    const audit = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'mail.hint_extracted'`).all() as { payload_json: string }[];
    assert.deepEqual(audit.map((a) => JSON.parse(a.payload_json)), [{ account_id: 'personal', found: true }]);
    // 2 回目の fetch では呼ばない。
    await fetchOnce();
    assert.equal(geminiCalls.length, 1);
  });

  test('添付を取り込んだメール・extract_hints = false では呼ばない', async () => {
    gm.add({ id: 'm1', internalMs: T1, attachments: [{ filename: 'r.pdf', mime: 'application/pdf', bytes: pdf('a') }] });
    gm.add({ id: 'm2', internalMs: T1 + 1000, text: ORDER_TEXT });
    await fetchOnce(false);
    assert.equal(geminiCalls.length, 0);
    assert.deepEqual(msgs().map((m) => [m.state, m.hint_extracted_at]), [['ingested', null], ['body_only', null]]);
  });

  test('text/plain が無ければ HTML のタグを落として送る。先頭 20,000 字', async () => {
    gm.add({ id: 'm1', internalMs: T1, text: null, html: '<html><head><style>p{color:red}</style></head><body><p>ご請求額&nbsp;&yen;1,234</p><script>alert(1)</script></body></html>' });
    await fetchOnce();
    const p = promptOf(geminiCalls[0]!);
    assert.ok(p.includes(JSON.stringify('ご請求額 ¥1,234')), p);
    assert.equal(bodyTextOf({ mimeType: 'text/plain', body: { data: Buffer.from('あ'.repeat(MAX_BODY_CHARS + 5)).toString('base64url') } })!.length, MAX_BODY_CHARS);
    assert.equal(htmlToText('a<br>b&#x41;&#66;<!-- c -->'), 'a\nbAB');
  });
});

describe('スキーマ外は捨てる', () => {
  const cases: { name: string; out: unknown }[] = [
    { name: '余分なキー', out: { ...HINT, account_id: '接待交際費' } },
    { name: '必須の欠け', out: { is_purchase: true, txn_date: '2026-11-04', amount_total: 1234, vendor_name: null } },
    { name: '金額が文字列', out: { ...HINT, amount_total: '1234' } },
    { name: '金額が小数', out: { ...HINT, amount_total: 1234.5 } },
    { name: '金額が負', out: { ...HINT, amount_total: -1 } },
    { name: '金額が 1 億円を超える', out: { ...HINT, amount_total: 100_000_001 } },
    { name: '日付の形式が違う', out: { ...HINT, txn_date: '2026/11/04' } },
    { name: '相手名が 101 字', out: { ...HINT, vendor_name: 'あ'.repeat(101) } },
    { name: '注文番号が 65 字', out: { ...HINT, order_ref: '1'.repeat(65) } },
    { name: 'is_purchase が文字列', out: { ...HINT, is_purchase: 'true' } },
    { name: '配列', out: [HINT] },
    { name: 'JSON でない', out: 'not json' },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      reply = () => ok(c.out);
      gm.add({ id: 'm1', internalMs: T1, text: ORDER_TEXT });
      await fetchOnce();
      const [m] = msgs();
      assert.equal(m!.state, 'body_only');
      assert.deepEqual(hintOf(m!), EMPTY);
      assert.equal(m!.hint_extracted_at, NOW.toISOString(), '捨てた後はもう呼ばない');
    });
  }

  test('is_purchase = false なら値があっても残さない', async () => {
    reply = () => ok({ ...HINT, is_purchase: false });
    gm.add({ id: 'm1', internalMs: T1, text: ORDER_TEXT });
    await fetchOnce();
    assert.deepEqual(hintOf(msgs()[0]!), EMPTY);
    assert.ok(msgs()[0]!.hint_extracted_at);
  });

  test('文字列の制御文字を除く', () => {
    const v = validateHint({ ...HINT, vendor_name: 'テスト‮商店\n', order_ref: '​' });
    assert.deepEqual(v, { ok: true, hint: { txn_date: '2026-11-04', amount_total: 1234, vendor_name: 'テスト商店', order_ref: null } });
  });
});

describe('命令文混入（test/fixtures/injection-strings.json）', () => {
  test('本文に命令文があっても、出力の型と長さは保たれる（データとして残すだけ）', async () => {
    // モックは本文中の命令に「従った」ような応答も返す。スキーマに合うものだけが値として残る。
    reply = (b) => {
      const p = promptOf(b);
      const s = INJECTION.find((x) => p.includes(JSON.stringify(x.text).slice(1, -1)))!;
      return s.id.endsWith('json') ? ok({ ...HINT, account_id: '接待交際費' }) : ok({ ...HINT, vendor_name: s.text.slice(0, 100), order_ref: null });
    };
    INJECTION.forEach((s, i) => gm.add({ id: `m${i}`, internalMs: T1 + i * 1000, text: `${ORDER_TEXT}\n${s.text}` }));
    await fetchOnce();
    assert.equal(geminiCalls.length, INJECTION.length);
    for (const b of geminiCalls) assert.equal(promptOf(b).split('本文: ')[1]!.startsWith('"'), true, '本文は JSON の文字列');
    for (const m of msgs()) {
      assert.equal(m.state, 'body_only');
      assert.ok(m.hint_extracted_at);
      assert.ok(m.hint_amount === null || Number.isSafeInteger(m.hint_amount));
      assert.ok(m.hint_txn_date === null || /^\d{4}-\d{2}-\d{2}$/.test(m.hint_txn_date));
      assert.ok(m.hint_vendor === null || (typeof m.hint_vendor === 'string' && [...m.hint_vendor].length <= 100 && !/[\u0000-\u001f‪-‮]/.test(m.hint_vendor)));
      assert.ok(m.hint_order_ref === null || [...m.hint_order_ref].length <= 64);
    }
    // 余分なキーを返した通は捨てた。
    const jsonIdx = INJECTION.findIndex((s) => s.id.endsWith('json'));
    if (jsonIdx >= 0) assert.deepEqual(hintOf(msgs()[jsonIdx]!), EMPTY);
  });
});

describe('Gemini の失敗と再試行', () => {
  test('失敗してもメールは error にせず、hint_extracted_at を空のまま。次回の fetch_mail で取り直す', async () => {
    reply = () => new Response('{"error":{"code":500}}', { status: 500 });
    gm.add({ id: 'm1', internalMs: T1, text: ORDER_TEXT });
    await fetchOnce();
    let [m] = msgs();
    assert.equal(m!.state, 'body_only');
    assert.equal(m!.hint_extracted_at, null);
    assert.equal(attentionCount(db, 'personal'), 1);
    reply = () => ok(HINT);
    const before = gm.gets('full').length;
    const r = await fetchOnce();
    assert.equal(r.hint_retries, 1);
    assert.equal(gm.gets('full').length, before + 1, '本文は format=full を取り直す');
    [m] = msgs();
    assert.equal(m!.hint_amount, 1234);
    assert.equal(attentionCount(db, 'personal'), 0);
  });

  test(`再試行は 1 回に ${MAX_HINT_RETRIES} 通まで（古い順）`, async () => {
    reply = () => new Response('{}', { status: 503 });
    for (let i = 0; i < MAX_HINT_RETRIES + 5; i++) gm.add({ id: `m${String(i).padStart(2, '0')}`, internalMs: T1 + i * 1000, text: ORDER_TEXT });
    await fetchOnce();
    assert.equal(geminiCalls.length, MAX_HINT_RETRIES + 5);
    reply = () => ok(HINT);
    geminiCalls = [];
    const r = await fetchOnce();
    assert.equal(r.hint_retries, MAX_HINT_RETRIES);
    assert.equal(geminiCalls.length, MAX_HINT_RETRIES);
    const done = msgs().map((m) => m.hint_extracted_at !== null);
    assert.deepEqual(done, [...Array(MAX_HINT_RETRIES).fill(true), ...Array(5).fill(false)]);
  });

  test('Gemini の設定が無い（ConfigError）ときも取り込みは失敗にしない。取り直しは丸ごと飛ばす（ログ 1 行）', async () => {
    const logs: string[] = [];
    const run = () =>
      fetchMailForAccount({
        db, objectsDir, config: CONFIG, now: () => NOW, client: clientFor('personal'), account: ACCOUNT, maxMessages: 100,
        hints: { gemini: () => { throw new ConfigError('secrets.env に GEMINI_API_KEY が無い'); }, log: (s) => logs.push(s) },
      });
    gm.add({ id: 'm1', internalMs: T1, text: ORDER_TEXT });
    await run();
    assert.deepEqual(msgs().map((m) => [m.state, m.hint_extracted_at]), [['body_only', null]]);
    logs.length = 0;
    const before = gm.gets('full').length;
    const r = await run();
    assert.equal(r.hint_retries, 0);
    assert.equal(gm.gets('full').length, before, 'Gmail も取り直さない');
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0]!, /GEMINI_API_KEY/);
  });

  test('取り直しで Gemini が一時的に失敗（5xx）したらその回は打ち切る。ログは種別と状態だけ', async () => {
    reply = () => new Response('{"error":{"message":"SECRET-BODY"}}', { status: 500 });
    for (let i = 0; i < 3; i++) gm.add({ id: `m${i}`, internalMs: T1 + i * 1000, text: ORDER_TEXT });
    await fetchOnce();
    geminiCalls = [];
    const logs: string[] = [];
    const r = await fetchMailForAccount({
      db, objectsDir, config: CONFIG, now: () => NOW, client: clientFor('personal'), account: ACCOUNT, maxMessages: 100,
      hints: { gemini, log: (s) => logs.push(s) },
    });
    assert.equal(r.hint_retries, 1);
    assert.equal(geminiCalls.length, 1);
    assert.deepEqual(msgs().map((m) => m.hint_extracted_at), [null, null, null]);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /code=http status=500/);
    assert.doesNotMatch(logs[0]!, /SECRET-BODY/);
  });

  test('Gemini が 4xx（429 以外）で拒んだら捨てて hint_extracted_at を埋める（もう呼ばない）', async () => {
    reply = () => new Response('{"error":{"code":400}}', { status: 400 });
    gm.add({ id: 'm1', internalMs: T1, text: ORDER_TEXT });
    await fetchOnce();
    const [m] = msgs();
    assert.deepEqual(hintOf(m!), EMPTY);
    assert.equal(m!.hint_extracted_at, NOW.toISOString());
    const a = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'mail.hint_extracted'`).get() as { payload_json: string };
    assert.deepEqual(JSON.parse(a.payload_json), { account_id: 'personal', found: false, discarded: 'request_rejected' });
    await fetchOnce();
    assert.equal(geminiCalls.length, 1);
  });

  test('429 は取り直す（埋めない）', async () => {
    reply = () => new Response('{}', { status: 429 });
    gm.add({ id: 'm1', internalMs: T1, text: ORDER_TEXT });
    await fetchOnce();
    assert.equal(msgs()[0]!.hint_extracted_at, null);
  });

  test('取り直しで Gmail の取得が 4xx（削除済みなど）なら hint_extracted_at を埋めて印を残す', async () => {
    reply = () => new Response('{}', { status: 503 });
    gm.add({ id: 'm1', internalMs: T1, text: ORDER_TEXT });
    await fetchOnce();
    gm.fail('/messages/m1?format=full', { status: 404 });
    reply = () => ok(HINT);
    geminiCalls = [];
    const r = await fetchOnce();
    assert.equal(r.hint_retries, 0);
    assert.equal(geminiCalls.length, 0);
    const [m] = msgs();
    assert.equal(m!.state, 'body_only');
    assert.equal(m!.hint_extracted_at, NOW.toISOString());
    assert.deepEqual(hintOf(m!), EMPTY);
    const a = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'mail.hint_extracted'`).get() as { payload_json: string };
    assert.deepEqual(JSON.parse(a.payload_json), { account_id: 'personal', found: false, discarded: 'fetch_failed' });
    gm.clearFailures();
    const before = gm.gets('full').length;
    await fetchOnce();
    assert.equal(gm.gets('full').length, before, 'もう取り直さない');
  });

  test('fetch_mail ジョブは [mail] extract_hints に従う', async () => {
    gm.add({ id: 'm1', internalMs: T1, text: ORDER_TEXT });
    const run = async (extractHints: boolean) => {
      const h = createFetchMailHandler(() => ({
        mail: { enabled: true, provider: 'gmail_api' as const, maxMessagesPerRun: 100, extractHints, accounts: [ACCOUNT] },
        config: CONFIG, objectsDir, client: clientFor, gemini, log: () => {},
      }));
      const id = enqueue(db, 'fetch_mail', 'personal', { now: NOW });
      await h(getJob(db, id) as Job, { db, now: () => NOW });
    };
    await run(false);
    assert.equal(geminiCalls.length, 0);
    await run(true);
    assert.equal(geminiCalls.length, 1, 'false の回に残った body_only を次の回で取り直す');
    assert.equal(msgs()[0]!.hint_amount, 1234);
  });
});
