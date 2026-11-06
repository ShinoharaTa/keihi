// 明細のタグとタグのルールの API（docs/mvp-plan-v3.md T108）。Hono の app.request() で叩く（ポートを開かない）。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { insertAccount, insertBankTxn } from '../../src/bank/repo.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { tagRoutes } from '../../src/web/routes/tags.ts';

const T0 = new Date('2026-11-06T03:00:00.000Z');
const now = T0.toISOString();
let root: string;
let n = 0;
let db: Db;
let app: Hono;
let acc: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-tags-api-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  app = new Hono().route('/api', tagRoutes({ db, now: () => T0 }));
  acc = insertAccount(db, { provider: 'fake', name: 'A', kind: 'card', source: 'csv', now }).id;
});

const txn = (norm = 'amazon') =>
  insertBankTxn(db, { accountId: acc, txnDate: '2026-11-01', amount: 1200, side: 'expense', description: norm, descriptionNorm: norm, now }).id;

const send = (method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json', 'Tailscale-User-Login': 'me@example.com' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const audits = () => db.prepare('SELECT actor, action, entity_id, payload_json FROM audit_log ORDER BY seq').all() as { actor: string; action: string; entity_id: string; payload_json: string }[];

describe('POST /api/bank_txns/:id/tag', () => {
  test('上書きして 200。actor=user で監査に残る', async () => {
    const id = txn();
    const res = await send('POST', `/api/bank_txns/${id}/tag`, { tag: 'business', category: 'telecom' });
    assert.equal(res.status, 200);
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.version, 1);
    assert.equal(j.tag, 'business');
    assert.equal(j.category, 'telecom');
    assert.equal(j.learned_rule, null);
    assert.deepEqual(j.effective, { tag: 'business', category: 'telecom', source: 'override' });
    const a = audits();
    assert.equal(a.length, 1);
    assert.deepEqual([a[0].actor, a[0].action, a[0].entity_id], ['user', 'bank_txn.tag_set', id]);
    assert.equal(JSON.parse(a[0].payload_json).user, 'me@example.com');
    const row = db.prepare('SELECT source, actor FROM txn_tags WHERE bank_txn_id = ?').get(id) as { source: string; actor: string };
    assert.deepEqual({ ...row }, { source: 'human', actor: 'user' });
    assert.ok(verifyAudit(db).ok);
  });

  test('category を省くと未分類（null）', async () => {
    const res = await send('POST', `/api/bank_txns/${txn()}/tag`, { tag: 'private' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { category: unknown }).category, null);
  });

  test('不正なカテゴリ・タグ・JSON は 400、無い明細は 404。何も書かない', async () => {
    const id = txn();
    for (const [body, error] of [
      [{ tag: 'business', category: 'groceries' }, 'invalid_category'],
      [{ tag: 'business', category: 3 }, 'invalid_category'],
      [{ tag: 'mixed' }, 'invalid_tag'],
      [{}, 'invalid_tag'],
      ['{bad', 'invalid_json'],
      ['[]', 'invalid_json'],
    ] as const) {
      const res = await send('POST', `/api/bank_txns/${id}/tag`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error });
    }
    const res = await send('POST', '/api/bank_txns/NOPE/tag', { tag: 'business' });
    assert.equal(res.status, 404);
    assert.equal(audits().length, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM txn_tags').get() as { n: number }).n, 0);
  });

  test('3 回目でルールが 1 件だけでき、4 回目では増えない', async () => {
    const results: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await send('POST', `/api/bank_txns/${txn()}/tag`, { tag: 'private', category: 'leisure' });
      results.push(((await res.json()) as { learned_rule: unknown }).learned_rule);
    }
    assert.equal(results[0], null);
    assert.equal(results[1], null);
    assert.equal((results[2] as { created: boolean }).created, true);
    assert.equal((results[3] as { created: boolean }).created, false);
    const rules = (await (await send('GET', '/api/tag_rules')).json()) as { items: { origin: string; hit_count: number }[] };
    assert.equal(rules.items.length, 1);
    assert.equal(rules.items[0].origin, 'learned');
    assert.equal(rules.items[0].hit_count, 1);
  });
});

describe('/api/tag_rules', () => {
  test('作る（201）・一覧・消す。監査に残る', async () => {
    const res = await send('POST', '/api/tag_rules', { account_id: acc, pattern: 'Ａｍａｚｏｎ', match: 'prefix', tag: 'business', category: 'daily' });
    assert.equal(res.status, 201);
    const rule = (await res.json()) as { id: string; pattern: string; origin: string; account_id: string };
    assert.equal(rule.pattern, 'amazon');
    assert.equal(rule.origin, 'manual');
    assert.equal(rule.account_id, acc);

    const list = (await (await send('GET', '/api/tag_rules')).json()) as { items: { id: string }[] };
    assert.deepEqual(list.items.map((r) => r.id), [rule.id]);

    const del = await send('DELETE', `/api/tag_rules/${rule.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { id: rule.id, deleted: true });
    assert.equal((await send('DELETE', `/api/tag_rules/${rule.id}`)).status, 404);

    assert.deepEqual(
      audits().map((a) => [a.actor, a.action]),
      [['user', 'tag_rule.created'], ['user', 'tag_rule.deleted']],
    );
    assert.equal(JSON.parse(audits()[1].payload_json).user, 'me@example.com');
  });

  test('不正な入力は 400', async () => {
    for (const [body, error] of [
      [{ pattern: 'x', match: 'exact', tag: 'business', category: 'nope' }, 'invalid_category'],
      [{ pattern: 'x', match: 'regex', tag: 'business' }, 'invalid_match'],
      [{ pattern: '', match: 'exact', tag: 'business' }, 'invalid_pattern'],
      [{ pattern: 1, match: 'exact', tag: 'business' }, 'invalid_pattern'],
      [{ pattern: 'x', match: 'exact', tag: 'nope' }, 'invalid_tag'],
      [{ account_id: 1, pattern: 'x', match: 'exact', tag: 'business' }, 'invalid_account_id'],
      [{ account_id: 'NOPE', pattern: 'x', match: 'exact', tag: 'business' }, 'unknown_account'],
    ] as const) {
      const res = await send('POST', '/api/tag_rules', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error });
    }
    assert.equal(audits().length, 0);
  });
});

test('GET /api/categories は 12 種と日本語のラベル', async () => {
  const res = await send('GET', '/api/categories');
  assert.equal(res.status, 200);
  const j = (await res.json()) as { items: { id: string; label: string }[]; uncategorized_label: string };
  assert.equal(j.items.length, 12);
  assert.deepEqual(j.items[0], { id: 'food', label: '食費' });
  assert.equal(j.uncategorized_label, '未分類');
});
