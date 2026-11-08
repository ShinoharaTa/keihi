// メールからの証憑の取り込み（docs/cashflow.md §16）。Gmail の応答は fetch のモック（test/unit/gmail-mock.ts）。
// DB・原本ストア・トークンは一時ディレクトリ。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import type { MailAccount } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { enqueue, getJob, type Job } from '../../src/jobs/queue.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { createGmailTokenProvider, gmailTokenPaths, isGmailReauthRequired, type GmailToken } from '../../src/mail/gmail/auth.ts';
import { createGmailClient } from '../../src/mail/gmail/client.ts';
import { buildQuery, fetchMailForAccount } from '../../src/mail/gmail/fetch.ts';
import { fromDomainOf } from '../../src/mail/ingest.ts';
import { attentionCount, enqueueFetchMail, getMailStatus } from '../../src/mail/status.ts';
import { TokenStore } from '../../src/providers/freee/auth.ts';
import { createDailyHandler, DAILY_REPORT_KEY } from '../../src/worker/handlers/daily.ts';
import { createFetchMailHandler } from '../../src/worker/handlers/fetchMail.ts';
import { createFakeProvider } from '../../src/providers/fake/index.ts';
import { createGmailMock, pdf, png, token, zip } from './gmail-mock.ts';

const NOW = new Date('2026-11-08T03:00:00.000Z'); // JST 2026-11-08 12:00
// JST 2026-11-05 23:30 = UTC 2026-11-05 14:30。受領日は JST の暦日。
const T_LATE = Date.parse('2026-11-05T14:30:00.000Z');
const T_EARLY = Date.parse('2026-11-04T16:00:00.000Z'); // JST 2026-11-05 01:00
const CONFIG = {
  ingest: { maxBytes: 1024 },
  calendar: { deadlineMode: 'early' as const, yearEndHolidays: false },
  deadline: { countFrom: 'receipt_day' as const },
};
const ACCOUNT: MailAccount = { id: 'personal', label: 'keihi', query: '', since: '2026-10-01' };

let root: string;
let n = 0;
let db: Db;
let dataDir: string;
let objectsDir: string;
let gm: ReturnType<typeof createGmailMock>;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-mail-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeToken(accountId: string, t: GmailToken = token()) {
  const { tokenPath, lockPath } = gmailTokenPaths(dataDir, accountId);
  await new TokenStore<GmailToken>(tokenPath, lockPath).write(t);
}

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
  await writeToken('personal');
  await writeToken('work');
});

const fetchOnce = (opts: { account?: MailAccount; max?: number; now?: Date } = {}) =>
  fetchMailForAccount({
    db, objectsDir, config: CONFIG, now: () => opts.now ?? NOW,
    client: clientFor((opts.account ?? ACCOUNT).id), account: opts.account ?? ACCOUNT, maxMessages: opts.max ?? 100,
  });

const mailDeps = (accounts: MailAccount[] = [ACCOUNT], enabled = true, max = 100) => ({
  mail: { enabled, provider: 'gmail_api' as const, maxMessagesPerRun: max, extractHints: true, accounts },
  config: CONFIG,
  objectsDir,
  client: clientFor,
  log: () => {},
});

async function runHandler(accountId: string, deps = mailDeps()) {
  const id = enqueue(db, 'fetch_mail', accountId, { now: NOW });
  const h = createFetchMailHandler(() => deps);
  await h(getJob(db, id) as Job, { db, now: () => NOW });
}

const rows = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as T[];
const one = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T;
type Msg = { id: string; account_id: string; state: string; error_reason: string | null; attempts: number; received_on: string | null; from_domain: string | null; subject: string | null; raw_sha256: string | null; raw_storage_key: string | null; rfc822_message_id: string | null };
const msgs = () => rows<Msg>('SELECT * FROM mail_messages ORDER BY internal_at, id');
const atts = (mid: string) => rows<{ part_index: number; filename: string; result: string; document_id: string | null; sha256: string | null; bytes: number | null; mime: string | null }>('SELECT * FROM mail_attachments WHERE mail_message_id = ? ORDER BY part_index', mid);

