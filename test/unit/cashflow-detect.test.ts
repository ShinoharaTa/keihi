// 周期の検出（docs/mvp-plan-v3.md T302、src/cashflow/detect.ts）と候補の API。一時ディレクトリの DB だけを使う。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { insertAccount, insertBankTxn, type TxnSide } from '../../src/bank/repo.ts';
import { detectTransfers } from '../../src/bank/transfers.ts';
import { addMonths } from '../../src/calendar/businessDays.ts';
import { acceptCandidate, detectRecurrences, dismissCandidate, findRecurrences, nextDueFromCandidate } from '../../src/cashflow/detect.ts';
import { listRecurrenceCandidates, listScheduledItems } from '../../src/cashflow/repo.ts';
import { createItem } from '../../src/cashflow/schedule.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createAuth } from '../../src/web/auth.ts';
import { cashflowRoutes } from '../../src/web/routes/cashflow.ts';

// 2026-11-06 09:00 JST
const T0 = new Date('2026-11-06T00:00:00.000Z');
const TODAY = '2026-11-06';
const now = T0.toISOString();
const by = { actor: 'user', user: 'me@example.com' };
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-detect-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function fresh(): { db: Db; A: string; B: string } {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  const A = insertAccount(db, { provider: 'fake', name: '銀行A', kind: 'bank', source: 'csv', now }).id;
  const B = insertAccount(db, { provider: 'fake', name: '銀行B', kind: 'bank', source: 'csv', now }).id;
  return { db, A, B };
}

function txn(db: Db, accountId: string, date: string, amount: number, desc: string, side: TxnSide = 'expense'): string {
  return insertBankTxn(db, { accountId, txnDate: date, amount, side, description: desc, descriptionNorm: desc, now }).id;
}

const day = (ym: string, d: number) => `${ym}-${String(d).padStart(2, '0')}`;
// 2024-11 〜 2026-10 の 24 か月。
const MONTHS = Array.from({ length: 24 }, (_, i) => addMonths('2024-11-01', i).slice(0, 7));

// 合成した 24 か月の明細。毎月 2 本・隔月 1 本・毎年 1 本と、ノイズ。
function seed(db: Db, A: string, B: string): void {
  MONTHS.forEach((ym, i) => {
    txn(db, A, day(ym, 27), 80000, '家賃');
    txn(db, A, day(ym, 10), i % 2 === 0 ? 3000 : 3120, '携帯'); // 4% の揺れ
    if (Number(ym.slice(5, 7)) % 2 === 1) txn(db, A, day(ym, 15), 6000, '水道');
    // 振替（B に同額の入金）: 毎月でも検出の対象から外れる。
    txn(db, A, day(ym, 25), 50000, '振込 銀行B');
    txn(db, B, day(ym, 25), 50000, '振込 銀行A', 'income');
  });
  txn(db, A, '2025-05-20', 39500, '自動車税');
  txn(db, A, '2026-05-22', 39500, '自動車税');
  // ノイズ: 1 回だけ。
  txn(db, A, '2026-03-03', 50000, '家電');
  // ノイズ: 1 年おきだが金額が 20% 違う。
  txn(db, A, '2025-07-01', 20000, '保険');
  txn(db, A, '2026-07-01', 24000, '保険');
  // ノイズ: 毎月だが真ん中だけ 20% 違う（同じ金額の 2 本は間隔 60 日で、隔月には 2 回しかない）。
  txn(db, A, '2026-01-05', 10000, '電気');
  txn(db, A, '2026-02-04', 12000, '電気');
  txn(db, A, '2026-03-06', 10000, '電気');
  // 入金は対象外。
  for (const ym of MONTHS) txn(db, A, day(ym, 20), 300000, '給与', 'income');
  assert.equal(detectTransfers(db, { windowDays: 3, now: T0 }).length, 24);
}

const summary = (db: Db) =>
  listRecurrenceCandidates(db)
    .map((c) => `${c.description_norm}:${c.interval}:${c.amount}`)
    .sort();

