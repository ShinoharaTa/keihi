// freee の API 予算（docs/mvp-plan.md T1-15、docs/mcp.md §5.3）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createFakeProvider } from '../../src/providers/fake/index.ts';
import {
  BudgetExceededError,
  PAUSE_MS,
  budgetDay,
  createBudget,
  decide,
  nextReset,
  withBudget,
  type DenyReason,
  type Purpose,
  type Used,
} from '../../src/providers/freee/budget.ts';
import { getPausedUntil } from '../../src/providers/freee/state.ts';
import { ProviderError } from '../../src/providers/types.ts';

let root: string;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-budget-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
function newDb(): Db {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  return db;
}

const used = (u: Partial<Used> = {}): Used => ({ upload: 0, sync: 0, execute: 0, auth: 0, user: 0, ...u });

describe('decide（表駆動）', () => {
  const cases: [string, Purpose, Partial<Used>, true | DenyReason][] = [
    ['空なら sync も通る', 'sync', {}, true],
    ['sync は 300 回まで', 'sync', { sync: 299 }, true],
    ['sync の 301 回目は延期', 'sync', { sync: 300 }, 'purpose_limit'],
    ['execute は 600 回まで', 'execute', { execute: 600 }, 'purpose_limit'],
    ['auth は 50 回まで', 'auth', { auth: 50 }, 'purpose_limit'],
    ['user は用途の上限なし', 'user', { user: 1500 }, true],
    // 合計 2,400（upload 0）: 残り 600 = upload の予約枠ちょうど → upload 以外は通らない
    ['予約枠に食い込む user は通らない', 'user', { user: 2400 }, 'upload_reserve'],
    ['予約枠の直前の user は通る', 'user', { user: 2399 }, true],
    ['他の用途が枯れても upload は通る', 'upload', { user: 2400 }, true],
    ['upload を使った分だけ予約枠が減る（合計 2,400・予約の残り 500）', 'user', { user: 2300, upload: 100 }, true],
    // 残りが 500 未満: sync は止める（予約枠を使い切った後でも）
    ['残り 499 で sync は止める', 'sync', { upload: 600, user: 1901 }, 'sync_stopped'],
    ['残り 500 なら sync は通る', 'sync', { upload: 600, user: 1900 }, true],
    // 残りが 200 未満: upload と auth だけ
    ['残り 199 で execute は止める', 'execute', { upload: 800, user: 2001 }, 'legal_only'],
    ['残り 199 で user は止める', 'user', { upload: 800, user: 2001 }, 'legal_only'],
    ['残り 199 でも upload は通る', 'upload', { upload: 800, user: 2001 }, true],
    ['残り 199 でも auth は通る', 'auth', { upload: 800, user: 2001 }, true],
    ['予約枠が残っていても auth は通る', 'auth', { user: 2400 }, true],
    ['3,000 回で upload も止める', 'upload', { upload: 3000 }, 'daily_limit'],
    ['3,000 回で auth も止める', 'auth', { upload: 2990, auth: 10 }, 'daily_limit'],
  ];
  for (const [name, purpose, u, want] of cases) {
    test(name, () => {
      const d = decide(purpose, used(u));
      assert.deepEqual(d, want === true ? { ok: true } : { ok: false, reason: want });
    });
  }
});

describe('日の区切り', () => {
  test('JST の暦日。resetHourJst で区切りをずらせる', () => {
    assert.equal(budgetDay(new Date('2026-10-16T14:59:59Z')), '2026-10-16');
    assert.equal(budgetDay(new Date('2026-10-16T15:00:00Z')), '2026-10-17');
    assert.equal(nextReset(new Date('2026-10-16T15:00:00Z')).toISOString(), '2026-10-17T15:00:00.000Z');
    assert.equal(budgetDay(new Date('2026-10-16T17:59:59Z'), 3), '2026-10-16');
    assert.equal(budgetDay(new Date('2026-10-16T18:00:00Z'), 3), '2026-10-17');
    assert.equal(nextReset(new Date('2026-10-16T17:00:00Z'), 3).toISOString(), '2026-10-16T18:00:00.000Z');
  });
});