describe('1 通の取り込み', () => {
  test('添付 PDF 2 つ → documents 2 件（e_transaction・imap・Message-ID・JST の受領日）と .eml 1 つ、ジョブが積まれる', async () => {
    gm.add({ id: 'm1', internalMs: T_LATE, attachments: [{ filename: 'invoice.pdf', mime: 'application/pdf', bytes: pdf('a') }, { filename: 'receipt.pdf', mime: 'application/octet-stream', bytes: pdf('b') }] });
    const r = await fetchOnce();
    assert.equal(r.processed, 1);
    assert.equal(r.documents, 2);
    const [m] = msgs();
    assert.equal(m!.state, 'ingested');
    assert.equal(m!.account_id, 'personal');
    assert.equal(m!.received_on, '2026-11-05');
    assert.equal(m!.from_domain, 'example.com');
    assert.equal(m!.rfc822_message_id, '<m1@mail.example.com>');
    const docs = rows<{ id: string; kind: string; source: string; source_ref: string; received_on: string; received_on_source: string; orig_name: string; mime: string; status: string }>(
      'SELECT * FROM documents ORDER BY orig_name',
    );
    assert.equal(docs.length, 2);
    for (const d of docs) {
      assert.equal(d.kind, 'e_transaction');
      assert.equal(d.source, 'imap');
      assert.equal(d.source_ref, '<m1@mail.example.com>');
      assert.equal(d.received_on, '2026-11-05');
      assert.equal(d.received_on_source, 'server');
      assert.equal(d.mime, 'application/pdf');
      assert.equal(d.status, 'received');
    }
    assert.deepEqual(docs.map((d) => d.orig_name), ['invoice.pdf', 'receipt.pdf']);
    const a = atts(m!.id);
    assert.deepEqual(a.map((x) => [x.part_index, x.result]), [[0, 'ingested'], [1, 'ingested']]);
    assert.ok(a.every((x) => docs.some((d) => d.id === x.document_id)));
    // .eml は原本ストアに 0444 で。
    const st = await stat(path.join(objectsDir, m!.raw_storage_key!));
    assert.equal(st.mode & 0o777, 0o444);
    // 証憑ごとに upload_receipt と extract。
    assert.equal(one<{ n: number }>(`SELECT count(*) n FROM jobs WHERE kind IN ('upload_receipt', 'extract')`).n, 4);
    // 監査は mail_message_id と件数だけ（件名・送信元は入れない）。
    const audit = one<{ payload_json: string }>(`SELECT payload_json FROM audit_log WHERE action = 'mail.ingested'`);
    assert.deepEqual(JSON.parse(audit.payload_json), { account_id: 'personal', attachments: 2, documents: 2, duplicates: 0, state: 'ingested' });
    assert.ok(!rows<{ payload_json: string }>('SELECT payload_json FROM audit_log').some((x) => x.payload_json.includes('example.com') || x.payload_json.includes('領収書')));
    assert.equal(verifyAudit(db).ok, true);
  });

  test('受領日は internalDate の JST の暦日（UTC では前日）', async () => {
    gm.add({ id: 'm1', internalMs: T_EARLY, attachments: [{ filename: 'a.pdf', mime: 'application/pdf', bytes: pdf('a') }] });
    await fetchOnce();
    assert.equal(msgs()[0]!.received_on, '2026-11-05');
    assert.equal(one<{ received_on: string }>('SELECT received_on FROM documents').received_on, '2026-11-05');
  });

  test('同じメールを 2 回取っても 1 回だけ取り込む', async () => {
    gm.add({ id: 'm1', internalMs: T_LATE, attachments: [{ filename: 'a.pdf', mime: 'application/pdf', bytes: pdf('a') }] });
    await fetchOnce();
    const r = await fetchOnce();
    assert.equal(r.listed, 1);
    assert.equal(r.processed, 0);
    assert.equal(gm.gets('full').length, 1);
    assert.equal(msgs().length, 1);
    assert.equal(one<{ n: number }>('SELECT count(*) n FROM documents').n, 1);
  });

  test('別のメールで同じ PDF → duplicate（document_id は既存の証憑）。同じメールの中の重複も 1 つ', async () => {
    gm.add({ id: 'm1', internalMs: T_EARLY, attachments: [{ filename: 'a.pdf', mime: 'application/pdf', bytes: pdf('same') }] });
    gm.add({ id: 'm2', internalMs: T_LATE, attachments: [{ filename: 'a-again.pdf', mime: 'application/pdf', bytes: pdf('same') }, { filename: 'b.pdf', mime: 'application/pdf', bytes: pdf('b') }, { filename: 'b2.pdf', mime: 'application/pdf', bytes: pdf('b') }] });
    await fetchOnce();
    const [m1, m2] = msgs();
    const first = atts(m1!.id)[0]!;
    assert.equal(first.result, 'ingested');
    const a2 = atts(m2!.id);
    assert.deepEqual(a2.map((x) => x.result), ['duplicate', 'ingested', 'duplicate']);
    assert.equal(a2[0]!.document_id, first.document_id);
    assert.equal(a2[2]!.document_id, a2[1]!.document_id);
    assert.equal(m2!.state, 'ingested');
    assert.equal(one<{ n: number }>('SELECT count(*) n FROM documents').n, 2);
  });

  test('本文だけ → body_only（documents にしない。.eml は保存）', async () => {
    gm.add({ id: 'm1', internalMs: T_LATE, subject: 'ご注文の確認' });
    await fetchOnce();
    const [m] = msgs();
    assert.equal(m!.state, 'body_only');
    assert.ok(m!.raw_storage_key);
    assert.equal(one<{ n: number }>('SELECT count(*) n FROM documents').n, 0);
    assert.equal(attentionCount(db, 'personal'), 1);
  });

  test('zip だけ → unsupported、上限超え → too_large（宣言の size で取らない・取ったら超えていた）', async () => {
    gm.add({ id: 'm1', internalMs: T_EARLY, attachments: [{ filename: 'docs.zip', mime: 'application/zip', bytes: zip('z') }] });
    gm.add({ id: 'm2', internalMs: T_LATE, attachments: [{ filename: 'big.pdf', mime: 'application/pdf', bytes: pdf('big'), declaredSize: 5000 }] });
    gm.add({ id: 'm3', internalMs: T_LATE + 1000, attachments: [{ filename: 'big2.pdf', mime: 'application/pdf', bytes: new Uint8Array(Buffer.concat([Buffer.from(pdf('x')), Buffer.alloc(2000)])), declaredSize: 10 }] });
    await fetchOnce();
    const [m1, m2, m3] = msgs();
    assert.equal(m1!.state, 'unsupported');
    assert.deepEqual(atts(m1!.id).map((x) => [x.result, x.mime]), [['unsupported', 'application/zip']]);
    assert.equal(m2!.state, 'too_large');
    assert.deepEqual(atts(m2!.id).map((x) => [x.result, x.bytes, x.sha256]), [['too_large', 5000, null]]);
    assert.ok(!gm.calls.some((c) => c.url.includes('att-m2-0')), '宣言で超えていれば取らない');
    assert.equal(m3!.state, 'too_large');
    assert.equal(one<{ n: number }>('SELECT count(*) n FROM documents').n, 0);
    assert.equal(attentionCount(db, 'personal'), 3);
  });

  test('HTML に埋め込まれた画像（inline + Content-ID）は添付にしない。inline の data の PDF は取り込む', async () => {
    gm.add({
      id: 'm1', internalMs: T_LATE,
      attachments: [
        { filename: 'logo.png', mime: 'image/png', bytes: png('logo'), inline: true, cid: 'logo@example.com' },
        { filename: 'small.pdf', mime: 'application/pdf', bytes: pdf('small'), inlineData: true },
      ],
    });
    await fetchOnce();
    const [m] = msgs();
    assert.deepEqual(atts(m!.id).map((x) => [x.part_index, x.filename, x.result]), [[0, 'small.pdf', 'ingested']]);
  });

  test('1 通の取得・解析の失敗は他の通を止めない。3 回で止めて要対応に出す', async () => {
    gm.add({ id: 'bad-fetch', internalMs: T_EARLY, attachments: [{ filename: 'a.pdf', mime: 'application/pdf', bytes: pdf('a') }] });
    gm.add({ id: 'bad-parse', internalMs: T_EARLY + 1000 });
    gm.add({ id: 'ok', internalMs: T_LATE, attachments: [{ filename: 'b.pdf', mime: 'application/pdf', bytes: pdf('b') }] });
    gm.fail('/messages/bad-fetch?format=full', { status: 404 });
    gm.setFull('bad-parse', { id: 'bad-parse', payload: {} }); // internalDate が無い
    const r = await fetchOnce();
    assert.equal(r.processed, 3);
    const by = Object.fromEntries(rows<{ remote_id: string; state: string; error_reason: string | null; attempts: number }>('SELECT remote_id, state, error_reason, attempts FROM mail_messages').map((x) => [x.remote_id, x]));
    assert.deepEqual([by['bad-fetch']!.state, by['bad-fetch']!.error_reason, by['bad-fetch']!.attempts], ['error', 'fetch_failed', 1]);
    assert.deepEqual([by['bad-parse']!.state, by['bad-parse']!.error_reason, by['bad-parse']!.attempts], ['error', 'parse_failed', 1]);
    assert.equal(by.ok!.state, 'ingested');
    assert.equal(attentionCount(db, 'personal'), 0, '3 回までは要対応にしない');
    await fetchOnce();
    await fetchOnce();
    assert.equal(one<{ attempts: number }>(`SELECT attempts FROM mail_messages WHERE remote_id = 'bad-fetch'`).attempts, 3);
    const before = gm.gets('full').length;
    const r4 = await fetchOnce();
    assert.equal(r4.processed, 0, '3 回で止める');
    assert.equal(gm.gets('full').length, before);
    assert.equal(attentionCount(db, 'personal'), 2);
  });

  test('error の通は取り直せる（中身の列が埋まる）', async () => {
    gm.add({ id: 'm1', internalMs: T_LATE, attachments: [{ filename: 'a.pdf', mime: 'application/pdf', bytes: pdf('a') }] });
    gm.fail('/messages/m1/attachments/', { status: 404 }, true);
    await fetchOnce();
    let [m] = msgs();
    assert.deepEqual([m!.state, m!.error_reason, m!.attempts, m!.raw_storage_key], ['error', 'fetch_failed', 1, null]);
    assert.equal(m!.from_domain, 'example.com');
    await fetchOnce();
    [m] = msgs();
    assert.equal(m!.state, 'ingested');
    assert.equal(m!.error_reason, null);
    assert.ok(m!.raw_storage_key);
    assert.equal(atts(m!.id).length, 1);
  });

  test('1 回の上限: 古い順に max 通。残りは次回', async () => {
    for (let i = 0; i < 3; i++) gm.add({ id: `m${i}`, internalMs: T_EARLY + i * 60_000 });
    const r = await fetchOnce({ max: 2 });
    assert.equal(r.processed, 2);
    assert.equal(r.remaining, 1);
    assert.deepEqual(rows<{ remote_id: string }>('SELECT remote_id FROM mail_messages ORDER BY internal_at').map((x) => x.remote_id), ['m0', 'm1']);
    const r2 = await fetchOnce({ max: 2 });
    assert.equal(r2.processed, 1);
    assert.equal(msgs().length, 3);
  });

  test('list のページをたどる', async () => {
    gm.setPageSize(2);
    for (let i = 0; i < 5; i++) gm.add({ id: `m${i}`, internalMs: T_EARLY + i * 60_000 });
    const r = await fetchOnce();
    assert.equal(r.listed, 5);
    assert.equal(msgs().length, 5);
  });

  test('アカウントごとに別に数える（同じ remote_id でも別のアカウントなら別の行）', async () => {
    gm.add({ id: 'm1', internalMs: T_LATE });
    await fetchOnce();
    await fetchOnce({ account: { ...ACCOUNT, id: 'work' } });
    assert.deepEqual(rows<{ account_id: string }>('SELECT account_id FROM mail_messages ORDER BY account_id').map((x) => x.account_id), ['personal', 'work']);
  });
});