describe('detectRecurrences', () => {
  test('24 か月の明細から、毎月 2・隔月 1・毎年 1 だけを候補にする', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 4, updated: 0 });
    assert.deepEqual(summary(db), ['家賃:monthly:80000', '携帯:monthly:3120', '水道:bimonthly:6000', '自動車税:yearly:39500'].sort());
    for (const c of listRecurrenceCandidates(db)) {
      assert.equal(c.state, 'open');
      assert.equal(c.account_id, A);
      assert.equal(c.scheduled_item_id, null);
    }
    const rent = listRecurrenceCandidates(db).find((c) => c.description_norm === '家賃')!;
    const occ = JSON.parse(rent.occurrences_json) as { date: string; amount: number; bank_txn_id: string }[];
    assert.equal(occ.length, 24);
    assert.deepEqual(Object.keys(occ[0]).sort(), ['amount', 'bank_txn_id', 'date']);
    assert.equal(occ[0].date, '2024-11-27');
    assert.equal(occ[23].date, '2026-10-27');
    db.close();
  });

  test('2 回目の検出では増えない', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    detectRecurrences(db, { today: TODAY, now: T0 });
    assert.deepEqual(detectRecurrences(db, { today: TODAY, now: T0 }), { created: 0, updated: 0 });
    assert.equal(listRecurrenceCandidates(db).length, 4);
    db.close();
  });

  test('見る範囲は today から lookbackMonths か月前まで', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    // 6 か月なら毎年の 2 回は入らない。隔月は 3 回（5・7・9 月）入る。
    const found = findRecurrences(db, { today: TODAY, lookbackMonths: 6 })
      .map((d) => `${d.descriptionNorm}:${d.interval}`)
      .sort();
    assert.deepEqual(found, ['家賃:monthly', '携帯:monthly', '水道:bimonthly'].sort());
    db.close();
  });

  test('間隔の境界: 毎月 28 日・31 日は当たり、27 日・32 日は外れる', () => {
    const { db, A } = fresh();
    for (const d of ['2026-01-01', '2026-01-29', '2026-03-01']) txn(db, A, d, 1000, '境界28'); // 28・31
    for (const d of ['2026-01-01', '2026-01-28', '2026-02-24']) txn(db, A, d, 1000, '境界27'); // 27・27
    for (const d of ['2026-01-01', '2026-02-02', '2026-03-06']) txn(db, A, d, 1000, '境界32'); // 32・32
    assert.deepEqual(findRecurrences(db, { today: TODAY }).map((d) => d.descriptionNorm), ['境界28']);
    db.close();
  });

  test('隔年は 715〜745 日で 2 回', () => {
    const { db, A } = fresh();
    txn(db, A, '2024-10-01', 12000, '免許更新');
    txn(db, A, '2026-10-01', 12500, '免許更新');
    assert.deepEqual(
      findRecurrences(db, { today: TODAY }).map((d) => `${d.interval}:${d.amount}`),
      ['biennial:12500'],
    );
    db.close();
  });

  test('同じ口座・同じ名前の active な予定項目があれば作らない（止めた項目なら作る）', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    const it = createItem(
      db,
      { name: '家賃', amount: 80000, direction: 'out', category: 'other', accountId: A, recurrence: 'monthly', anchorDate: '2026-11-27', endDate: null, notifyDaysBefore: 14, origin: 'manual' },
      by,
      T0,
    );
    // 別の口座の同名は関係ない。
    createItem(
      db,
      { name: '携帯', amount: 3000, direction: 'out', category: 'other', accountId: B, recurrence: 'monthly', anchorDate: '2026-11-10', endDate: null, notifyDaysBefore: 14, origin: 'manual' },
      by,
      T0,
    );
    detectRecurrences(db, { today: TODAY, now: T0 });
    assert.deepEqual(summary(db), ['携帯:monthly:3120', '水道:bimonthly:6000', '自動車税:yearly:39500'].sort());
    db.prepare('UPDATE scheduled_items SET active = 0 WHERE id = ?').run(it.id);
    assert.equal(detectRecurrences(db, { today: TODAY, now: T0 }).created, 1);
    db.close();
  });
});

