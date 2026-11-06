// 期日の通知（docs/mvp-plan-v3.md T305）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createItem, deactivateItem, type ItemInput } from '../../src/cashflow/schedule.ts';
import { dueSoonCount, upcomingItems } from '../../src/cashflow/upcoming.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';

const T0 = new Date('2026-11-06T00:00:00.000Z');
const by = { actor: 'user', user: 'me@example.com' };
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-upcoming-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function freshDb(): Db {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  return db;
}

const base: ItemInput = {
  name: '自動車税',
  amount: 39500,
  direction: 'out',
  category: 'car',
  accountId: null,
  recurrence: 'once',
  anchorDate: '2026-12-01',
  endDate: null,
  notifyDaysBefore: 14,
  origin: 'manual',
};

describe('dueSoonCount', () => {
  test('境界: N 日前ちょうど・期日の当日は数え、N 日前の前日・期日の翌日は数えない', () => {
    const db = freshDb();
    try {
      createItem(db, base, by, T0);
      assert.equal(dueSoonCount(db, '2026-11-16'), 0); // 15 日前
      assert.equal(dueSoonCount(db, '2026-11-17'), 1); // 14 日前ちょうど
      assert.equal(dueSoonCount(db, '2026-12-01'), 1); // 期日の当日
      assert.equal(dueSoonCount(db, '2026-12-02'), 0); // 期日の翌日（once なので次の期日は無い）
    } finally {
      db.close();
    }
  });

  test('項目ごとの notify_days_before を使う（0 なら当日だけ）', () => {
    const db = freshDb();
    try {
      createItem(db, { ...base, notifyDaysBefore: 3 }, by, T0);
      createItem(db, { ...base, name: '当日だけ', notifyDaysBefore: 0 }, by, T0);
      assert.equal(dueSoonCount(db, '2026-11-27'), 0);
      assert.equal(dueSoonCount(db, '2026-11-28'), 1);
      assert.equal(dueSoonCount(db, '2026-11-30'), 1);
      assert.equal(dueSoonCount(db, '2026-12-01'), 2);
      assert.equal(dueSoonCount(db, '2026-12-02'), 0);
    } finally {
      db.close();
    }
  });

  test('周期の項目は期日の翌日から次の期日で数える。止めた項目と end_date の後は数えない', () => {
    const db = freshDb();
    try {
      createItem(db, { ...base, recurrence: 'monthly', notifyDaysBefore: 5 }, by, T0);
      assert.equal(dueSoonCount(db, '2026-12-01'), 1);
      assert.equal(dueSoonCount(db, '2026-12-02'), 0); // 次は 2027-01-01
      assert.equal(dueSoonCount(db, '2026-12-27'), 1); // 2027-01-01 の 5 日前
      // end_date が 2026-12-31 なので 2027-01-01 の回は無い。
      createItem(db, { ...base, name: '終わり', recurrence: 'monthly', notifyDaysBefore: 5, endDate: '2026-12-31' }, by, T0);
      assert.equal(dueSoonCount(db, '2026-12-27'), 1);
      const stopped = createItem(db, { ...base, name: '止める', notifyDaysBefore: 30 }, by, T0);
      assert.equal(dueSoonCount(db, '2026-11-20'), 1); // 30 日前から数える「止める」だけ（毎月の 2 つは 5 日前の 11-26 から）
      deactivateItem(db, stopped.id, by, T0);
      assert.equal(dueSoonCount(db, '2026-11-20'), 0);
    } finally {
      db.close();
    }
  });
});

describe('upcomingItems', () => {
  test('既定は今日〜30 日後（両端を含む）', () => {
    const db = freshDb();
    try {
      createItem(db, { ...base, recurrence: 'monthly', anchorDate: '2026-11-06' }, by, T0);
      const r = upcomingItems(db, { today: '2026-11-06' });
      assert.deepEqual([r.from, r.to], ['2026-11-06', '2026-12-06']);
      assert.deepEqual(r.items.map((i) => i.due_date), ['2026-11-06', '2026-12-06']);
      assert.deepEqual(upcomingItems(db, { today: '2026-11-06', days: 7 }).items.map((i) => i.due_date), ['2026-11-06']);
    } finally {
      db.close();
    }
  });
});
