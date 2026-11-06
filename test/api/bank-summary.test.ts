// 明細の一覧と月次の集計の API（docs/mvp-plan-v3.md T110）。app.request() で叩く（ポートを開かない）。
// fixture: 明細 50 件（明細のある口座 2 + 引き落とし元を設定したカード）、振替 1 組・カードの引き落とし 1 件、タグとカテゴリあり。
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { insertAccount, insertBankTxn, updateAccountSettings, type BankTxnRow } from '../../src/bank/repo.ts';
import { setTxnTag } from '../../src/bank/tags.ts';
import { detectTransfers } from '../../src/bank/transfers.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { normalizeVendor } from '../../src/vendors/normalize.ts';
import { createApp } from '../../src/web/app.ts';
import { createAuth } from '../../src/web/auth.ts';

const LOCAL = '127.0.0.1:8795';
const USER = 'test@example.com';
const T0 = new Date('2026-11-06T03:00:00.000Z');
const NOW = T0.toISOString();

type Fx = {
  a: string; // 銀行A（既定タグ business）
  b: string; // 銀行B（既定タグ private）
  card: string; // 引き落とし元が銀行A のカード（明細なし）
  txns: BankTxnRow[];
  transferOut: string;
  transferIn: string;
  settlement: string;
  food: string[]; // 人が private / food にした明細
  transport: string; // 人が business / transport にした明細
};

let db: Db;
let app: Hono;
let fx: Fx;

function seed(): Fx {
  const mk = (name: string, kind: 'bank' | 'card') => insertAccount(db, { provider: 'fake', name, kind, source: 'csv', now: NOW }).id;
  const a = mk('銀行A', 'bank');
  const b = mk('銀行B', 'bank');
  const card = mk('テストカード', 'card');
  updateAccountSettings(db, a, { defaultTag: 'business' }, NOW);
  updateAccountSettings(db, b, { defaultTag: 'private' }, NOW);
  updateAccountSettings(db, card, { cardSettlementAccountId: a, cardSettlementPattern: 'ﾃｽﾄｶｰﾄﾞ' }, NOW);
  const txns: BankTxnRow[] = [];
  const add = (accountId: string, txnDate: string, amount: number, side: 'income' | 'expense', description: string) => {
    const t = insertBankTxn(db, { accountId, txnDate, amount, side, description, descriptionNorm: normalizeVendor(description), now: NOW });
    txns.push(t);
    return t.id;
  };
  const transferOut = add(a, '2026-10-10', 50000, 'expense', 'ﾌﾘｶｴ ｷﾞﾝｺｳB');
  const transferIn = add(b, '2026-10-11', 50000, 'income', 'ﾌﾘｶｴ ｷﾞﾝｺｳA');
  const settlement = add(a, '2026-10-27', 32100, 'expense', 'ﾃｽﾄｶｰﾄﾞ ﾋｷｵﾄｼ');
  // 残り 47 件。金額はすべて違う値にして、意図しない振替の組ができないようにする。同じ日付の明細を複数作る（cursor の境界）。
  for (let i = 0; txns.length < 50; i++) {
    const acc = i % 2 === 0 ? a : b;
    const month = i < 7 ? '09' : '10';
    const day = String(1 + (i % 28)).padStart(2, '0');
    const side = i % 5 === 0 ? 'income' : 'expense';
    const desc = i % 4 === 0 ? `ｽｰﾊﾟｰ ﾏﾙｲ ${i}` : `ﾐｾ ${i}`;
    add(acc, `2026-${month}-${day}`, 1000 + i * 37, side, desc);
  }
  detectTransfers(db, { windowDays: 3, now: T0 });
  // 人の上書き: 銀行A の 2 件を private/food、銀行B の 1 件を business/transport。
  const octA = txns.filter((t) => t.account_id === a && t.txn_date >= '2026-10-01' && t.description.startsWith('ﾐｾ'));
  const octB = txns.filter((t) => t.account_id === b && t.txn_date >= '2026-10-01' && t.description.startsWith('ﾐｾ'));
  const food = [octA[0]!.id, octA[1]!.id];
  for (const id of food) setTxnTag(db, { txnId: id, tag: 'private', category: 'food', actor: 'user', source: 'human', now: T0 });
  const transport = octB[0]!.id;
  setTxnTag(db, { txnId: transport, tag: 'business', category: 'transport', actor: 'user', source: 'human', now: T0 });
  return { a, b, card, txns, transferOut, transferIn, settlement, food, transport };
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  fx = seed();
  app = createApp({
    db,
    objectsDir: '/nonexistent',
    config: {
      ingest: { maxBytes: 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
      retention: { years: 7, extraYears: 1, start: 'next_year_0316' },
      provider: { kind: 'fake' },
    },
    auth: createAuth({ allowedUsers: [USER], allowedHosts: [LOCAL] }),
    triggerWorker: () => {},
    now: () => T0,
  });
});

