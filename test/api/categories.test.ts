// カテゴリの台帳（bank_categories。0014。docs/cashflow.md §5、src/bank/categories.ts）。app.request() で叩く（ポートを開かない）。
// 摘要・金額・ラベルはすべて架空の値。
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { MAX_ACTIVE } from '../../src/bank/categories.ts';
import { insertAccount, insertBankTxn, updateAccountSettings } from '../../src/bank/repo.ts';
import { CATEGORIES, CATEGORY_LABELS, setTxnTag } from '../../src/bank/tags.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { normalizeVendor } from '../../src/vendors/normalize.ts';
import { createApp } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';

const LOCAL = '127.0.0.1:8798';
const USER = 'test@example.com';
const T0 = new Date('2026-11-09T03:00:00.000Z');
const NOW = T0.toISOString();

let db: Db;
let app: Hono;
let acc: string;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  app = createApp({
    db,
    objectsDir: '/nonexistent',
    config: {
      ingest: { maxBytes: 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
      retention: { years: 7, extraYears: 1, start: 'next_year_0316' },
      provider: { kind: 'fake' },
      bank: { backfillFrom: '2025-01-01', dedupDateWindowDays: 0, transferWindowDays: 3, matchDateWindowDays: 3, matchCardDateWindowDays: 10 },
      cashflow: { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false },
    },
    auth: createAuth({ allowedUsers: [USER], allowedHosts: [LOCAL] }),
    triggerWorker: () => {},
    now: () => T0,
  });
  acc = insertAccount(db, { provider: 'fake', name: '銀行A', kind: 'bank', source: 'csv', now: NOW }).id;
  updateAccountSettings(db, acc, { defaultTag: 'business' }, NOW);
});

type Item = { id: string; label: string; color: number; sort_order: number; builtin: boolean; archived: boolean };

async function send<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await app.request(`http://${LOCAL}${p}`, {
    method,
    headers: { Host: LOCAL, 'Tailscale-User-Login': USER, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as T };
}
const list = async (all = false) => (await send<{ items: Item[] }>('GET', `/api/categories${all ? '?all=1' : ''}`)).body.items;
const create = async (label: string, color = 3) => send<{ item: Item; error?: string }>('POST', '/api/categories', { label, color });
const txn = (txnDate: string, amount: number, description = 'ｶﾌｪ ﾃｽﾄ') =>
  insertBankTxn(db, { accountId: acc, txnDate, amount, side: 'expense', description, descriptionNorm: normalizeVendor(description), now: NOW }).id;
const audits = (action?: string) =>
  (db.prepare('SELECT action, entity, entity_id, payload_json FROM audit_log ORDER BY seq').all() as { action: string; entity: string; entity_id: string; payload_json: string }[]).filter(
    (a) => action === undefined || a.action === action,
  );

describe('GET /api/categories（移行直後）', () => {
  test('13 種の id・label・順が移行前（tags.ts の CATEGORIES）と同じ。builtin・未アーカイブ・色は分析の画面の割り当て', async () => {
    const items = await list();
    assert.deepEqual(
      items.map((c) => [c.id, c.label]),
      CATEGORIES.map((id) => [id, CATEGORY_LABELS[id]]),
    );
    assert.deepEqual(
      items.map((c) => c.color),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0],
    );
    assert.deepEqual(
      items.map((c) => c.sort_order),
      CATEGORIES.map((_, i) => (i + 1) * 10),
    );
    assert.ok(items.every((c) => c.builtin && !c.archived));
    assert.equal((await send('GET', '/api/categories?all=2')).status, 400);
  });
});