describe('検索式', () => {
  test('label と after（since の JST 0 時）、query は括弧で AND', async () => {
    assert.equal(buildQuery({ ...ACCOUNT, query: 'has:attachment OR from:example.net' }, 100), 'label:keihi after:100 (has:attachment OR from:example.net)');
    assert.equal(buildQuery({ ...ACCOUNT, label: 'my label' }, 1), 'label:"my label" after:1');
    await fetchOnce();
    const q = new URL(gm.calls.find((c) => c.url.includes('/messages?'))!.url).searchParams.get('q');
    assert.equal(q, `label:keihi after:${Date.parse('2026-09-30T15:00:00Z') / 1000}`);
  });

  test('取り込んだ最後のメールの 2 日前から。since が無ければ初回実行日の 30 日前', async () => {
    const acct = { ...ACCOUNT, since: null };
    await fetchOnce({ account: acct });
    const first = new URL(gm.calls.at(-1)!.url).searchParams.get('q');
    assert.equal(first, `label:keihi after:${Date.parse('2026-10-08T15:00:00Z') / 1000}`);
    assert.equal(getMailStatus(db, 'personal').first_run_on, '2026-11-08');
    gm.add({ id: 'm1', internalMs: T_LATE });
    await fetchOnce({ account: acct, now: new Date('2026-12-20T00:00:00Z') });
    await fetchOnce({ account: acct, now: new Date('2026-12-21T00:00:00Z') });
    const lists = gm.calls.filter((c) => c.url.includes('/messages?'));
    assert.equal(new URL(lists.at(-1)!.url).searchParams.get('q'), `label:keihi after:${(T_LATE - 2 * 86_400_000) / 1000}`);
  });

  test('From のドメイン', () => {
    assert.equal(fromDomainOf('Billing <billing@Mail.Example.com>'), 'mail.example.com');
    assert.equal(fromDomainOf('noreply@example.net'), 'example.net');
    assert.equal(fromDomainOf('"a@b" <x@example.org>'), 'example.org');
    assert.equal(fromDomainOf('nobody'), null);
    assert.equal(fromDomainOf(null), null);
  });
});