describe('acceptCandidate / dismissCandidate', () => {
  test('受け入れると台帳に入り、次の期日は最後の出現日 + 周期。監査に残る', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    detectRecurrences(db, { today: TODAY, now: T0 });
    const byName = (s: string) => listRecurrenceCandidates(db).find((c) => c.description_norm === s)!;
    const expect: Record<string, string> = { 家賃: '2026-11-27', 携帯: '2026-11-10', 水道: '2026-11-15', 自動車税: '2027-05-22' };
    for (const [name, due] of Object.entries(expect)) assert.equal(nextDueFromCandidate(byName(name)), due, name);

    const { candidate, item } = acceptCandidate(db, byName('自動車税').id, by, { category: 'tax' }, T0);
    assert.equal(candidate.state, 'accepted');
    assert.equal(candidate.scheduled_item_id, item.id);
    assert.equal(item.name, '自動車税');
    assert.equal(item.amount, 39500);
    assert.equal(item.direction, 'out');
    assert.equal(item.category, 'tax');
    assert.equal(item.account_id, A);
    assert.equal(item.recurrence, 'yearly');
    assert.equal(item.anchor_date, '2027-05-22');
    assert.equal(item.origin, 'detected');
    assert.equal(item.active, 1);

    const r2 = acceptCandidate(db, byName('家賃').id, by, { name: '  事務所家賃 ' }, T0);
    assert.equal(r2.item.name, '事務所家賃');
    assert.equal(r2.item.category, 'other');
    assert.equal(r2.item.anchor_date, '2026-11-27');

    const actions = (db.prepare('SELECT action FROM audit_log ORDER BY seq').all() as { action: string }[]).map((r) => r.action);
    assert.deepEqual(actions, ['scheduled_item.created', 'recurrence_candidate.accepted', 'scheduled_item.created', 'recurrence_candidate.accepted']);
    assert.equal(verifyAudit(db).ok, true);

    // 受け入れたものは再検出で作らない（名前を変えても、候補が accepted のまま残る）。
    assert.equal(detectRecurrences(db, { today: TODAY, now: T0 }).created, 0);
    // 2 回は受け入れられない。却下もできない。
    assert.throws(() => acceptCandidate(db, byName('家賃').id, by, {}, T0), /not_open/);
    assert.throws(() => dismissCandidate(db, byName('家賃').id, by, T0), /not_open/);
    assert.equal(listScheduledItems(db).length, 2);
    db.close();
  });

  test('値が不正なら台帳も候補も変わらない', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    detectRecurrences(db, { today: TODAY, now: T0 });
    const c = listRecurrenceCandidates(db)[0];
    assert.throws(() => acceptCandidate(db, c.id, by, { category: 'income' }, T0), /invalid_category_for_direction/);
    assert.throws(() => acceptCandidate(db, c.id, by, { name: ' ' }, T0), /invalid_name/);
    assert.throws(() => acceptCandidate(db, 'nope', by, {}, T0), /not_found/);
    assert.equal(listScheduledItems(db).length, 0);
    assert.equal(listRecurrenceCandidates(db, { state: 'open' }).length, 4);
    db.close();
  });

  test('却下したものは次回作らない。却下は監査に残り、2 回目はそのまま', () => {
    const { db, A, B } = fresh();
    seed(db, A, B);
    detectRecurrences(db, { today: TODAY, now: T0 });
    const c = listRecurrenceCandidates(db).find((x) => x.description_norm === '水道')!;
    const d = dismissCandidate(db, c.id, by, T0);
    assert.equal(d.state, 'dismissed');
    assert.equal(d.scheduled_item_id, null);
    assert.deepEqual(dismissCandidate(db, c.id, by, T0), d);
    assert.equal((db.prepare("SELECT count(*) n FROM audit_log WHERE action = 'recurrence_candidate.dismissed'").get() as { n: number }).n, 1);
    // 明細が増えても同じ条件では出さない。
    txn(db, A, '2026-11-05', 6000, '水道');
    assert.equal(detectRecurrences(db, { today: TODAY, now: T0 }).created, 0);
    assert.equal(listRecurrenceCandidates(db).length, 4);
    db.close();
  });
});

