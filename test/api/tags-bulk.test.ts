// 明細のタグの一括の上書きと取り消しの API（docs/cashflow.md §5）。Hono の app.request() で叩く（ポートを開かない）。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { verifyAudit } from '../../src/audit.ts';
import { insertAccount, insertBankTxn, updateAccountSettings } from '../../src/bank/repo.ts';
import { recentHumanOverrides } from '../../src/bank/tagRepo.ts';
import { resolveTag, setTxnTag } from '../../src/bank/tags.ts';
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
  root = await mkdtemp(path.join(tmpdir(), 'keihi-tags-bulk-api-'));
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

const audits = () => db.prepare('SELECT actor, action, entity, entity_id, payload_json FROM audit_log ORDER BY seq').all() as {
  actor: string;
  action: string;
  entity: string;
  entity_id: string;
  payload_json: string;
}[];
const rows = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

type Bulk = {
  batch_id: string | null;
  changed: number;
  unchanged: number;
  learned_rules: { rule: { id: string; hit_count: number }; action: string }[];
  effective: { id: string; tag: string; category: string | null; tag_source: string }[];
};
type Revert = { batch_id: string; revert_batch_id: string; reverted: number; skipped: number; learned_rule_ids: string[] };

const bulk = async (body: unknown) => {
  const res = await send('POST', '/api/bank_txns/bulk_tag', body);
  assert.equal(res.status, 200, JSON.stringify(body));
  return (await res.json()) as Bulk;
};

// 効く値がルール由来（private / leisure）、口座の既定（business）、どれも無い（unset）の 3 件。
const setup = async () => {
  assert.equal((await send('POST', '/api/tag_rules', { account_id: acc, pattern: 'netflix', match: 'exact', tag: 'private', category: 'leisure' })).status, 201);
  const ruleId = (db.prepare('SELECT id FROM tag_rules').get() as { id: string }).id;
  const biz = insertAccount(db, { provider: 'fake', name: 'B', kind: 'bank', source: 'csv', now }).id;
  updateAccountSettings(db, biz, { defaultTag: 'business' }, now);
  const ruled = txn('netflix');
  const byAccount = insertBankTxn(db, { accountId: biz, txnDate: '2026-11-01', amount: 3000, side: 'expense', description: 'x', descriptionNorm: 'x', now }).id;
  const plain = txn('shop');
  return { ruleId, ruled, byAccount, plain };
};

