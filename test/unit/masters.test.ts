// T2-1 マスタ同期（docs/mvp-plan.md）。fake の Provider で同期し、再同期で差分だけ追記されることを確かめる。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createFakeProvider, DEFAULT_MASTERS } from '../../src/providers/fake/index.ts';
import type { Masters } from '../../src/providers/types.ts';
import { canonicalJson, currentMasters, listWalletables, setWalletableAlias, syncMasters } from '../../src/masters/sync.ts';
import { enabledAccounts, loadAccountMap, parseAccountMap, DEFAULT_ACCOUNT_MAP_PATH } from '../../src/masters/accounts.ts';

const P = 'freee';

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

let clock = Date.parse('2026-10-17T00:00:00Z');
const now = () => new Date((clock += 1000));

async function sync(db: Db, masters: Masters & { partners?: { id: number; name: string }[] }) {
  return syncMasters(db, createFakeProvider({ masters: masters as Masters }), { providerName: P, now });
}

const count = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM provider_master_versions').get() as { n: number }).n;

describe('syncMasters', () => {
  test('初回は全件を追記する', async () => {
    const db = freshDb();
    const r = await sync(db, DEFAULT_MASTERS);
    assert.deepEqual(r.account, { added: 4, changed: 0, retired: 0, unchanged: 0 });
    assert.deepEqual(r.tax, { added: 3, changed: 0, retired: 0, unchanged: 0 });
    assert.deepEqual(r.walletable, { added: 1, changed: 0, retired: 0, unchanged: 0 });
    assert.equal(r.partner, undefined); // Masters に partners が無いときは同期しない
    assert.equal(count(db), 8);
    assert.deepEqual(currentMasters(db, P, 'account').map((m) => [m.remoteId, m.name]), [
      ['101', '消耗品費'],
      ['102', '旅費交通費'],
      ['103', '通信費'],
      ['104', '事業主貸'],
    ]);
    assert.deepEqual(currentMasters(db, P, 'walletable').map((m) => m.remoteId), ['credit_card:1']);
  });

  test('同じ内容で再同期すると何も追記しない', async () => {
    const db = freshDb();
    await sync(db, DEFAULT_MASTERS);
    const r = await sync(db, DEFAULT_MASTERS);
    assert.deepEqual(r.account, { added: 0, changed: 0, retired: 0, unchanged: 4 });
    assert.equal(count(db), 8);
  });

  test('名前の変更は新しい版、消えたものは廃止の版、増えたものは追加として追記する', async () => {
    const db = freshDb();
    await sync(db, DEFAULT_MASTERS);
    const next: Masters = structuredClone(DEFAULT_MASTERS);
    next.accountItems = [
      { id: 101, name: '消耗品' }, // 名前の変更
      { id: 102, name: '旅費交通費' },
      { id: 104, name: '事業主貸' },
      { id: 105, name: '会議費' }, // 追加（103 通信費は消えた）
    ];
    const r = await sync(db, next);
    assert.deepEqual(r.account, { added: 1, changed: 1, retired: 1, unchanged: 2 });
    assert.equal(count(db), 11);
    assert.deepEqual(currentMasters(db, P, 'account').map((m) => [m.remoteId, m.name]), [
      ['101', '消耗品'],
      ['102', '旅費交通費'],
      ['104', '事業主貸'],
      ['105', '会議費'],
    ]);
    const hist = db.prepare("SELECT name, retired_at FROM provider_master_versions WHERE kind = 'account' AND remote_id = '103' ORDER BY id").all() as {
      name: string;
      retired_at: string | null;
    }[];
    assert.equal(hist.length, 2);
    assert.equal(hist[0].retired_at, null);
    assert.ok(hist[1].retired_at);

    // 廃止したものが再び現れたら、retired_at が NULL の版を追記する
    const back = await sync(db, DEFAULT_MASTERS);
    assert.deepEqual(back.account, { added: 1, changed: 1, retired: 1, unchanged: 2 });
    assert.ok(currentMasters(db, P, 'account').some((m) => m.remoteId === '103'));
    assert.ok(!currentMasters(db, P, 'account').some((m) => m.remoteId === '105'));
  });

  test('partners が返ってきたら同期する', async () => {
    const db = freshDb();
    const r = await sync(db, { ...DEFAULT_MASTERS, partners: [{ id: 7, name: 'テスト商店' }] });
    assert.deepEqual(r.partner, { added: 1, changed: 0, retired: 0, unchanged: 0 });
    // partners の無い同期では既存の partner を廃止しない
    await sync(db, DEFAULT_MASTERS);
    assert.deepEqual(currentMasters(db, P, 'partner').map((m) => m.name), ['テスト商店']);
  });

  test('remote_id の重複はエラーで、何も追記しない', async () => {
    const db = freshDb();
    const dup = structuredClone(DEFAULT_MASTERS);
    dup.taxCodes.push({ code: 1, name: '重複' });
    await assert.rejects(sync(db, dup), /重複/);
    assert.equal(count(db), 0);
  });

  test('版の表は UPDATE / DELETE できない', async () => {
    const db = freshDb();
    await sync(db, DEFAULT_MASTERS);
    assert.throws(() => db.exec("UPDATE provider_master_versions SET name = 'x'"), /追記専用/);
    assert.throws(() => db.exec('DELETE FROM provider_master_versions'), /追記専用/);
  });

  test('canonicalJson はキーの順に依らない', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});

describe('walletables の別名', () => {
  test('別名を付け・変え・外せる。存在しない口座には付けられない', async () => {
    const db = freshDb();
    await sync(db, DEFAULT_MASTERS);
    setWalletableAlias(db, P, 'credit_card:1', ' 楽天カード ');
    assert.deepEqual(listWalletables(db, P).map((w) => [w.name, w.alias]), [['テストカード', '楽天カード']]);
    setWalletableAlias(db, P, 'credit_card:1', 'メインカード');
    assert.equal(listWalletables(db, P)[0].alias, 'メインカード');
    setWalletableAlias(db, P, 'credit_card:1', null);
    assert.equal(listWalletables(db, P)[0].alias, null);
    assert.throws(() => setWalletableAlias(db, P, 'credit_card:99', 'x'), /無い/);
    assert.throws(() => setWalletableAlias(db, P, 'credit_card:1', '  '), /空/);
  });

  test('名前が変わっても別名は残る', async () => {
    const db = freshDb();
    await sync(db, DEFAULT_MASTERS);
    setWalletableAlias(db, P, 'credit_card:1', 'メイン');
    const next = structuredClone(DEFAULT_MASTERS);
    next.walletables[0].name = 'テストカード（新）';
    await sync(db, next);
    assert.deepEqual(listWalletables(db, P).map((w) => [w.name, w.alias]), [['テストカード（新）', 'メイン']]);
  });
});

describe("enabledAccounts（D11'）", () => {
  test('仮の対応表は 24 件で、事業主貸だけが private', () => {
    const m = loadAccountMap(DEFAULT_ACCOUNT_MAP_PATH);
    assert.equal(m.accounts.length, 24);
    assert.equal(m.provisional, true);
    assert.deepEqual(m.accounts.filter((a) => a.private).map((a) => a.key), ['事業主貸']);
  });

  test('名前で同期済みのマスタに当て、当たらない行は missing に入れる', async () => {
    const db = freshDb();
    await sync(db, DEFAULT_MASTERS);
    const { accounts, missing } = enabledAccounts(db, P, loadAccountMap(DEFAULT_ACCOUNT_MAP_PATH));
    // 対応表の順（A-5 の順）
    assert.deepEqual(accounts.map((a) => [a.id, a.name]), [
      ['102', '旅費交通費'],
      ['103', '通信費'],
      ['101', '消耗品費'],
      ['104', '事業主貸'],
    ]);
    assert.equal(missing.length, 20);
    assert.equal(accounts.find((a) => a.id === '104')?.private, true);
  });

  test('ID の指定は名前より優先し、表示名は freee の名前になる', async () => {
    const db = freshDb();
    await sync(db, DEFAULT_MASTERS);
    const map = parseAccountMap({
      version: 1,
      accounts: [{ key: '研修費', freee_name: '研修費', freee_account_item_id: 101, private: false }],
    });
    assert.deepEqual(enabledAccounts(db, P, map).accounts, [{ id: '101', name: '消耗品費', key: '研修費', private: false }]);
  });

  test('2 行が同じ勘定科目に当たるとエラー', async () => {
    const db = freshDb();
    await sync(db, DEFAULT_MASTERS);
    const map = parseAccountMap({
      version: 1,
      accounts: [
        { key: '研修費', freee_name: '消耗品費', freee_account_item_id: null, private: false },
        { key: '消耗品費', freee_name: '消耗品費', freee_account_item_id: 101, private: false },
      ],
    });
    assert.throws(() => enabledAccounts(db, P, map), /同じ勘定科目/);
  });

  test('対応表の形の誤りは読み込み時にエラー', () => {
    for (const bad of [
      null,
      { version: 2, accounts: [] },
      { version: 1, accounts: [] },
      { version: 1, accounts: [{ key: 'a', freee_name: 'a', freee_account_item_id: 'x', private: false }] },
      { version: 1, accounts: [{ key: 'a', freee_name: 'a', freee_account_item_id: null }] },
      {
        version: 1,
        accounts: [
          { key: 'a', freee_name: 'a', freee_account_item_id: null, private: false },
          { key: 'a', freee_name: 'b', freee_account_item_id: null, private: false },
        ],
      },
    ]) {
      assert.throws(() => parseAccountMap(bad), Error, JSON.stringify(bad));
    }
  });
});