describe('/api/recurrence_candidates', () => {
  const HOST = '127.0.0.1:8787';
  const USER = 'me@example.com';
  let db: Db;
  let app: Hono;
  beforeEach(() => {
    db?.close();
    const f = fresh();
    db = f.db;
    seed(db, f.A, f.B);
    app = new Hono();
    app.use('*', createAuth({ allowedUsers: [USER], allowedHosts: [HOST] }));
    app.route('/api', cashflowRoutes({ db, now: () => T0 }));
  });
  const headers = { Host: HOST, 'Tailscale-User-Login': USER, 'content-type': 'application/json' };
  const get = (url: string) => app.request(url, { headers });
  const post = (url: string, body?: unknown) =>
    app.request(url, { method: 'POST', headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

  test('detect → 一覧 → accept / dismiss', async () => {
    let res = await post('/api/recurrence_candidates/detect');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { created: 4, updated: 0 });
    res = await post('/api/recurrence_candidates/detect');
    assert.deepEqual(await res.json(), { created: 0, updated: 0 });

    res = await get('/api/recurrence_candidates?state=open');
    assert.equal(res.status, 200);
    const { candidates } = (await res.json()) as { candidates: { id: string; description_norm: string }[] };
    assert.equal(candidates.length, 4);
    const id = (s: string) => candidates.find((c) => c.description_norm === s)!.id;

    res = await post(`/api/recurrence_candidates/${id('自動車税')}/accept`, { category: 'car' });
    assert.equal(res.status, 200);
    const acc = (await res.json()) as { candidate: { state: string }; item: { category: string; anchor_date: string; origin: string } };
    assert.equal(acc.candidate.state, 'accepted');
    assert.deepEqual([acc.item.category, acc.item.anchor_date, acc.item.origin], ['car', '2027-05-22', 'detected']);
    const actor = db.prepare("SELECT payload_json FROM audit_log WHERE action = 'recurrence_candidate.accepted'").get() as { payload_json: string };
    assert.equal(JSON.parse(actor.payload_json).user, USER);

    res = await post(`/api/recurrence_candidates/${id('水道')}/dismiss`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { state: string }).state, 'dismissed');

    res = await get('/api/recurrence_candidates?state=open');
    assert.equal(((await res.json()) as { candidates: unknown[] }).candidates.length, 2);
    res = await get('/api/recurrence_candidates');
    assert.equal(((await res.json()) as { candidates: unknown[] }).candidates.length, 4);

    // 受け入れ済みは 400。
    res = await post(`/api/recurrence_candidates/${id('自動車税')}/accept`, {});
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'not_open' });
  });

  test('不正な入力は 400 / 404', async () => {
    await post('/api/recurrence_candidates/detect');
    const { candidates } = (await (await get('/api/recurrence_candidates')).json()) as { candidates: { id: string }[] };
    const cid = candidates[0].id;
    const cases: [string, unknown, number, string][] = [
      [`/api/recurrence_candidates/${cid}/accept`, '{', 400, 'invalid_json'],
      [`/api/recurrence_candidates/${cid}/accept`, { amount: 1 }, 400, 'invalid_field'],
      [`/api/recurrence_candidates/${cid}/accept`, { category: 'food' }, 400, 'invalid_category'],
      [`/api/recurrence_candidates/${cid}/accept`, { name: 1 }, 400, 'invalid_name'],
      ['/api/recurrence_candidates/nope/accept', {}, 404, 'not_found'],
      ['/api/recurrence_candidates/nope/dismiss', undefined, 404, 'not_found'],
    ];
    for (const [url, body, status, error] of cases) {
      const res = await post(url, body);
      assert.equal(res.status, status, `${url} ${JSON.stringify(body)}`);
      assert.deepEqual(await res.json(), { error });
    }
    const res = await get('/api/recurrence_candidates?state=closed');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_state' });
    assert.equal(listScheduledItems(db).length, 0);
  });
});