describe('POST /api/bank_txns/bulk_tag', () => {
  test('tag だけ: category はルール・口座の既定で決まる今の値を引き継ぐ。同じ値になる明細は unchanged', async () => {
    const { ruled, byAccount, plain } = await setup();
    const j = await bulk({ ids: [ruled, byAccount, plain], tag: 'business' });
    assert.equal(j.changed, 2);
    assert.equal(j.unchanged, 1);
    assert.ok(j.batch_id);
    assert.deepEqual(j.effective, [
      { id: ruled, tag: 'business', category: 'leisure', tag_source: 'override' },
      { id: byAccount, tag: 'business', category: null, tag_source: 'account' },
      { id: plain, tag: 'business', category: null, tag_source: 'override' },
    ]);
    const written = db.prepare('SELECT bank_txn_id, source, batch_id, cleared FROM txn_tags ORDER BY rowid').all() as object[];
    assert.deepEqual(written.map((r) => ({ ...r })), [
      { bank_txn_id: ruled, source: 'human', batch_id: j.batch_id, cleared: 0 },
      { bank_txn_id: plain, source: 'human', batch_id: j.batch_id, cleared: 0 },
    ]);
  });

  test('category だけ: tag は今の値を引き継ぐ。両方なら両方を書き、null は未分類。重複した id は 1 件', async () => {
    const { ruled, byAccount, plain } = await setup();
    const j = await bulk({ ids: [ruled, byAccount, plain], category: 'telecom' });
    assert.deepEqual(j.effective.map((e) => [e.tag, e.category, e.tag_source]), [
      ['private', 'telecom', 'override'],
      ['business', 'telecom', 'override'],
      ['unset', 'telecom', 'override'],
    ]);
    const k = await bulk({ ids: [ruled, ruled, plain], tag: 'private', category: null });
    assert.deepEqual([k.changed, k.unchanged], [2, 0]);
    assert.deepEqual(k.effective.map((e) => [e.id, e.tag, e.category]), [
      [ruled, 'private', null],
      [plain, 'private', null],
    ]);
  });

  test('不正な入力は 400、無い明細を含むと 404（missing 付き）。どれも 1 行も書かない', async () => {
    const id = txn();
    const many = Array.from({ length: 501 }, (_, i) => `ID${i}`);
    for (const [body, error] of [
      ['{bad', 'invalid_json'],
      [{ ids: [id], tag: 'business', extra: 1 }, 'invalid_field'],
      [{ tag: 'business' }, 'invalid_ids'],
      [{ ids: id, tag: 'business' }, 'invalid_ids'],
      [{ ids: [id, 1], tag: 'business' }, 'invalid_ids'],
      [{ ids: [], tag: 'business' }, 'invalid_ids'],
      [{ ids: many, tag: 'business' }, 'too_many_ids'],
      [{ ids: [id] }, 'nothing_to_set'],
      [{ ids: [id], tag: 'mixed' }, 'invalid_tag'],
      [{ ids: [id], tag: null }, 'invalid_tag'],
      [{ ids: [id], category: 'groceries' }, 'invalid_category'],
      [{ ids: [id], tag: 'business', category: 3 }, 'invalid_category'],
    ] as const) {
      const res = await send('POST', '/api/bank_txns/bulk_tag', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.deepEqual(await res.json(), { error });
    }
    const res = await send('POST', '/api/bank_txns/bulk_tag', { ids: [id, 'NOPE1', 'NOPE2'], tag: 'business' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found', missing: ['NOPE1', 'NOPE2'] });
    // 重複を除いて 500 件なら上限の内（どれも無いので 404。missing は 20 件まで）。
    const dup = await send('POST', '/api/bank_txns/bulk_tag', { ids: [...many.slice(0, 500), 'ID0'], tag: 'business' });
    assert.equal(dup.status, 404);
    assert.equal(((await dup.json()) as { missing: string[] }).missing.length, 20);
    assert.equal(rows('txn_tags'), 0);
    assert.equal(rows('audit_log'), 0);
  });

  test('値が変わらない明細は版を足さない。全部 unchanged なら batch_id は null で、監査も書かない', async () => {
    const { ruled, byAccount, plain } = await setup();
    const before = rows('audit_log');
    const j = await bulk({ ids: [ruled], tag: 'private', category: 'leisure' });
    assert.deepEqual([j.batch_id, j.changed, j.unchanged], [null, 0, 1]);
    assert.deepEqual(j.effective, [{ id: ruled, tag: 'private', category: 'leisure', tag_source: 'rule' }]);
    const k = await bulk({ ids: [byAccount, plain], category: null });
    assert.deepEqual([k.batch_id, k.changed, k.unchanged], [null, 0, 2]);
    assert.equal(rows('txn_tags'), 0);
    assert.equal(rows('audit_log'), before);
    // 一部だけ変わるなら、変わった明細だけ版を足す。
    const m = await bulk({ ids: [ruled, plain], tag: 'private' });
    assert.deepEqual([m.changed, m.unchanged], [1, 1]);
    assert.equal(rows('txn_tags'), 1);
  });

  test('監査: 明細ごとの tag_set（batch_id 付き）と bulk_tag_set 1 件。bulk_tag_set に摘要・明細 id は入らない', async () => {
    const ids = [txn('cafe example'), txn('cafe example'), txn('book store')];
    const j = await bulk({ ids, tag: 'private' });
    const a = audits();
    assert.deepEqual(a.map((x) => x.action), ['bank_txn.tag_set', 'bank_txn.tag_set', 'bank_txn.tag_set', 'bank_txn.bulk_tag_set']);
    assert.deepEqual(a.slice(0, 3).map((x) => [x.entity_id, JSON.parse(x.payload_json).batch_id]), ids.map((id) => [id, j.batch_id]));
    const last = a[3];
    assert.deepEqual([last.actor, last.entity, last.entity_id], ['user', 'bank_txn_batch', j.batch_id]);
    assert.deepEqual(JSON.parse(last.payload_json), { count: 3, changed: 3, unchanged: 0, set: { tag: 'private' }, user: 'me@example.com' });
    for (const s of [...ids, 'cafe', 'book']) assert.ok(!last.payload_json.includes(s), s);
    assert.ok(verifyAudit(db).ok);
  });

  test('同じ口座・摘要の 5 件で learned ルールが 1 件（hit_count 0）。同じ一括をもう一度書くと hit_count +1 だけ', async () => {
    const ids = Array.from({ length: 5 }, () => txn('gym example'));
    const j = await bulk({ ids, tag: 'private', category: 'leisure' });
    assert.deepEqual(j.learned_rules.map((l) => [l.action, l.rule.hit_count]), [['created', 0]]);
    const ruleAudits = () => audits().filter((a) => a.action.startsWith('tag_rule.')).map((a) => [a.action, JSON.parse(a.payload_json).batch_id]);
    assert.deepEqual(ruleAudits(), [['tag_rule.learned', j.batch_id]]);
    // agent の上書き（学習に数えない）で値を変えておくと、同じ一括がもう一度書かれる。
    for (const id of ids) setTxnTag(db, { txnId: id, tag: 'business', actor: 'agent', source: 'agent', now: T0 });
    const k = await bulk({ ids, tag: 'private', category: 'leisure' });
    assert.equal(k.changed, 5);
    assert.deepEqual(k.learned_rules.map((l) => [l.action, l.rule.id, l.rule.hit_count]), [['hit', j.learned_rules[0].rule.id, 1]]);
    assert.deepEqual(ruleAudits(), [['tag_rule.learned', j.batch_id], ['tag_rule.hit', k.batch_id]]);
    const rules = (await (await send('GET', '/api/tag_rules')).json()) as { items: { hit_count: number }[] };
    assert.deepEqual(rules.items.map((r) => r.hit_count), [1]);
  });
});

describe('POST /api/bank_txns/bulk_tag/:batch_id/revert', () => {
  test('上書きの無かった明細はルール・口座の既定に、あった明細は一つ前の上書きに戻る。後から直した明細は skipped', async () => {
    const { ruleId, ruled, byAccount, plain: overridden } = await setup();
    const later = txn('shop2');
    assert.equal((await send('POST', `/api/bank_txns/${overridden}/tag`, { tag: 'business', category: 'telecom' })).status, 200);
    const b = await bulk({ ids: [ruled, byAccount, overridden, later], tag: 'private', category: 'food' });
    assert.equal(b.changed, 4);
    assert.equal((await send('POST', `/api/bank_txns/${later}/tag`, { tag: 'business' })).status, 200);

    const res = await send('POST', `/api/bank_txns/bulk_tag/${b.batch_id}/revert`);
    assert.equal(res.status, 200);
    const r = (await res.json()) as Revert;
    assert.equal(r.batch_id, b.batch_id);
    assert.ok(r.revert_batch_id && r.revert_batch_id !== b.batch_id);
    assert.deepEqual([r.reverted, r.skipped, r.learned_rule_ids], [3, 1, []]);

    assert.deepEqual(resolveTag(db, ruled), { tag: 'private', category: 'leisure', source: 'rule', ruleId });
    assert.deepEqual(resolveTag(db, byAccount), { tag: 'business', category: null, source: 'account' });
    assert.deepEqual(resolveTag(db, overridden), { tag: 'business', category: 'telecom', source: 'override' });
    assert.deepEqual(resolveTag(db, later), { tag: 'business', category: null, source: 'override' });
    const last = db.prepare('SELECT tag, category, source, batch_id, cleared FROM txn_tags WHERE bank_txn_id = ? ORDER BY version DESC LIMIT 1');
    assert.deepEqual({ ...(last.get(ruled) as object) }, { tag: 'unset', category: null, source: 'human', batch_id: r.revert_batch_id, cleared: 1 });
    assert.deepEqual({ ...(last.get(overridden) as object) }, { tag: 'business', category: 'telecom', source: 'human', batch_id: r.revert_batch_id, cleared: 0 });

    const reverts = db.prepare('SELECT batch_id, revert_batch_id FROM txn_tag_batch_reverts').all() as object[];
    assert.deepEqual(reverts.map((x) => ({ ...x })), [{ batch_id: b.batch_id, revert_batch_id: r.revert_batch_id }]);
    const a = audits();
    const done = a.at(-1)!;
    assert.deepEqual([done.action, done.entity, done.entity_id], ['bank_txn.bulk_tag_reverted', 'bank_txn_batch', b.batch_id]);
    assert.deepEqual(JSON.parse(done.payload_json), { batch_id: b.batch_id, revert_batch_id: r.revert_batch_id, reverted: 3, skipped: 1, user: 'me@example.com' });
    const sets = a.slice(-4, -1).map((x) => {
      const p = JSON.parse(x.payload_json);
      return [x.action, x.entity_id, p.revert_of, p.cleared];
    });
    assert.deepEqual(sets, [
      ['bank_txn.tag_set', ruled, b.batch_id, true],
      ['bank_txn.tag_set', byAccount, b.batch_id, true],
      ['bank_txn.tag_set', overridden, b.batch_id, undefined],
    ]);
    assert.ok(verifyAudit(db).ok);

    const again = await send('POST', `/api/bank_txns/bulk_tag/${b.batch_id}/revert`);
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { error: 'already_reverted' });
    const ofRevert = await send('POST', `/api/bank_txns/bulk_tag/${r.revert_batch_id}/revert`);
    assert.equal(ofRevert.status, 409);
    assert.deepEqual(await ofRevert.json(), { error: 'not_revertible' });
    const missing = await send('POST', '/api/bank_txns/bulk_tag/NOPE/revert');
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found' });
    assert.equal(rows('txn_tag_batch_reverts'), 1);
  });

  test('学習は取り消さず、その一括で作られたルールの id を返す。cleared の版は学習の材料にしない', async () => {
    const ids = Array.from({ length: 3 }, () => txn('gym example'));
    const b = await bulk({ ids, tag: 'private', category: 'leisure' });
    const ruleId = b.learned_rules[0].rule.id;
    const r = (await (await send('POST', `/api/bank_txns/bulk_tag/${b.batch_id}/revert`)).json()) as Revert;
    assert.deepEqual([r.reverted, r.learned_rule_ids], [3, [ruleId]]);
    // ルールは残り、明細はルールで同じ値になる（上書きではない）。
    assert.deepEqual(resolveTag(db, ids[0]), { tag: 'private', category: 'leisure', source: 'rule', ruleId });
    assert.deepEqual(recentHumanOverrides(db, acc, 'gym example', 3), []);
  });

  test('全部 skipped なら 409 nothing_to_revert で、取り消しの行も監査も書かない', async () => {
    const id = txn();
    const b = await bulk({ ids: [id], tag: 'private' });
    assert.equal((await send('POST', `/api/bank_txns/${id}/tag`, { tag: 'business' })).status, 200);
    const [tags, logs] = [rows('txn_tags'), rows('audit_log')];
    const res = await send('POST', `/api/bank_txns/bulk_tag/${b.batch_id}/revert`);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'nothing_to_revert' });
    assert.deepEqual([rows('txn_tags'), rows('audit_log'), rows('txn_tag_batch_reverts')], [tags, logs, 0]);
  });

  test('直前の版が cleared の明細を一括 → 取り消すと、また cleared の版が足されて上書き無しに戻る', async () => {
    const id = txn();
    const first = await bulk({ ids: [id], tag: 'private' });
    assert.equal((await send('POST', `/api/bank_txns/bulk_tag/${first.batch_id}/revert`)).status, 200);
    assert.equal(resolveTag(db, id)!.source, 'none');
    const second = await bulk({ ids: [id], tag: 'business', category: 'telecom' });
    assert.equal(resolveTag(db, id)!.source, 'override');
    const r = (await (await send('POST', `/api/bank_txns/bulk_tag/${second.batch_id}/revert`)).json()) as Revert;
    assert.equal(r.reverted, 1);
    const versions = db.prepare('SELECT version, tag, source, cleared FROM txn_tags WHERE bank_txn_id = ? ORDER BY version').all(id) as object[];
    assert.deepEqual(versions.map((v) => ({ ...v })), [
      { version: 1, tag: 'private', source: 'human', cleared: 0 },
      { version: 2, tag: 'unset', source: 'human', cleared: 1 },
      { version: 3, tag: 'business', source: 'human', cleared: 0 },
      { version: 4, tag: 'unset', source: 'human', cleared: 1 },
    ]);
    assert.deepEqual(resolveTag(db, id), { tag: 'unset', category: null, source: 'none' });
  });

  test('一つ前が agent の版なら agent のまま戻し、その後の人の上書きの学習に agent の値が混ざらない', async () => {
    const agentIds = Array.from({ length: 3 }, () => txn('gym example'));
    for (const id of agentIds) setTxnTag(db, { txnId: id, tag: 'business', category: 'other', actor: 'agent', source: 'agent', now: T0 });
    const b = await bulk({ ids: agentIds, tag: 'private', category: 'leisure' });
    const ruleId = b.learned_rules[0].rule.id;
    assert.equal((await send('POST', `/api/bank_txns/bulk_tag/${b.batch_id}/revert`)).status, 200);
    const last = db.prepare('SELECT tag, category, source, cleared FROM txn_tags WHERE bank_txn_id = ? ORDER BY version DESC LIMIT 1');
    for (const id of agentIds) assert.deepEqual({ ...(last.get(id) as object) }, { tag: 'business', category: 'other', source: 'agent', cleared: 0 });
    assert.deepEqual(recentHumanOverrides(db, acc, 'gym example', 3), []);
    // 人が agent と同じ値を 3 件付ける。2 件目までは学習せず、3 件目で人の 3 件だけから置き換える。
    const humanIds = Array.from({ length: 3 }, () => txn('gym example'));
    const learned: unknown[] = [];
    for (const id of humanIds) {
      const res = await send('POST', `/api/bank_txns/${id}/tag`, { tag: 'business', category: 'other' });
      learned.push(((await res.json()) as { learned_rule: { action: string } | null }).learned_rule?.action ?? null);
    }
    assert.deepEqual(learned, [null, null, 'superseded']);
    assert.deepEqual(new Set(recentHumanOverrides(db, acc, 'gym example', 10).map((r) => r.bank_txn_id)), new Set(humanIds));
    const rules = (await (await send('GET', '/api/tag_rules')).json()) as { items: { id: string; tag: string; category: string }[] };
    assert.deepEqual(rules.items.map((r) => [r.id, r.tag, r.category]), [[ruleId, 'business', 'other']]);
  });

  test('txn_tag_batch_reverts は更新・削除できない', async () => {
    const b = await bulk({ ids: [txn()], tag: 'private' });
    assert.equal((await send('POST', `/api/bank_txns/bulk_tag/${b.batch_id}/revert`)).status, 200);
    assert.throws(() => db.exec("UPDATE txn_tag_batch_reverts SET created_at = 'x'"), /追記専用/);
    assert.throws(() => db.exec('DELETE FROM txn_tag_batch_reverts'), /追記専用/);
  });
});