function req(p: string) {
  return app.request(`http://${LOCAL}${p}`, { headers: { Host: LOCAL, 'Tailscale-User-Login': USER } });
}
async function getJson<T>(p: string, status = 200): Promise<T> {
  const r = await req(p);
  assert.equal(r.status, status, p);
  return (await r.json()) as T;
}

type Item = { id: string; account_id: string; account_name: string; txn_date: string; amount: number; side: string; description: string; tag: string; category: string | null; tag_source: string; excluded: boolean; transfer_kind: string | null };
type Page = { items: Item[]; next_cursor: string | null };
type Amounts = { income: number; expense: number };
type Summary = {
  month: string;
  by_account: ({ account_id: string; name: string; net: number } & Amounts)[];
  by_category: ({ category: string | null } & Amounts)[];
  by_tag: ({ tag: string } & Amounts)[];
  total: Amounts & { net: number };
  excluded: { kind: string; count: number; amount: number }[];
};

const sum = (xs: Amounts[]) => xs.reduce((s, x) => ({ income: s.income + x.income, expense: s.expense + x.expense }), { income: 0, expense: 0 });

describe('GET /api/summary/monthly', () => {
  test('振替・引き落としを除いた合計。口座別・カテゴリ別・タグ別の合計が total に一致し、除いた額が合う', async () => {
    const s = await getJson<Summary>('/api/summary/monthly?month=2026-10');
    const ex = new Set([fx.transferOut, fx.transferIn, fx.settlement]);
    const oct = fx.txns.filter((t) => t.txn_date.startsWith('2026-10'));
    const counted = oct.filter((t) => !ex.has(t.id));
    const exp = (ts: BankTxnRow[], side: string) => ts.filter((t) => t.side === side).reduce((n, t) => n + t.amount, 0);
    const want = { income: exp(counted, 'income'), expense: exp(counted, 'expense') };
    assert.equal(s.month, '2026-10');
    assert.deepEqual(s.total, { ...want, net: want.income - want.expense });
    assert.ok(want.expense > 0 && want.income > 0);
    // 口座別・カテゴリ別・タグ別の合計 = total。
    assert.deepEqual(sum(s.by_account), want);
    assert.deepEqual(sum(s.by_category), want);
    assert.deepEqual(sum(s.by_tag), want);
    for (const a of s.by_account) assert.equal(a.net, a.income - a.expense);
    assert.deepEqual(s.by_account.map((a) => [a.account_id, a.name]), [[fx.a, '銀行A'], [fx.b, '銀行B']]);
    assert.deepEqual(s.by_tag.map((t) => t.tag), ['business', 'private', 'unset']);
    // 除いた額: 振替 1 組（出金側の額）と引き落とし 1 件。チャージは 0。
    assert.deepEqual(s.excluded, [
      { kind: 'transfer', count: 1, amount: 50000 },
      { kind: 'card_settlement', count: 1, amount: 32100 },
      { kind: 'charge', count: 0, amount: 0 },
    ]);
    // 除く前の支出 = 集計の支出 + 振替の出金 + 引き落とし。
    assert.equal(exp(oct, 'expense'), s.total.expense + 50000 + 32100);
    assert.equal(exp(oct, 'income'), s.total.income + 50000);
    // カテゴリ: 人が付けた food / transport が出て、未分類（null）は最後。
    const cat = new Map(s.by_category.map((c) => [c.category, c]));
    assert.deepEqual(cat.get('food'), { category: 'food', ...sum(fx.food.map((id) => { const t = fx.txns.find((x) => x.id === id)!; return { income: t.side === 'income' ? t.amount : 0, expense: t.side === 'expense' ? t.amount : 0 }; })) });
    assert.ok(cat.has('transport'));
    assert.equal(s.by_category.at(-1)!.category, null);
    assert.deepEqual(s.by_category.map((c) => c.category), ['food', 'transport', null]);
  });

  test('from〜to で複数月を返す。単月と同じ中身', async () => {
    const r = await getJson<{ months: Summary[] }>('/api/summary/monthly?from=2026-09&to=2026-11');
    assert.deepEqual(r.months.map((m) => m.month), ['2026-09', '2026-10', '2026-11']);
    assert.deepEqual(r.months[1], await getJson<Summary>('/api/summary/monthly?month=2026-10'));
    assert.deepEqual(r.months[2]!.total, { income: 0, expense: 0, net: 0 });
    assert.deepEqual(r.months[2]!.by_account, []);
    const all = await getJson<{ months: Summary[] }>('/api/summary/monthly?from=2024-01&to=2026-12');
    assert.equal(all.months.length, 36);
  });

  test('不正な月・範囲は 400', async () => {
    const bad = async (q: string, error: string) => assert.deepEqual(await getJson(`/api/summary/monthly${q}`, 400), { error });
    await bad('?month=2026-13', 'invalid_month');
    await bad('?month=2026-1', 'invalid_month');
    await bad('', 'month_required');
    await bad('?from=2026-01', 'month_required');
    await bad('?month=2026-10&from=2026-01', 'month_and_range');
    await bad('?from=2026-10&to=2026-09', 'invalid_range');
    await bad('?from=2023-12&to=2026-12', 'too_many_months');
    await bad('?from=2026-1&to=2026-12', 'invalid_from');
  });
});