describe('作成・変更', () => {
  test('作ると 201。id は c_ + ULID、最後に並ぶ。監査 bank_category.created', async () => {
    const r = await create('  ペット  ', 5);
    assert.equal(r.status, 201);
    const it = r.body.item;
    assert.match(it.id, /^c_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual({ ...it, id: '' }, { id: '', label: 'ペット', color: 5, sort_order: 140, builtin: false, archived: false });
    assert.equal((await list()).at(-1)!.id, it.id);
    const a = audits('bank_category.created');
    assert.equal(a.length, 1);
    assert.deepEqual([a[0]!.entity, a[0]!.entity_id], ['bank_category', it.id]);
    assert.deepEqual(JSON.parse(a[0]!.payload_json), { label: 'ペット', color: 5, sort_order: 140, user: USER });
    assert.ok(verifyAudit(db).ok);
  });

  test('ラベルの重複・長さ・色・知らないキーは 400。何も書かない', async () => {
    for (const [body, error] of [
      [{ label: '食費', color: 1 }, 'duplicate_label'],
      [{ label: ' ', color: 1 }, 'invalid_label'],
      [{ label: 'あ'.repeat(21), color: 1 }, 'invalid_label'],
      [{ label: 'ペット', color: 12 }, 'invalid_color'],
      [{ label: 'ペット', color: 1.5 }, 'invalid_color'],
      [{ label: 'ペット', color: 1, parent: 'x' }, 'invalid_field'],
    ] as const) {
      const r = await send('POST', '/api/categories', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error);
    }
    assert.equal((await create('あ'.repeat(20))).status, 201);
    assert.equal(audits().length, 1);
  });

  test('builtin の改名・色・並べ替えができる。監査の payload.changes に変わった列の from/to', async () => {
    const r = await send<{ item: Item }>('PATCH', '/api/categories/food', { label: '食料品', color: 9, sort_order: 25 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.item, { id: 'food', label: '食料品', color: 9, sort_order: 25, builtin: true, archived: false });
    assert.deepEqual(
      (await list()).slice(0, 3).map((c) => c.id),
      ['daily', 'food', 'transport'],
    );
    const a = audits('bank_category.updated');
    assert.equal(a.length, 1);
    assert.deepEqual(JSON.parse(a[0]!.payload_json), {
      changes: { label: { from: '食費', to: '食料品' }, color: { from: 0, to: 9 }, sort_order: { from: 10, to: 25 } },
      user: USER,
    });
    // 同じ値は書かない（監査も無し）
    assert.equal((await send('PATCH', '/api/categories/food', { color: 9 })).status, 200);
    assert.equal(audits('bank_category.updated').length, 1);
  });

  test('PATCH の 400（知らないキー・空・重複・型）と 404', async () => {
    for (const [body, error] of [
      [{ id: 'x' }, 'invalid_field'],
      [{ builtin: false }, 'invalid_field'],
      [{}, 'nothing_to_update'],
      [{ label: '日用品' }, 'duplicate_label'],
      [{ color: -1 }, 'invalid_color'],
      [{ sort_order: '1' }, 'invalid_sort_order'],
    ] as const) {
      const r = await send('PATCH', '/api/categories/food', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error);
    }
    assert.equal((await send('PATCH', '/api/categories/nope', { label: 'x' })).status, 404);
    assert.equal(audits().length, 0);
  });

  test('アーカイブしていないものは 40 件まで（41 件目は 409）。unarchive で 41 件目になるのも 409', async () => {
    const first = (await create('予備0')).body.item;
    for (let i = 1; i < MAX_ACTIVE - 13; i++) assert.equal((await create(`予備${i}`)).status, 201);
    assert.equal((await list()).length, MAX_ACTIVE);
    const over = await create('はみ出し');
    assert.equal(over.status, 409);
    assert.equal(over.body.error, 'too_many_categories');
    // 1 件アーカイブすれば作れる。作った後に戻すと 41 件目なので 409
    assert.equal((await send('POST', `/api/categories/${first.id}/archive`)).status, 200);
    assert.equal((await create('はみ出し')).status, 201);
    const back = await send('POST', `/api/categories/${first.id}/unarchive`);
    assert.equal(back.status, 409);
    assert.equal(back.body.error, 'too_many_categories');
    assert.equal((await list(true)).length, MAX_ACTIVE + 1);
  });
});

describe('アーカイブ', () => {
  test('other は 400 cannot_archive。他の builtin はアーカイブでき、2 回目は 200 のまま監査を書かない。戻せる', async () => {
    const o = await send('POST', '/api/categories/other/archive');
    assert.equal(o.status, 400);
    assert.equal(o.body.error, 'cannot_archive');
    const a1 = await send<{ item: Item }>('POST', '/api/categories/car/archive');
    assert.equal(a1.status, 200);
    assert.equal(a1.body.item.archived, true);
    assert.equal((await send('POST', '/api/categories/car/archive')).status, 200);
    assert.equal(audits('bank_category.archived').length, 1);
    assert.ok(!(await list()).some((c) => c.id === 'car'));
    assert.ok((await list(true)).find((c) => c.id === 'car')!.archived);
    const u = await send<{ item: Item }>('POST', '/api/categories/car/unarchive');
    assert.equal(u.status, 200);
    assert.equal(u.body.item.archived, false);
    assert.equal(audits('bank_category.unarchived').length, 1);
    assert.equal((await send('POST', '/api/categories/nope/archive')).status, 404);
    assert.equal((await send('POST', '/api/categories/nope/unarchive')).status, 404);
    assert.deepEqual(
      audits().map((a) => [a.action, a.entity, a.entity_id]),
      [
        ['bank_category.archived', 'bank_category', 'car'],
        ['bank_category.unarchived', 'bank_category', 'car'],
      ],
    );
  });

  test('アーカイブ済みは 1 件の上書き・一括・ルールの作成で 400 category_archived。既存の集計・一覧には残る', async () => {
    const t1 = txn('2026-11-02', 1000);
    const t2 = txn('2026-11-03', 2000, 'ﾍﾟｯﾄｼｮｯﾌﾟ');
    const pet = (await create('ペット')).body.item;
    assert.equal((await send('POST', `/api/bank_txns/${t1}/tag`, { tag: 'private', category: pet.id })).status, 200);
    assert.equal((await send('POST', `/api/categories/${pet.id}/archive`)).status, 200);
    const before = audits().length;
    for (const [method, p, body] of [
      ['POST', `/api/bank_txns/${t2}/tag`, { tag: 'private', category: pet.id }],
      ['POST', '/api/bank_txns/bulk_tag', { ids: [t2], category: pet.id }],
      ['POST', '/api/tag_rules', { pattern: 'ﾍﾟｯﾄｼｮｯﾌﾟ', match: 'exact', tag: 'private', category: pet.id }],
    ] as const) {
      const r = await send(method, p, body);
      assert.equal(r.status, 400, p);
      assert.equal(r.body.error, 'category_archived', p);
    }
    // 台帳に無い id は従来どおり invalid_category
    assert.equal((await send('POST', `/api/bank_txns/${t2}/tag`, { tag: 'private', category: 'c_nope' })).body.error, 'invalid_category');
    assert.equal(audits().length, before);
    // 集計・一覧の絞り込み・ラベル（?all=1）には残る
    const m = (await send<{ by_category: { category: string | null; expense: number }[] }>('GET', '/api/summary/monthly?month=2026-11')).body;
    assert.deepEqual(m.by_category.map((r) => [r.category, r.expense]), [
      [pet.id, 1000],
      [null, 2000],
    ]);
    const l = (await send<{ items: { id: string }[] }>('GET', `/api/bank_txns?category=${pet.id}`)).body;
    assert.deepEqual(l.items.map((t) => t.id), [t1]);
    assert.equal((await list(true)).find((c) => c.id === pet.id)!.label, 'ペット');
  });
});

describe('アーカイブ済みが今の効く値のとき', () => {
  test('1 件の上書き: 同じアーカイブ済み（今の値）ならタグだけ変えられる。別のアーカイブ済みは 400', async () => {
    const t1 = txn('2026-11-02', 1000);
    assert.equal((await send('POST', `/api/bank_txns/${t1}/tag`, { tag: 'business', category: 'food' })).status, 200);
    assert.equal((await send('POST', '/api/categories/food/archive')).status, 200);
    assert.equal((await send('POST', '/api/categories/car/archive')).status, 200);
    const r = await send<{ tag: string; category: string | null }>('POST', `/api/bank_txns/${t1}/tag`, { tag: 'private', category: 'food' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.tag, r.body.category], ['private', 'food']);
    const bad = await send('POST', `/api/bank_txns/${t1}/tag`, { tag: 'private', category: 'car' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'category_archived');
    // 無い明細は（アーカイブ済みでも）404
    assert.equal((await send('POST', '/api/bank_txns/nope/tag', { tag: 'private', category: 'food' })).status, 404);
  });

  test('bulk_tag: tag だけ（category は引き継ぎ）は 200。全部の今の値と同じアーカイブ済みは 200、1 件でも違えば 400 で何も書かない', async () => {
    const a = txn('2026-11-02', 1000);
    const b = txn('2026-11-03', 2000, 'ｽｰﾊﾟｰ');
    const c = txn('2026-11-04', 3000, 'ﾅﾆｶ');
    for (const id of [a, b]) assert.equal((await send('POST', `/api/bank_txns/${id}/tag`, { tag: 'business', category: 'food' })).status, 200);
    assert.equal((await send('POST', '/api/categories/food/archive')).status, 200);
    type B = { changed: number; effective: { tag: string; category: string | null }[]; error?: string };
    const r1 = await send<B>('POST', '/api/bank_txns/bulk_tag', { ids: [a, b], tag: 'private' });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.effective.map((e) => [e.tag, e.category]), [
      ['private', 'food'],
      ['private', 'food'],
    ]);
    const r2 = await send<B>('POST', '/api/bank_txns/bulk_tag', { ids: [a, b], category: 'food' });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.changed, 0);
    const before = audits().length;
    const r3 = await send<B>('POST', '/api/bank_txns/bulk_tag', { ids: [a, c], category: 'food' });
    assert.equal(r3.status, 400);
    assert.equal(r3.body.error, 'category_archived');
    assert.equal(audits().length, before);
  });

  test('学習: アーカイブ済みのカテゴリのルールは新しく作らない', async () => {
    const pet = (await create('ペット')).body.item;
    const ids = [txn('2026-11-02', 1000, 'ﾍﾟｯﾄｼｮｯﾌﾟ'), txn('2026-11-03', 1100, 'ﾍﾟｯﾄｼｮｯﾌﾟ'), txn('2026-11-04', 1200, 'ﾍﾟｯﾄｼｮｯﾌﾟ')];
    // 3 件目は別のタグにしておき、アーカイブ後にタグだけ揃える（3 件が同じ上書きになる）
    for (const [i, tag] of [[0, 'private'], [1, 'private'], [2, 'business']] as const) {
      assert.equal((await send('POST', `/api/bank_txns/${ids[i]}/tag`, { tag, category: pet.id })).status, 200);
    }
    assert.equal((await send('POST', `/api/categories/${pet.id}/archive`)).status, 200);
    const r = await send<{ learned_rule: unknown }>('POST', `/api/bank_txns/${ids[2]}/tag`, { tag: 'private', category: pet.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.learned_rule, null);
    assert.equal(audits('tag_rule.learned').length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tag_rules').get() as { n: number }).n, 0);
    // 戻せば同じ操作で学習する（判定そのものは変えていない）
    assert.equal((await send('POST', `/api/categories/${pet.id}/unarchive`)).status, 200);
    const r2 = await send<{ learned_rule: { action: string } | null }>('POST', `/api/bank_txns/${ids[2]}/tag`, { tag: 'private', category: pet.id });
    assert.equal(r2.body.learned_rule?.action, 'created');
  });
});

describe('ユーザー定義のカテゴリが集計・一覧・経費に出る', () => {
  test('by_category・by_tag_category は台帳の順（ユーザー定義は builtin の後、未分類は最後）。一覧の category=<id>・経費の vendors[].category', async () => {
    const pet = (await create('ペット')).body.item;
    const a = txn('2026-11-02', 1000, 'ﾍﾟｯﾄｼｮｯﾌﾟ');
    const b = txn('2026-11-03', 3000, 'ｽｰﾊﾟｰ');
    txn('2026-11-04', 500, 'ﾅﾆｶ');
    setTxnTag(db, { txnId: a, tag: 'business', category: pet.id, actor: 'user', source: 'human', now: T0 });
    setTxnTag(db, { txnId: b, tag: 'business', category: 'food', actor: 'user', source: 'human', now: T0 });
    type M = { by_category: { category: string | null; expense: number }[]; by_tag_category: { tag: string; category: string | null; expense: number }[] };
    const m = (await send<M>('GET', '/api/summary/monthly?month=2026-11')).body;
    assert.deepEqual(m.by_category.map((r) => [r.category, r.expense]), [
      ['food', 3000],
      [pet.id, 1000],
      [null, 500],
    ]);
    assert.deepEqual(m.by_tag_category.map((r) => [r.tag, r.category, r.expense]), [
      ['business', 'food', 3000],
      ['business', pet.id, 1000],
      ['business', null, 500],
    ]);
    // 並べ替えると集計の並びも変わる
    assert.equal((await send('PATCH', `/api/categories/${pet.id}`, { sort_order: 5 })).status, 200);
    const m2 = (await send<M>('GET', '/api/summary/monthly?month=2026-11')).body;
    assert.deepEqual(m2.by_category.map((r) => r.category), [pet.id, 'food', null]);
    const l = (await send<{ items: { id: string; category: string | null }[] }>('GET', `/api/bank_txns?category=${pet.id}`)).body;
    assert.deepEqual(l.items.map((t) => [t.id, t.category]), [[a, pet.id]]);
    assert.equal((await send('GET', '/api/bank_txns?category=c_nope')).status, 400);
    const e = (await send<{ vendors: { vendor_key: string | null; category: string | null }[] }>('GET', '/api/expenses?month=2026-11')).body;
    assert.equal(e.vendors.find((v) => v.vendor_key === normalizeVendor('ﾍﾟｯﾄｼｮｯﾌﾟ'))!.category, pet.id);
  });

  test('一括（bulk_tag）でユーザー定義のカテゴリを付けられる', async () => {
    const pet = (await create('ペット')).body.item;
    const a = txn('2026-11-02', 1000);
    const r = await send<{ changed: number; effective: { category: string | null }[] }>('POST', '/api/bank_txns/bulk_tag', { ids: [a], category: pet.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, 1);
    assert.equal(r.body.effective[0]!.category, pet.id);
  });
});