describe('fetch_mail ジョブ', () => {
  test('成功したら mail_status に last_ok_at・last_internal_at を残す', async () => {
    gm.add({ id: 'm1', internalMs: T_LATE });
    await runHandler('personal');
    const s = getMailStatus(db, 'personal');
    assert.equal(s.last_ok_at, NOW.toISOString());
    assert.equal(s.last_run_at, NOW.toISOString());
    assert.equal(s.last_error, null);
    assert.equal(s.last_internal_at, new Date(T_LATE).toISOString());
  });

  test('invalid_grant → gmail_reauth_required_<id> = 1、ジョブは完了、以降 Gmail を呼ばない', async () => {
    await writeToken('personal', token({ created_at: 1 })); // 期限切れ → 更新する
    gm.setToken(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    gm.add({ id: 'm1', internalMs: T_LATE });
    await runHandler('personal');
    assert.equal(isGmailReauthRequired(db, 'personal'), true);
    assert.equal(isGmailReauthRequired(db, 'work'), false);
    assert.equal(getMailStatus(db, 'personal').last_error, 'reauth_required');
    assert.equal(one<{ n: number }>(`SELECT count(*) n FROM audit_log WHERE action = 'mail.reauth_required'`).n, 1);
    // refresh_token は例外にもログにも出ない。
    assert.ok(!JSON.stringify(getMailStatus(db, 'personal')).includes('refresh-SECRET'));
    const before = gm.calls.length;
    await runHandler('personal');
    assert.equal(gm.calls.length, before, '再認可待ちでは呼ばない');
  });

  test('401 が続いたら（強制更新の後も）再認可が要る', async () => {
    gm.fail('/messages?', { status: 401 });
    await runHandler('personal');
    assert.equal(isGmailReauthRequired(db, 'personal'), true);
    assert.equal(gm.calls.filter((c) => c.url.includes('oauth2')).length, 1, '1 回だけ強制更新する');
  });

  test('トークンが無ければ再認可が要る', async () => {
    await rm(gmailTokenPaths(dataDir, 'personal').tokenPath);
    await runHandler('personal');
    assert.equal(isGmailReauthRequired(db, 'personal'), true);
  });

  test('500・429・ネットワークの失敗はジョブの再試行（取れた通は残る）', async () => {
    gm.add({ id: 'm1', internalMs: T_EARLY });
    gm.add({ id: 'm2', internalMs: T_LATE });
    gm.fail('/messages/m2?format=full', { status: 500 }, true);
    const id = enqueue(db, 'fetch_mail', 'personal', { now: NOW });
    const handlers = { fetch_mail: createFetchMailHandler(() => mailDeps()), upload_receipt: async () => {}, extract: async () => {} };
    const s = await runUntilEmpty(db, handlers, { now: () => NOW });
    assert.equal(s.failed, 1);
    const j = getJob(db, id)!;
    assert.equal(j.state, 'queued');
    assert.equal(j.attempts, 1);
    assert.match(j.last_error!, /HTTP 500/);
    assert.equal(msgs().length, 1, 'm1 は取り込み済み');
    assert.match(getMailStatus(db, 'personal').last_error!, /HTTP 500/);
    assert.equal(isGmailReauthRequired(db, 'personal'), false);
    // 429 とネットワークも同じ。
    for (const res of [{ status: 429 }, 'network' as const]) {
      gm.fail('/messages?', res, true);
      await assert.rejects(runHandler('personal'));
    }
    await runHandler('personal');
    assert.equal(msgs().length, 2);
  });

  test('[mail] enabled = false・設定に無いアカウントは何もしない', async () => {
    gm.add({ id: 'm1', internalMs: T_LATE });
    await runHandler('personal', mailDeps([ACCOUNT], false));
    await runHandler('gone');
    assert.equal(gm.calls.length, 0);
  });
});

describe('daily の段 mail', () => {
  const run = (mailAccounts: string[] | null, now = NOW) =>
    runUntilEmpty(
      db,
      { daily: createDailyHandler(() => ({ provider: () => createFakeProvider(), refreshToken: null, mailAccounts })), reconcile_deals: async () => {}, sync_bank: async () => {} },
      { now: () => now },
    );
  const setting = (k: string) => JSON.parse(one<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', k).value_json);

  test('アカウントごとに fetch_mail を 1 件積む。未完了があれば積まない', async () => {
    enqueue(db, 'daily', null, { now: NOW });
    await run(['personal', 'work']);
    const jobs = rows<{ ref_id: string; state: string }>(`SELECT ref_id, state FROM jobs WHERE kind = 'fetch_mail' ORDER BY id`);
    assert.deepEqual(jobs.map((j) => [j.ref_id, j.state]), [['personal', 'queued'], ['work', 'queued']]);
    assert.deepEqual(setting(DAILY_REPORT_KEY).mail.map((m: { account_id: string; created: boolean }) => [m.account_id, m.created]), [['personal', true], ['work', true]]);
    const next = new Date(NOW.getTime() + 86_400_000);
    enqueue(db, 'daily', null, { now: next });
    await run(['personal', 'work'], next);
    assert.equal(rows(`SELECT id FROM jobs WHERE kind = 'fetch_mail'`).length, 2);
    assert.deepEqual(setting(DAILY_REPORT_KEY).mail.map((m: { created: boolean }) => m.created), [false, false]);
  });

  test('enabled = false なら積まない', async () => {
    enqueue(db, 'daily', null, { now: NOW });
    await run(null);
    assert.equal(rows(`SELECT id FROM jobs WHERE kind = 'fetch_mail'`).length, 0);
    assert.equal(setting(DAILY_REPORT_KEY).mail, 'disabled');
  });

  test('enqueueFetchMail の間隔（10 分以内は積まない）', () => {
    const a = enqueueFetchMail(db, 'personal', NOW, { minIntervalMs: 600_000 });
    db.prepare(`UPDATE jobs SET state = 'done' WHERE id = ?`).run(a.job_id);
    assert.deepEqual(enqueueFetchMail(db, 'personal', new Date(NOW.getTime() + 60_000), { minIntervalMs: 600_000 }), { job_id: a.job_id, created: false });
    assert.equal(enqueueFetchMail(db, 'work', NOW, { minIntervalMs: 600_000 }).created, true);
    assert.equal(enqueueFetchMail(db, 'personal', new Date(NOW.getTime() + 600_000), { minIntervalMs: 600_000 }).created, true);
  });
});

describe('0010_mail.sql のトリガ', () => {
  test('mail_attachments は追記専用、mail_messages は削除できず中身の列は変えられない', async () => {
    gm.add({ id: 'm1', internalMs: T_LATE, attachments: [{ filename: 'a.pdf', mime: 'application/pdf', bytes: pdf('a') }] });
    await fetchOnce();
    const [m] = msgs();
    assert.throws(() => db.prepare(`UPDATE mail_attachments SET result = 'duplicate'`).run(), /追記専用/);
    assert.throws(() => db.prepare('DELETE FROM mail_attachments').run(), /追記専用/);
    assert.throws(() => db.prepare('DELETE FROM mail_messages').run(), /削除できない/);
    assert.throws(() => db.prepare(`UPDATE mail_messages SET subject = 'x' WHERE id = ?`).run(m!.id), /不変の列/);
    assert.throws(() => db.prepare(`UPDATE mail_messages SET raw_sha256 = ? WHERE id = ?`).run('0'.repeat(64), m!.id), /不変の列/);
    assert.throws(() => db.prepare(`UPDATE mail_messages SET account_id = 'work' WHERE id = ?`).run(m!.id), /不変の列/);
    db.prepare(`UPDATE mail_messages SET hint_amount = 1234, hint_extracted_at = ?, updated_at = ? WHERE id = ?`).run(NOW.toISOString(), NOW.toISOString(), m!.id);
    assert.throws(
      () => db.prepare(`INSERT INTO mail_messages (id, account_id, provider, remote_id, state, created_at, updated_at) VALUES ('x', 'personal', 'gmail_api', 'm1', 'body_only', '', '')`).run(),
      /UNIQUE/,
    );
  });
});
