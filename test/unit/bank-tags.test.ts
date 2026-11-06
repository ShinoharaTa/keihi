// 明細の事業/私用タグとカテゴリ（docs/mvp-plan-v3.md T108）。一時ディレクトリの DB だけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { appendTxnTag, insertAccount, insertBankTxn, latestTxnTag, updateAccountSettings, type Tag } from '../../src/bank/repo.ts';
import { insertTagRule, listTagRules } from '../../src/bank/tagRepo.ts';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  createRule,
  deleteRule,
  listRules,
  resolveTag,
  resolveTagsBulk,
  setTxnTag,
  patternDigest,
  TagError,
} from '../../src/bank/tags.ts';

const now = '2026-11-06T00:00:00.000Z';
const T = new Date(now);
let root: string;
let n = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-tags-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function freshDb(): Db {
  const db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  return db;
}

function account(db: Db, defaultTag: Tag = 'unset'): string {
  const a = insertAccount(db, { provider: 'fake', name: 'A', kind: 'bank', source: 'csv', now });
  if (defaultTag !== 'unset') updateAccountSettings(db, a.id, { defaultTag }, now);
  return a.id;
}

function txn(db: Db, accountId: string, norm = 'セブンイレブン'): string {
  return insertBankTxn(db, { accountId, txnDate: '2026-11-01', amount: 500, side: 'expense', description: norm, descriptionNorm: norm, now }).id;
}

const auditActions = (db: Db) => (db.prepare('SELECT action FROM audit_log ORDER BY seq').all() as { action: string }[]).map((r) => r.action);