describe('GET /api/bank_txns', () => {
  test('cursor で 20 件ずつ 3 回取ると 50 件を重複も抜けもなく txn_date DESC, id DESC で返す', async () => {
    const got: Item[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p: Page = await getJson<Page>(`/api/bank_txns?limit=20${cursor ? `&cursor=${cursor}` : ''}`);
      sizes.push(p.items.length);
      got.push(...p.items);
      cursor = p.next_cursor;
    }
    assert.deepEqual(sizes, [20, 20, 10]);
    assert.equal(cursor, null);
    assert.equal(new Set(got.map((x) => x.id)).size, 50);
    assert.deepEqual(new Set(got.map((x) => x.id)), new Set(fx.txns.map((t) => t.id)));
    const sorted = [...got].sort((x, y) => (x.txn_date !== y.txn_date ? (x.txn_date < y.txn_date ? 1 : -1) : x.id < y.id ? 1 : -1));
    assert.deepEqual(got.map((x) => x.id), sorted.map((x) => x.id));
    // 既定の上限は 100（全部 1 回で返る）。
    const one = await getJson<Page>('/api/bank_txns');
    assert.equal(one.items.length, 50);
    assert.equal(one.next_cursor, null);
  });

  test('行にタグ・カテゴリ・口座名・除外と振替の種類が付く', async () => {
    const { items } = await getJson<Page>('/api/bank_txns');
    const by = new Map(items.map((x) => [x.id, x]));
    assert.deepEqual(
      [fx.transferOut, fx.transferIn, fx.settlement].map((id) => [by.get(id)!.excluded, by.get(id)!.transfer_kind]),
      [[true, 'transfer'], [true, 'transfer'], [true, 'card_settlement']],
    );
    const f = by.get(fx.food[0]!)!;
    assert.deepEqual([f.account_name, f.tag, f.category, f.tag_source, f.excluded, f.transfer_kind], ['銀行A', 'private', 'food', 'override', false, null]);
    const plainB = items.find((x) => x.account_id === fx.b && x.id !== fx.transport && x.id !== fx.transferIn)!;
    assert.deepEqual([plainB.account_name, plainB.tag, plainB.category, plainB.tag_source], ['銀行B', 'private', null, 'account']);
  });

  test('q は正規化した摘要の部分一致（全角・半角を揃える）', async () => {
    const { items } = await getJson<Page>(`/api/bank_txns?q=${encodeURIComponent('スーパー')}`);
    const want = fx.txns.filter((t) => t.description.startsWith('ｽｰﾊﾟｰ')).map((t) => t.id);
    assert.ok(want.length > 0);
    assert.deepEqual(new Set(items.map((x) => x.id)), new Set(want));
    const lower = await getJson<Page>(`/api/bank_txns?q=${encodeURIComponent('ﾏﾙｲ')}`);
    assert.equal(lower.items.length, want.length);
  });

  test('tag・category は効くタグで絞る。tag の絞り込みでも cursor が続く', async () => {
    const biz = (await getJson<Page>('/api/bank_txns?tag=business')).items;
    const wantBiz = fx.txns.filter((t) => (t.account_id === fx.a && !fx.food.includes(t.id)) || t.id === fx.transport).map((t) => t.id);
    assert.deepEqual(new Set(biz.map((x) => x.id)), new Set(wantBiz));
    assert.ok(biz.every((x) => x.tag === 'business'));
    // 7 件ずつで全部たどる。
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const p: Page = await getJson<Page>(`/api/bank_txns?tag=business&limit=7${cursor ? `&cursor=${cursor}` : ''}`);
      paged.push(...p.items.map((x) => x.id));
      cursor = p.next_cursor;
    } while (cursor);
    assert.deepEqual(paged, biz.map((x) => x.id));
    const food = (await getJson<Page>('/api/bank_txns?category=food')).items;
    assert.deepEqual(new Set(food.map((x) => x.id)), new Set(fx.food));
    assert.equal((await getJson<Page>('/api/bank_txns?tag=unset')).items.length, 0);
  });

  test('期間・口座・side・金額の範囲で絞る', async () => {
    const { items } = await getJson<Page>(`/api/bank_txns?from=2026-10-01&to=2026-10-15&account_id=${fx.a}&side=expense&amount_min=1000&amount_max=60000`);
    const want = fx.txns.filter((t) => t.txn_date >= '2026-10-01' && t.txn_date <= '2026-10-15' && t.account_id === fx.a && t.side === 'expense' && t.amount >= 1000 && t.amount <= 60000);
    assert.ok(want.length > 0);
    assert.deepEqual(new Set(items.map((x) => x.id)), new Set(want.map((t) => t.id)));
    assert.ok(items.some((x) => x.id === fx.transferOut));
  });

  test('不正な引数は 400', async () => {
    const bad = async (q: string, error: string) => assert.deepEqual(await getJson(`/api/bank_txns?${q}`, 400), { error });
    await bad('from=2026-10', 'invalid_from');
    await bad('tag=biz', 'invalid_tag');
    await bad('category=xxx', 'invalid_category');
    await bad('side=out', 'invalid_side');
    await bad('amount_min=-1', 'invalid_amount_min');
    await bad('limit=101', 'invalid_limit');
    await bad('limit=0', 'invalid_limit');
    await bad('cursor=zzz', 'invalid_cursor');
  });
});

test('/api/status の bank に latest_txn_date が付く', async () => {
  const s = await getJson<{ bank: Record<string, unknown> }>('/api/status');
  assert.equal(s.bank.latest_txn_date, fx.txns.map((t) => t.txn_date).sort().at(-1));
});
