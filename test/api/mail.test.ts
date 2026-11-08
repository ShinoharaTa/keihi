// メールの取り込みの API（docs/cashflow.md §17）。app.request() で叩く（ポートを開かない）。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono, MiddlewareHandler } from 'hono';
import type { Config, MailAccount } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ulid } from '../../src/db/ids.ts';
import { migrate } from '../../src/db/migrate.ts';
import { setGmailReauthRequired } from '../../src/mail/gmail/auth.ts';
import { updateMailStatus } from '../../src/mail/status.ts';
import { createApp } from '../../src/web/app.ts';

const NOW = new Date('2026-11-08T03:00:00.000Z');
const allow: MiddlewareHandler = async (_c, next) => next();
const ACCOUNTS: MailAccount[] = [
  { id: 'personal', label: 'keihi', query: '', since: null },
  { id: 'work', label: 'keihi', query: 'has:attachment', since: '2026-10-01' },
];

let root: string;
let n = 0;
let db: Db;
let app: Hono;
let triggered: number;
let clock: Date;

function make(mail?: Config['mail']) {
  db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  triggered = 0;
  clock = NOW;
  app = createApp({
    db,
    objectsDir: path.join(root, 'objects'),
    config: {
      ingest: { maxBytes: 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
      retention: { years: 7, extraYears: 1, start: 'next_year_0316' },
      cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false },
      ...(mail ? { mail } : {}),
    },
    auth: allow,
    triggerWorker: () => triggered++,
    now: () => clock,
  });
}
const enabled = (accounts = ACCOUNTS): Config['mail'] => ({ enabled: true, provider: 'gmail_api', maxMessagesPerRun: 100, extractHints: true, accounts });

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-mail-api-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => make(enabled()));

async function call(p: string, init?: RequestInit) {
  const res = await app.request(p, init);
  return { status: res.status, json: (await res.json()) as any };
}