describe('createBudget', () => {
  test('呼び出しを freee_calls に記録し、上限を超えた sync は呼ばずに延期（次の日の区切り以降）', () => {
    const db = newDb();
    const t = new Date('2026-10-17T01:00:00Z');
    const b = createBudget({ db, now: () => t, limits: { daily: 10, uploadReserve: 4, perPurpose: { upload: null, sync: 2, execute: 6, auth: 1, user: null }, stopSyncBelow: 0, legalOnlyBelow: 0 } });
    for (let i = 0; i < 2; i++) b.finish(b.begin('sync', 'GET', '/api/1/deals'), 200, `rq${i}`);
    assert.throws(
      () => b.begin('sync', 'GET', '/api/1/deals'),
      (e: unknown) => e instanceof BudgetExceededError && e.reason === 'purpose_limit' && e.retryAt.toISOString() === '2026-10-17T15:00:00.000Z',
    );
    // user は upload の予約枠（4）を残して 4 回まで（合計 10 - 予約 4 = 6、sync で 2 使用済み）
    for (let i = 0; i < 4; i++) b.begin('user', 'GET', '/x');
    assert.throws(() => b.begin('user', 'GET', '/x'), (e: unknown) => e instanceof BudgetExceededError && e.reason === 'upload_reserve');
    // upload は予約枠の範囲で通る
    for (let i = 0; i < 4; i++) b.begin('upload', 'POST', '/api/1/receipts');
    assert.throws(() => b.begin('upload', 'POST', '/api/1/receipts'), (e: unknown) => e instanceof BudgetExceededError && e.reason === 'daily_limit');
    const rows = db.prepare('SELECT called_on, purpose, status, request_id FROM freee_calls ORDER BY id LIMIT 1').get() as Record<string, unknown>;
    assert.deepEqual({ ...rows }, { called_on: '2026-10-17', purpose: 'sync', status: 200, request_id: 'rq0' });
    assert.deepEqual(b.usage().used, { upload: 4, sync: 2, execute: 0, auth: 0, user: 4 });
    assert.equal(b.usage().remaining, 0);
    db.close();
  });

  test('日が変われば数え直す', () => {
    const db = newDb();
    let t = new Date('2026-10-17T14:59:00Z');
    const b = createBudget({ db, now: () => t });
    for (let i = 0; i < 300; i++) b.begin('sync', 'GET', '/api/1/wallet_txns');
    assert.throws(() => b.begin('sync', 'GET', '/api/1/wallet_txns'), BudgetExceededError);
    t = new Date('2026-10-17T15:00:00Z');
    assert.doesNotThrow(() => b.begin('sync', 'GET', '/api/1/wallet_txns'));
    db.close();
  });

  test('403 で freee_paused_until を 10 分後にし、その間は upload も含め全用途を止める', () => {
    const db = newDb();
    let t = new Date('2026-10-17T01:00:00Z');
    const b = createBudget({ db, now: () => t });
    b.finish(b.begin('sync', 'GET', '/api/1/deals'), 403, null);
    assert.equal(getPausedUntil(db)!.toISOString(), new Date(t.getTime() + PAUSE_MS).toISOString());
    t = new Date(t.getTime() + PAUSE_MS - 1);
    for (const p of ['upload', 'sync', 'execute', 'auth', 'user'] as Purpose[]) {
      assert.throws(() => b.begin(p, 'GET', '/x'), (e: unknown) => e instanceof ProviderError && e.kind === 'usage_limited');
    }
    assert.ok(b.usage().pausedUntil);
    t = new Date(t.getTime() + 1);
    assert.doesNotThrow(() => b.begin('upload', 'POST', '/api/1/receipts'));
    assert.equal(b.usage().pausedUntil, null);
    // 拒否した呼び出しは数えない（403 の 1 回 + 最後の 1 回）
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM freee_calls').get() as { c: number }).c, 2);
    db.close();
  });
});

describe('withBudget（fake）', () => {
  test('403 の後 10 分は fake への呼び出しが 0 回', async () => {
    const db = newDb();
    let t = new Date('2026-10-17T01:00:00Z');
    const fake = createFakeProvider();
    const p = withBudget(fake, createBudget({ db, now: () => t }));
    fake.failNext('usage_limited');
    await assert.rejects(p.syncMasters(), (e: unknown) => e instanceof ProviderError && e.kind === 'usage_limited');
    assert.equal(fake.calls.length, 1);
    t = new Date(t.getTime() + 5 * 60_000);
    await assert.rejects(p.uploadReceipt({ bytes: Buffer.from('x'), fileName: 'a.jpg', mime: 'image/jpeg', key: 'k' }), (e: unknown) => e instanceof ProviderError && e.kind === 'usage_limited');
    await assert.rejects(p.listDeals(), (e: unknown) => e instanceof ProviderError && e.kind === 'usage_limited');
    assert.equal(fake.calls.length, 1);
    t = new Date(t.getTime() + 5 * 60_000);
    await p.uploadReceipt({ bytes: Buffer.from('x'), fileName: 'a.jpg', mime: 'image/jpeg', key: 'k' });
    assert.equal(fake.calls.length, 2);
    const rows = db.prepare('SELECT purpose, endpoint, status FROM freee_calls ORDER BY id').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { purpose: 'sync', endpoint: 'syncMasters', status: 403 },
      { purpose: 'upload', endpoint: 'uploadReceipt', status: 200 },
    ]);
    // 包んでも fake のテスト用の口（calls・failNext）はそのまま使える
    assert.equal(p.calls, fake.calls);
    db.close();
  });
});