describe('効くタグの決定順（V5）', () => {
  type Case = {
    name: string;
    defaultTag: Tag;
    override?: { tag: Tag; category: string | null };
    accountRule?: { tag: Tag; category: string | null };
    globalRule?: { tag: Tag; category: string | null };
    want: { tag: Tag; category: string | null; source: string; rule?: 'account' | 'global' };
  };
  const cases: Case[] = [
    {
      name: '上書き > 口座ルール > 全口座ルール > 口座既定',
      defaultTag: 'business',
      override: { tag: 'private', category: 'food' },
      accountRule: { tag: 'business', category: 'telecom' },
      globalRule: { tag: 'private', category: 'leisure' },
      want: { tag: 'private', category: 'food', source: 'override' },
    },
    {
      name: '口座ルール > 全口座ルール',
      defaultTag: 'private',
      accountRule: { tag: 'business', category: 'telecom' },
      globalRule: { tag: 'private', category: 'leisure' },
      want: { tag: 'business', category: 'telecom', source: 'rule', rule: 'account' },
    },
    {
      name: '全口座ルール > 口座既定',
      defaultTag: 'business',
      globalRule: { tag: 'private', category: 'leisure' },
      want: { tag: 'private', category: 'leisure', source: 'rule', rule: 'global' },
    },
    { name: '口座既定 > unset', defaultTag: 'business', want: { tag: 'business', category: null, source: 'account' } },
    { name: '何も無ければ unset', defaultTag: 'unset', want: { tag: 'unset', category: null, source: 'none' } },
    {
      name: '上書きで unset にしたら、ルールより上書きが効く',
      defaultTag: 'business',
      override: { tag: 'unset', category: null },
      globalRule: { tag: 'private', category: null },
      want: { tag: 'unset', category: null, source: 'override' },
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const db = freshDb();
      try {
        const acc = account(db, c.defaultTag);
        const id = txn(db, acc);
        const ids: Record<string, string> = {};
        if (c.accountRule) ids.account = insertTagRule(db, { accountId: acc, pattern: 'セブンイレブン', match: 'exact', origin: 'manual', now, ...c.accountRule }).id;
        if (c.globalRule) ids.global = insertTagRule(db, { accountId: null, pattern: 'セブン', match: 'prefix', origin: 'manual', hitCount: 99, now, ...c.globalRule }).id;
        if (c.override) setTxnTag(db, { txnId: id, ...c.override, actor: 'user', source: 'human', now: T });
        const got = resolveTag(db, id)!;
        assert.deepEqual(
          { tag: got.tag, category: got.category, source: got.source, ruleId: got.ruleId },
          { tag: c.want.tag, category: c.want.category, source: c.want.source, ruleId: c.want.rule ? ids[c.want.rule] : undefined },
        );
      } finally {
        db.close();
      }
    });
  }

  test('同じ順位の並べ方: exact > prefix > partial → hit_count の多い方 → 新しい方', () => {
    const db = freshDb();
    try {
      const acc = account(db);
      const id = txn(db, acc);
      const rule = (match: 'exact' | 'prefix' | 'partial', pattern: string, hitCount: number, at: string) =>
        insertTagRule(db, { accountId: acc, pattern, match, tag: 'business', category: null, origin: 'manual', hitCount, now: at });
      const old = '2026-01-01T00:00:00.000Z';
      const partialHi = rule('partial', 'イレブン', 50, old);
      assert.equal(resolveTag(db, id)!.ruleId, partialHi.id);
      const prefixOld = rule('prefix', 'セブン', 0, old);
      assert.equal(resolveTag(db, id)!.ruleId, prefixOld.id, 'prefix は hit_count が少なくても partial より先');
      const prefixNew = rule('prefix', 'セブンイ', 0, now);
      assert.equal(resolveTag(db, id)!.ruleId, prefixNew.id, '同じ hit_count なら新しい方');
      const prefixHit = rule('prefix', 'セ', 2, old);
      assert.equal(resolveTag(db, id)!.ruleId, prefixHit.id, '新しさより hit_count');
      const exact = rule('exact', 'セブンイレブン', 0, old);
      assert.equal(resolveTag(db, id)!.ruleId, exact.id, 'exact が prefix より先');
      // 全口座の exact は口座の partial より後。
      const db2 = freshDb();
      try {
        const acc2 = account(db2);
        const id2 = txn(db2, acc2);
        insertTagRule(db2, { accountId: null, pattern: 'セブンイレブン', match: 'exact', tag: 'private', category: null, origin: 'manual', hitCount: 9, now });
        const p = insertTagRule(db2, { accountId: acc2, pattern: 'ブン', match: 'partial', tag: 'business', category: null, origin: 'manual', now: old });
        assert.equal(resolveTag(db2, id2)!.ruleId, p.id);
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });

  test('source=rule の版は上書きにしない（ルール・口座既定のほうで決まる）', () => {
    const db = freshDb();
    try {
      const acc = account(db, 'business');
      const id = txn(db, acc);
      appendTxnTag(db, { bankTxnId: id, tag: 'private', category: 'food', source: 'rule', actor: 'worker', decidedAt: now });
      assert.deepEqual(resolveTag(db, id), { tag: 'business', category: null, source: 'account' });
      appendTxnTag(db, { bankTxnId: id, tag: 'private', source: 'human', actor: 'user', decidedAt: now });
      appendTxnTag(db, { bankTxnId: id, tag: 'unset', source: 'rule', actor: 'worker', decidedAt: now });
      assert.deepEqual(resolveTag(db, id), { tag: 'private', category: null, source: 'override' });
    } finally {
      db.close();
    }
  });

  test('照合のしかた（exact / prefix / partial）と、他の口座のルールは当たらない', () => {
    const db = freshDb();
    try {
      const acc = account(db);
      const other = account(db);
      const id = txn(db, acc, 'abcストア');
      insertTagRule(db, { accountId: other, pattern: 'abcストア', match: 'exact', tag: 'business', category: null, origin: 'manual', now });
      insertTagRule(db, { accountId: null, pattern: 'abc', match: 'exact', tag: 'business', category: null, origin: 'manual', now });
      insertTagRule(db, { accountId: null, pattern: 'ストア', match: 'prefix', tag: 'business', category: null, origin: 'manual', now });
      assert.equal(resolveTag(db, id)!.source, 'none');
      insertTagRule(db, { accountId: null, pattern: 'cス', match: 'partial', tag: 'private', category: null, origin: 'manual', now });
      assert.equal(resolveTag(db, id)!.tag, 'private');
    } finally {
      db.close();
    }
  });

  test('resolveTagsBulk は明細ごとに決め、無い id は入れない。最新版の上書きが効く', () => {
    const db = freshDb();
    try {
      const acc = account(db, 'private');
      const a = txn(db, acc, 'x');
      const b = txn(db, acc, 'y');
      appendTxnTag(db, { bankTxnId: a, tag: 'business', source: 'human', actor: 'user', decidedAt: now });
      appendTxnTag(db, { bankTxnId: a, tag: 'private', category: 'car', source: 'human', actor: 'user', decidedAt: now });
      const m = resolveTagsBulk(db, [a, b, 'NOPE']);
      assert.equal(m.size, 2);
      assert.deepEqual(m.get(a), { tag: 'private', category: 'car', source: 'override' });
      assert.deepEqual(m.get(b), { tag: 'private', category: null, source: 'account' });
      assert.equal(resolveTag(db, 'NOPE'), null);
      assert.equal(resolveTagsBulk(db, []).size, 0);
    } finally {
      db.close();
    }
  });
});

describe('カテゴリ（V10）', () => {
  test('固定 12 種で、全部に日本語のラベルがある', () => {
    assert.equal(CATEGORIES.length, 12);
    for (const c of CATEGORIES) assert.ok(CATEGORY_LABELS[c]);
    assert.equal(CATEGORY_LABELS.utilities, '水道光熱');
  });

  test('不正なカテゴリ・タグは 400 の TagError で、何も書かない', () => {
    const db = freshDb();
    try {
      const id = txn(db, account(db));
      assert.throws(() => setTxnTag(db, { txnId: id, tag: 'business', category: 'groceries', actor: 'user', source: 'human' }), (e) => e instanceof TagError && e.status === 400 && e.reason === 'invalid_category');
      assert.throws(() => setTxnTag(db, { txnId: id, tag: 'both' as Tag, actor: 'user', source: 'human' }), (e) => e instanceof TagError && e.reason === 'invalid_tag');
      assert.equal(latestTxnTag(db, id), null);
      assert.deepEqual(auditActions(db), []);
    } finally {
      db.close();
    }
  });
});

describe('人の上書きと学習', () => {
  test('版を追記して監査に残す。明細が無ければ 404', () => {
    const db = freshDb();
    try {
      const id = txn(db, account(db));
      setTxnTag(db, { txnId: id, tag: 'business', category: 'food', actor: 'user', source: 'human', user: 'me@example.com', now: T });
      const r = setTxnTag(db, { txnId: id, tag: 'private', actor: 'agent:codex', source: 'agent', now: T });
      assert.equal(r.version.version, 2);
      assert.equal(r.version.source, 'agent');
      assert.equal(r.version.actor, 'agent:codex');
      const rows = db.prepare(`SELECT actor, payload_json FROM audit_log WHERE action = 'bank_txn.tag_set' ORDER BY seq`).all() as { actor: string; payload_json: string }[];
      assert.equal(rows.length, 2);
      assert.deepEqual(JSON.parse(rows[0].payload_json), { version: 1, tag: 'business', category: 'food', source: 'human', from: null, user: 'me@example.com' });
      assert.deepEqual(JSON.parse(rows[1].payload_json).from, { version: 1, tag: 'business', category: 'food' });
      assert.equal(rows[1].actor, 'agent:codex');
      assert.throws(() => setTxnTag(db, { txnId: 'NOPE', tag: 'business', actor: 'user', source: 'human' }), (e) => e instanceof TagError && e.status === 404);
      assert.ok(verifyAudit(db).ok);
    } finally {
      db.close();
    }
  });

  test('同じ口座・同じ正規化摘要で同じ上書きが 3 回続いたらルールが 1 件だけできる（4 回目は hit_count +1）', () => {
    const db = freshDb();
    try {
      const acc = account(db);
      const set = (id: string) => setTxnTag(db, { txnId: id, tag: 'private', category: 'food', actor: 'user', source: 'human', now: T });
      assert.equal(set(txn(db, acc)).learned, null);
      assert.equal(set(txn(db, acc)).learned, null);
      const third = set(txn(db, acc)).learned!;
      assert.equal(third.action, 'created');
      assert.deepEqual(
        { account_id: third.rule.account_id, pattern: third.rule.pattern, match: third.rule.match, tag: third.rule.tag, category: third.rule.category, origin: third.rule.origin, hit_count: third.rule.hit_count },
        { account_id: acc, pattern: 'セブンイレブン', match: 'exact', tag: 'private', category: 'food', origin: 'learned', hit_count: 0 },
      );
      const fourth = set(txn(db, acc)).learned!;
      assert.equal(fourth.action, 'hit');
      assert.equal(fourth.rule.id, third.rule.id);
      assert.equal(fourth.rule.hit_count, 1);
      assert.equal(listTagRules(db).length, 1);
      // 上書きしていない新しい明細にはルールが効く。
      const fresh = txn(db, acc);
      assert.deepEqual(resolveTag(db, fresh), { tag: 'private', category: 'food', source: 'rule', ruleId: third.rule.id });
      assert.deepEqual(auditActions(db).filter((a) => a.startsWith('tag_rule.')), ['tag_rule.learned', 'tag_rule.hit']);
    } finally {
      db.close();
    }
  });

  test('途中で違う上書き・違う口座・違う摘要が挟まると学習しない', () => {
    const db = freshDb();
    try {
      const acc = account(db);
      const other = account(db);
      const set = (id: string, category: string | null = 'food') => setTxnTag(db, { txnId: id, tag: 'private', category, actor: 'user', source: 'human', now: T });
      set(txn(db, acc));
      set(txn(db, acc), 'daily'); // カテゴリが違う
      set(txn(db, acc));
      set(txn(db, other)); // 口座が違う
      set(txn(db, acc, 'ローソン')); // 摘要が違う
      assert.equal(set(txn(db, acc)).learned, null); // 直近 3 回は food, food, daily
      assert.equal(listTagRules(db).length, 0);
      assert.equal(set(txn(db, acc)).learned!.action, 'created');
    } finally {
      db.close();
    }
  });
});

describe('学習の数え方と置き換え', () => {
  const set = (db: Db, id: string, tag: Tag, category: string | null = null, source: 'human' | 'agent' = 'human') =>
    setTxnTag(db, { txnId: id, tag, category, actor: source === 'human' ? 'user' : 'agent:codex', source, now: T });

  test('同じ明細を 3 回上書きしても学習しない', () => {
    const db = freshDb();
    try {
      const acc = account(db);
      const id = txn(db, acc);
      for (let i = 0; i < 3; i++) assert.equal(set(db, id, 'private', 'food').learned, null);
      const id2 = txn(db, acc);
      for (let i = 0; i < 3; i++) assert.equal(set(db, id2, 'private', 'food').learned, null);
      assert.equal(listTagRules(db).length, 0);
      assert.equal(set(db, txn(db, acc), 'private', 'food').learned!.action, 'created');
    } finally {
      db.close();
    }
  });

  test('agent の上書きは数えず、agent の上書きで学習も起きない', () => {
    const db = freshDb();
    try {
      const acc = account(db);
      for (let i = 0; i < 3; i++) assert.equal(set(db, txn(db, acc), 'private', 'food', 'agent').learned, null);
      set(db, txn(db, acc), 'private', 'food');
      set(db, txn(db, acc), 'private', 'food');
      const c = txn(db, acc);
      set(db, c, 'private', 'food');
      assert.equal(listTagRules(db).length, 1);
      const db2 = freshDb();
      try {
        const acc2 = account(db2);
        set(db2, txn(db2, acc2), 'private', 'food');
        set(db2, txn(db2, acc2), 'private', 'food');
        // 人が上書きしたあと agent が上書きし直した明細は数えない。
        const x = txn(db2, acc2);
        set(db2, x, 'private', 'daily');
        set(db2, x, 'private', 'food', 'agent');
        assert.equal(set(db2, txn(db2, acc2), 'business').learned, null);
        assert.equal(listTagRules(db2).length, 0);
        const y = txn(db2, acc2);
        set(db2, y, 'private', 'food');
        assert.equal(listTagRules(db2).length, 0); // 直近 3 件は food(y), business, food（x は agent なので数えない）
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });

  test('unset は学習しない', () => {
    const db = freshDb();
    try {
      const acc = account(db);
      for (let i = 0; i < 4; i++) assert.equal(set(db, txn(db, acc), 'unset').learned, null);
      assert.equal(listTagRules(db).length, 0);
    } finally {
      db.close();
    }
  });

  test('別のタグを学習したらルールを置き換え、新しい明細に新しいタグが効く。監査に摘要を入れない', () => {
    const db = freshDb();
    try {
      const acc = account(db);
      for (let i = 0; i < 3; i++) set(db, txn(db, acc), 'private', 'food');
      const first = listTagRules(db);
      assert.equal(first.length, 1);
      set(db, txn(db, acc), 'business', 'telecom');
      set(db, txn(db, acc), 'business', 'telecom');
      const r = set(db, txn(db, acc), 'business', 'telecom').learned!;
      assert.equal(r.action, 'superseded');
      assert.equal(r.rule.id, first[0].id);
      assert.deepEqual({ tag: r.rule.tag, category: r.rule.category, hit_count: r.rule.hit_count }, { tag: 'business', category: 'telecom', hit_count: 0 });
      assert.equal(listTagRules(db).length, 1);
      assert.deepEqual(resolveTag(db, txn(db, acc)), { tag: 'business', category: 'telecom', source: 'rule', ruleId: first[0].id });
      const rows = db.prepare(`SELECT action, payload_json FROM audit_log WHERE action LIKE 'tag_rule.%' ORDER BY seq`).all() as { action: string; payload_json: string }[];
      assert.deepEqual(rows.map((x) => x.action), ['tag_rule.learned', 'tag_rule.superseded']);
      assert.deepEqual(JSON.parse(rows[1].payload_json).from, { tag: 'private', category: 'food' });
      const all = (db.prepare('SELECT payload_json FROM audit_log').all() as { payload_json: string }[]).map((x) => x.payload_json).join('\n');
      assert.ok(!all.includes('セブンイレブン'));
    } finally {
      db.close();
    }
  });
});

describe('ルールの手動管理', () => {
  test('作る・一覧・消す。パターンは正規化し、どれも監査に残る', () => {
    const db = freshDb();
    try {
      const acc = account(db);
      const r = createRule(db, { accountId: acc, pattern: 'ＡＢＣ 株式会社', match: 'prefix', tag: 'business', category: 'telecom', actor: 'user', now: T });
      assert.equal(r.pattern, 'abc');
      assert.equal(r.origin, 'manual');
      assert.deepEqual(listRules(db).map((x) => x.id), [r.id]);
      assert.equal(deleteRule(db, r.id, { actor: 'user', now: T }), true);
      assert.equal(deleteRule(db, r.id, { actor: 'user', now: T }), false);
      assert.equal(listRules(db).length, 0);
      assert.deepEqual(auditActions(db), ['tag_rule.created', 'tag_rule.deleted']);
      const del = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'tag_rule.deleted'`).get() as { payload_json: string };
      const payload = JSON.parse(del.payload_json);
      assert.equal(payload.pattern, undefined);
      assert.equal(payload.pattern_sha256_16, patternDigest('abc'));
      assert.match(payload.pattern_sha256_16, /^[0-9a-f]{16}$/);
    } finally {
      db.close();
    }
  });

  test('不正な入力は 400', () => {
    const db = freshDb();
    try {
      const bad = (o: Partial<Parameters<typeof createRule>[1]>, reason: string) =>
        assert.throws(() => createRule(db, { pattern: 'x', match: 'exact', tag: 'business', actor: 'user', ...o }), (e) => e instanceof TagError && e.status === 400 && e.reason === reason);
      bad({ category: 'nope' }, 'invalid_category');
      bad({ match: 'regex' as never }, 'invalid_match');
      bad({ pattern: ' 株式会社 ' }, 'invalid_pattern');
      bad({ accountId: 'NOPE' }, 'unknown_account');
      assert.equal(listRules(db).length, 0);
    } finally {
      db.close();
    }
  });
});