// テスト用に mail_messages を直接入れる。
function addMessage(o: { account: string; remote: string; at: string; state: string; attempts?: number; error?: string | null; hint?: boolean }) {
  const id = ulid(Date.parse(o.at));
  db.prepare(
    `INSERT INTO mail_messages (id, account_id, provider, remote_id, from_domain, subject, internal_at, received_on, state, error_reason, attempts,
       hint_amount, hint_extracted_at, created_at, updated_at)
     VALUES (?, ?, 'gmail_api', ?, 'example.com', '件名', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, o.account, o.remote, o.at, o.at.slice(0, 10), o.state, o.error ?? null, o.attempts ?? 0, o.hint ? 1234 : null, o.hint ? o.at : null, o.at, o.at);
  return id;
}

describe('POST /api/mail/sync', () => {
  test('無効なら 409 mail_disabled（[mail] が無いときも）', async () => {
    make({ ...enabled(), enabled: false });
    assert.deepEqual(await call('/api/mail/sync', { method: 'POST' }), { status: 409, json: { reason: 'mail_disabled' } });
    make();
    assert.equal((await call('/api/mail/sync', { method: 'POST' })).status, 409);
    assert.equal(triggered, 0);
  });

  test('アカウントごとに積み、未完了・10 分以内は積まない', async () => {
    const r1 = await call('/api/mail/sync', { method: 'POST' });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json.accounts.map((a: any) => [a.account_id, a.created]), [['personal', true], ['work', true]]);
    assert.equal(triggered, 1);
    const jobs = db.prepare(`SELECT ref_id FROM jobs WHERE kind = 'fetch_mail' ORDER BY id`).all() as { ref_id: string }[];
    assert.deepEqual(jobs.map((j) => j.ref_id), ['personal', 'work']);
    const r2 = await call('/api/mail/sync', { method: 'POST' });
    assert.deepEqual(r2.json.accounts.map((a: any) => a.created), [false, false]);
    assert.equal(triggered, 1);
    db.prepare(`UPDATE jobs SET state = 'done'`).run();
    clock = new Date(NOW.getTime() + 5 * 60_000);
    assert.deepEqual((await call('/api/mail/sync', { method: 'POST' })).json.accounts.map((a: any) => a.created), [false, false]);
    clock = new Date(NOW.getTime() + 10 * 60_000);
    assert.deepEqual((await call('/api/mail/sync', { method: 'POST' })).json.accounts.map((a: any) => a.created), [true, true]);
  });
});

describe('GET /api/mail/status と /api/status の mail', () => {
  test('アカウントごとの配列', async () => {
    updateMailStatus(db, 'personal', { last_run_at: NOW.toISOString(), last_ok_at: NOW.toISOString() }, NOW);
    updateMailStatus(db, 'work', { last_run_at: NOW.toISOString(), last_error: 'reauth_required' }, NOW);
    setGmailReauthRequired(db, 'work', true, NOW);
    addMessage({ account: 'work', remote: 'a', at: '2026-11-01T00:00:00.000Z', state: 'unsupported' });
    const r = await call('/api/mail/status');
    assert.deepEqual(r.json, {
      enabled: true,
      provider: 'gmail_api',
      accounts: [
        { id: 'personal', label: 'keihi', last_run_at: NOW.toISOString(), last_ok_at: NOW.toISOString(), last_error: null, reauth_required: false, attention_count: 0 },
        { id: 'work', label: 'keihi', last_run_at: NOW.toISOString(), last_ok_at: null, last_error: 'reauth_required', reauth_required: true, attention_count: 1 },
      ],
    });
    const s = await call('/api/status');
    assert.deepEqual(s.json.mail, {
      enabled: true,
      accounts: [
        { id: 'personal', last_ok_at: NOW.toISOString(), last_error: null, reauth_required: false, attention_count: 0 },
        { id: 'work', last_ok_at: null, last_error: 'reauth_required', reauth_required: true, attention_count: 1 },
      ],
    });
  });
});

describe('GET /api/mail/messages', () => {
  test('新しい順・添付つき・アカウントと状態で絞る・要対応・cursor', async () => {
    const m1 = addMessage({ account: 'personal', remote: 'a', at: '2026-11-01T00:00:00.000Z', state: 'ingested' });
    addMessage({ account: 'personal', remote: 'b', at: '2026-11-02T00:00:00.000Z', state: 'body_only' });
    addMessage({ account: 'personal', remote: 'c', at: '2026-11-03T00:00:00.000Z', state: 'body_only', hint: true });
    addMessage({ account: 'work', remote: 'd', at: '2026-11-04T00:00:00.000Z', state: 'error', attempts: 3, error: 'fetch_failed' });
    addMessage({ account: 'work', remote: 'e', at: '2026-11-05T00:00:00.000Z', state: 'error', attempts: 1, error: 'parse_failed' });
    db.prepare(
      `INSERT INTO mail_attachments (id, mail_message_id, part_index, filename, mime, bytes, sha256, document_id, result, created_at) VALUES (?, ?, 0, 'a.zip', 'application/zip', 10, NULL, NULL, 'unsupported', ?)`,
    ).run(ulid(), m1, NOW.toISOString());

    const all = await call('/api/mail/messages');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.items.map((i: any) => i.account_id + ':' + i.state), ['work:error', 'work:error', 'personal:body_only', 'personal:body_only', 'personal:ingested']);
    const last = all.json.items.at(-1);
    assert.deepEqual(last.attachments, [{ filename: 'a.zip', result: 'unsupported', document_id: null }]);
    assert.equal(last.received_on, '2026-11-01');
    assert.equal(last.from_domain, 'example.com');
    assert.equal(last.hint, null);
    assert.deepEqual(all.json.items[2].hint, { txn_date: null, amount: 1234, vendor: null, order_ref: null });
    assert.equal(all.json.next_cursor, null);

    assert.equal((await call('/api/mail/messages?account_id=work')).json.items.length, 2);
    assert.equal((await call('/api/mail/messages?state=body_only')).json.items.length, 2);
    // 要対応: attempts ≥ 3 の error と、手がかりの無い body_only。
    assert.deepEqual((await call('/api/mail/messages?state=attention')).json.items.map((i: any) => i.state), ['error', 'body_only']);

    const p1 = await call('/api/mail/messages?limit=2');
    assert.equal(p1.json.items.length, 2);
    const p2 = await call(`/api/mail/messages?limit=2&cursor=${p1.json.next_cursor}`);
    const p3 = await call(`/api/mail/messages?limit=2&cursor=${p2.json.next_cursor}`);
    assert.equal(p3.json.next_cursor, null);
    assert.deepEqual([...p1.json.items, ...p2.json.items, ...p3.json.items].map((i: any) => i.id), all.json.items.map((i: any) => i.id));
  });

  test('不正な引数は 400', async () => {
    for (const [q, reason] of [
      ['state=nope', 'invalid_state'],
      ['account_id=unknown', 'invalid_account_id'],
      ['limit=0', 'invalid_limit'],
      ['limit=101', 'invalid_limit'],
      ['limit=x', 'invalid_limit'],
      ['cursor=!!', 'invalid_cursor'],
    ]) {
      assert.deepEqual(await call(`/api/mail/messages?${q}`), { status: 400, json: { reason } }, q);
    }
  });
});
