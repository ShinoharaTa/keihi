// 確認カード・確定・一覧の API（docs/mvp-plan.md T2-7・T2-8・T2-9・T2-11）。app.request() で叩く（ポートを開かない）。
// extract（別担当）が書く行は、ここで直接 INSERT して用意する。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono, MiddlewareHandler } from 'hono';
import sharp from 'sharp';
import { appendAudit, verifyAudit } from '../../src/audit.ts';
import { validateSchema } from '../../src/ai/validate.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { applyMasterItems } from '../../src/masters/sync.ts';
import { CATALOG } from '../../src/review/card.ts';
import { putObject } from '../../src/storage/objects.ts';
import { upsertVendorRule } from '../../src/vendors/dictionary.ts';
import { createApp } from '../../src/web/app.ts';

const NOW = new Date('2026-10-16T03:00:00.000Z'); // JST 2026-10-16(金) 12:00
const allow: MiddlewareHandler = async (_c, next) => next();
const ACC = { travel: '101', meeting: '102', ent: '103', supplies: '104', priv: '199' };
const REG = 'T1234567890123'; // 検査数字は合わない（書かれていても null にされる）
let validReg = '';

let root: string;
let n = 0;
let db: Db;
let objectsDir: string;
let app: Hono;
let clock = NOW;

function make() {
  clock = NOW;
  objectsDir = path.join(root, `objects-${n}`);
  db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
  const at = NOW.toISOString();
  applyMasterItems(
    db,
    'freee',
    'account',
    [
      { remoteId: ACC.travel, name: '旅費交通費', data: {} },
      { remoteId: ACC.meeting, name: '会議費', data: {} },
      { remoteId: ACC.ent, name: '接待交際費', data: {} },
      { remoteId: ACC.supplies, name: '消耗品費', data: {} },
      { remoteId: ACC.priv, name: '事業主貸', data: {} },
      { remoteId: '900', name: '有効でない科目', data: {} },
    ],
    at,
  );
  applyMasterItems(db, 'freee', 'walletable', [{ remoteId: 'credit_card:7', name: '楽天カード', data: {} }], at);
  app = createApp({
    db,
    objectsDir,
    config: {
      ingest: { maxBytes: 20 * 1024 * 1024 },
      calendar: { deadlineMode: 'early', yearEndHolidays: false },
      deadline: { countFrom: 'receipt_day' },
    },
    auth: allow,
    triggerWorker: () => {},
    now: () => clock,
  });
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-review-'));
  // 検査数字の合う登録番号を作る
  const { corporateCheckDigit } = await import('../../src/ai/validate.ts');
  validReg = `T${corporateCheckDigit('123456789012')}123456789012`;
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => make());

let seq = 0;
function addDoc(o: { id?: string; deadline?: string; status?: string; mime?: string; sha256?: string; noAi?: boolean } = {}): string {
  const id = o.id ?? `01DOC${String(seq++).padStart(21, '0')}`;
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode,
       storage_key, no_ai, status, created_at)
     VALUES (?, ?, 10, ?, 'pwa', 'scan', ?, '2026-10-15', 'client', ?, 'early', 'k', ?, ?, ?)`,
  ).run(id, o.sha256 ?? `sha-${id}`, o.mime ?? 'image/jpeg', NOW.toISOString(), o.deadline ?? '2026-10-26', o.noAi ? 1 : 0, o.status ?? 'needs_review', NOW.toISOString());
  return id;
}

type Ex = { txn_date?: string | null; amount?: number | null; by_rate?: unknown[]; vendor?: string | null; reg?: string | null; questions?: unknown[] };
function addExtraction(docId: string, ex: Ex = {}, cls: { source: string; candidates: unknown[] }[] = []): string {
  const id = `EX${docId}`;
  const byRate = ex.by_rate ?? [{ category: 'taxable_10', amount_incl_tax: 1100, tax: 100 }];
  const raw = { extraction: { vendor_name: ex.vendor ?? null }, account_candidates: [], questions: ex.questions ?? [] };
  db.prepare(
    `INSERT INTO extractions (id, document_id, engine, raw_json, txn_date, amount_total, tax_by_rate_json, vendor_name, invoice_reg_no, confidence, created_at)
     VALUES (?, ?, 'gemini', ?, ?, ?, ?, ?, ?, 0.9, ?)`,
  ).run(id, docId, JSON.stringify(raw), ex.txn_date === undefined ? '2026-10-14' : ex.txn_date, ex.amount === undefined ? 1100 : ex.amount, JSON.stringify(byRate), ex.vendor === undefined ? 'カフェ・ドゥ・テスト' : ex.vendor, ex.reg ?? null, NOW.toISOString());
  cls.forEach((c, i) => {
    db.prepare(`INSERT INTO classifications (id, extraction_id, source, candidates_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(`CL${i}${id}`, id, c.source, JSON.stringify(c.candidates), NOW.toISOString());
  });
  db.prepare(`INSERT INTO ai_turns (id, document_id, seq, role, model, created_at) VALUES (?, ?, 1, 'ai', 'gemini-3.8-flash', ?)`).run(`AT${docId}`, docId, NOW.toISOString());
  return id;
}

const GEMINI = {
  source: 'gemini',
  candidates: [
    { account_id: ACC.ent, tax_id: 'taxable_10', confidence: 0.3, reason: 'x' },
    { account_id: ACC.meeting, tax_id: 'taxable_10', confidence: 0.8, reason: 'x' },
    { account_id: '900', tax_id: 'taxable_10', confidence: 0.99, reason: '有効でない科目' },
    { account_id: ACC.supplies, tax_id: 'taxable_10', confidence: 0.5, reason: 'x' },
  ],
};

async function getCard(id: string) {
  const res = await app.request(`/api/documents/${id}/card`);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
async function act(id: string, action: string, body: unknown) {
  const res = await app.request(`/api/documents/${id}/${action}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const comp = (card: Record<string, any>, name: string) => card.surface.components.find((c: { component: string }) => c.component === name);
const audits = (action: string) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq').all(action) as Record<string, any>[];
const jobs = () => (db.prepare('SELECT kind, ref_id FROM jobs ORDER BY id').all() as { kind: string; ref_id: string }[]).map((j) => j.kind);
const status = (id: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status;

describe('GET /api/documents/:id/card（T2-7）', () => {
  test('カタログに適合し、科目は有効なものだけ確信度順に 3 件。ui_cards と ai.proposed を残す', async () => {
    const id = addDoc();
    addExtraction(id, {}, [GEMINI]);
    const r = await getCard(id);
    assert.equal(r.status, 200);
    assert.deepEqual(validateSchema(CATALOG, r.json.surface), []);
    const chips = comp(r.json, 'AccountChips');
    assert.deepEqual(chips.candidates.map((c: any) => c.account_id), [ACC.meeting, ACC.supplies, ACC.ent]);
    assert.equal(chips.candidates[0].name, '会議費');
    assert.equal(chips.selected, ACC.meeting);
    assert.deepEqual(
      r.json.surface.components.map((c: any) => c.component),
      ['ReceiptThumb', 'AmountField', 'DateField', 'VendorField', 'AccountChips', 'AccountSheet', 'PaymentChips', 'DecisionBar'],
    );
    assert.equal(comp(r.json, 'ReceiptThumb').document_id, id);
    assert.equal(JSON.stringify(r.json).includes('http'), false);
    const dm = r.json.dataModel;
    assert.equal(dm.version, 0);
    assert.equal(dm.ai_turn_id, `AT${id}`);
    assert.equal(dm.sources.account_id, 'ai');
    assert.equal(dm.sources.txn_date, 'ocr');
    assert.equal(dm.values.payment, null);
    assert.equal(dm.days_left, 6); // 10/16(金) → 10/26(月): 19,20,21,22,23,26
    assert.ok(dm.accounts.some((a: any) => a.id === ACC.priv && a.private));
    assert.equal(dm.accounts.some((a: any) => a.id === '900'), false);
    const pay = comp(r.json, 'PaymentChips');
    assert.deepEqual(pay.options.map((o: any) => o.id), ['owner', 'cash', 'card:credit_card:7']);
    const cards = db.prepare('SELECT * FROM ui_cards').all() as any[];
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, r.json.card_id);
    assert.equal(cards[0].ai_turn_id, `AT${id}`);
    const p = audits('ai.proposed');
    assert.equal(p.length, 1);
    assert.equal(p[0].actor, 'ai');
    assert.equal(JSON.parse(p[0].payload_json).proposer, 'ai');

    // 内容が同じなら使い回す（監査も増えない）
    const r2 = await getCard(id);
    assert.equal(r2.json.card_id, r.json.card_id);
    assert.equal(audits('ai.proposed').length, 1);
  });

  test('日付が進んでも・documents.status が変わっても同じカード（残り営業日と status は応答で付け足す）', async () => {
    const id = addDoc();
    addExtraction(id, {}, [GEMINI]);
    const r = await getCard(id);
    assert.equal(r.json.dataModel.days_left, 6);
    const stored = JSON.parse((db.prepare('SELECT card_json FROM ui_cards WHERE id = ?').get(r.json.card_id) as { card_json: string }).card_json);
    assert.equal('days_left' in stored.dataModel, false);
    assert.equal('status' in stored.dataModel, false);
    clock = new Date('2026-10-19T03:00:00.000Z'); // 月
    db.prepare(`UPDATE documents SET status = 'needs_attention' WHERE id = ?`).run(id);
    const r2 = await getCard(id);
    assert.equal(r2.json.card_id, r.json.card_id);
    assert.equal(r2.json.dataModel.days_left, 5);
    assert.equal(r2.json.dataModel.status, 'needs_attention');
    assert.equal(audits('ai.proposed').length, 1);
    // 古くならないので、そのカードで確定できる
    const a = await act(id, 'approve', { card_id: r.json.card_id, expected_version: 0, values: { payment: 'cash' } });
    assert.equal(a.status, 200);
  });

  test('質問カード（questions[]）は surface に入れない', async () => {
    const id = addDoc();
    addExtraction(id, { questions: [{ component: 'YesNoQuestion', text: '会議ですか', yes: { field: 'account_id', value: ACC.meeting }, no: { field: 'account_id', value: ACC.ent } }] }, [GEMINI]);
    const r = await getCard(id);
    assert.equal(r.json.surface.components.some((c: any) => /Question$/.test(c.component)), false);
  });

  test('辞書に当たれば辞書の科目が先頭（確信度が低くても）、支払手段も入る。提案者は dictionary', async () => {
    upsertVendorRule(db, { name: 'カフェ・ドゥ・テスト', accountId: ACC.travel, taxCategory: 'taxable_10', creditAccount: 'card:credit_card:7', origin: 'learned', hitCount: 2, confidence: 0.4 });
    const id = addDoc();
    addExtraction(id, {}, [GEMINI]);
    const r = await getCard(id);
    const chips = comp(r.json, 'AccountChips');
    assert.equal(chips.candidates[0].account_id, ACC.travel);
    assert.equal(chips.candidates.length, 3);
    assert.equal(r.json.dataModel.sources.account_id, 'dictionary');
    assert.equal(r.json.dataModel.values.payment, 'card:credit_card:7');
    assert.equal(r.json.dataModel.sources.payment, 'dictionary');
    assert.equal(audits('ai.proposed')[0].actor, 'dictionary');
  });

  test('命令文や HTML の入った取引先名・不正な登録番号でもカタログに適合し、文字列はそのまま（データ）として返す', async () => {
    const id = addDoc();
    addExtraction(id, { vendor: '<script>alert(1)</script><img src=http://x/a.png>​', reg: REG, txn_date: '2026-02-30', amount: -5 }, [GEMINI]);
    const r = await getCard(id);
    assert.equal(r.status, 200);
    assert.deepEqual(validateSchema(CATALOG, r.json.surface), []);
    const v = comp(r.json, 'VendorField');
    assert.equal(v.name, '<script>alert(1)</script><img src=http://x/a.png>');
    assert.equal(v.invoice_reg_no, null);
    assert.equal(comp(r.json, 'DateField').value, null);
    assert.equal(comp(r.json, 'AmountField').total, null);
  });

  test('no_ai（抽出なし）でも空のカードを返し、提案ではないので ai.proposed は残さない', async () => {
    const id = addDoc({ noAi: true, status: 'received' });
    const r = await getCard(id);
    assert.equal(r.status, 200);
    assert.deepEqual(validateSchema(CATALOG, r.json.surface), []);
    assert.equal(r.json.dataModel.no_ai, true);
    assert.deepEqual(comp(r.json, 'AccountChips').candidates, []);
    assert.equal(audits('ai.proposed').length, 0);
  });

  test('無い文書は 404', async () => {
    assert.equal((await getCard('NOPE')).status, 404);
  });
});

describe('GET /api/documents/:id/thumbnail', () => {
  test('JPEG を縮めて返す（メタデータなし）。PDF と無い文書は 404', async () => {
    const big = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#ffffff' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'x' } } }).toBuffer();
    const put = await putObject(objectsDir, big);
    const id = addDoc({ sha256: put.sha256 });
    const res = await app.request(`/api/documents/${id}/thumbnail`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.equal(meta.width, 640);
    assert.equal(meta.exif, undefined);
    const pdf = addDoc({ mime: 'application/pdf' });
    assert.equal((await app.request(`/api/documents/${pdf}/thumbnail`)).status, 404);
    assert.equal((await app.request('/api/documents/NOPE/thumbnail')).status, 404);
  });
});

describe('POST /api/documents/:id/approve 他（T2-8・T2-9）', () => {
  async function ready(opts: { dict?: boolean } = {}) {
    if (opts.dict) upsertVendorRule(db, { name: 'カフェ・ドゥ・テスト', accountId: ACC.meeting, taxCategory: 'taxable_10', creditAccount: 'owner', origin: 'learned', hitCount: 1 });
    const id = addDoc();
    addExtraction(id, {}, [GEMINI]);
    const card = (await getCard(id)).json;
    return { id, card };
  }

  test('U8: 辞書に当たったカードは差分なしの 1 タップで確定できる。人の確定として 1 版・監査・ジョブ・状態', async () => {
    const { id, card } = await ready({ dict: true });
    const r = await act(id, 'approve', { card_id: card.card_id, expected_version: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.version, 1);
    assert.equal(r.json.status, 'approved');
    assert.deepEqual(r.json.changed, []);
    assert.deepEqual(r.json.jobs, ['update_receipt_meta', 'send_deal']);
    assert.deepEqual(jobs(), ['update_receipt_meta', 'send_deal']);
    assert.equal(status(id), 'approved');
    const rv = db.prepare('SELECT * FROM reviews WHERE document_id = ?').get(id) as Record<string, any>;
    assert.equal(rv.decision, 'approve');
    assert.equal(rv.account_id, ACC.meeting);
    assert.equal(rv.tax_id, 'taxable_10');
    assert.equal(rv.credit_account, 'owner');
    assert.equal(rv.amount, 1100);
    assert.equal(rv.vendor, 'カフェ・ドゥ・テスト');
    assert.equal(rv.proration_pct, 100);
    assert.equal(rv.qualified_invoice, 0);
    assert.equal(rv.based_on_ai_turn_id, `AT${id}`);
    assert.deepEqual(JSON.parse(rv.tax_by_rate_json), [{ category: '10', amount_incl_tax: 1100, tax: 100 }]);
    const src = JSON.parse(rv.field_sources_json);
    assert.equal(src.account_id, 'dictionary');
    assert.equal(src.payment, 'dictionary');
    assert.equal(src.amount, 'ocr');
    assert.equal(src.memo, null);
    const a = audits('user.confirmed');
    assert.equal(a.length, 1);
    assert.equal(a[0].actor, 'user');
    const pl = JSON.parse(a[0].payload_json);
    assert.equal(pl.unchanged, true);
    assert.equal(pl.version, 1);
    assert.equal((db.prepare('SELECT status FROM ui_cards WHERE id = ?').get(card.card_id) as any).status, 'answered');
    // 学習（辞書の科目が同じなので hit_count + 1）
    assert.equal(r.json.learned.op, 'hit');
    assert.equal(r.json.learned.hit_count, 2);
    assert.equal(audits('rule.learned').length, 1);
    assert.deepEqual(verifyAudit(db).ok, true);
  });

  test('第 2 候補に変えると user.overrode、出所は human。提案との食い違いを数える', async () => {
    const { id, card } = await ready();
    const r = await act(id, 'approve', { card_id: card.card_id, expected_version: 0, values: { account_id: ACC.supplies, payment: 'cash', memo: '  文具\n' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.changed, ['account_id', 'payment', 'memo']);
    const rv = db.prepare('SELECT * FROM reviews WHERE document_id = ?').get(id) as Record<string, any>;
    assert.equal(rv.memo, '文具');
    const src = JSON.parse(rv.field_sources_json);
    assert.equal(src.account_id, 'human');
    assert.equal(src.tax_id, 'ai');
    assert.equal(audits('user.overrode').length, 1);
    const rule = db.prepare('SELECT * FROM vendor_rules').get() as Record<string, any>;
    assert.equal(rule.account_id, ACC.supplies);
    assert.equal(rule.origin, 'learned');
    assert.equal(rule.hit_count, 1);
    assert.equal(rule.mismatch_count, 1);
    assert.equal(rule.credit_account, 'cash');
  });

  test('expected_version の食い違いは 409。答えたカードで再び確定すると 409（stale_card）。新しいカードなら版 2', async () => {
    const { id, card } = await ready({ dict: true });
    assert.equal((await act(id, 'approve', { card_id: card.card_id, expected_version: 1 })).status, 409);
    assert.equal((await act(id, 'approve', { card_id: card.card_id, expected_version: 0 })).status, 200);
    const again = await act(id, 'approve', { card_id: card.card_id, expected_version: 1 });
    assert.equal(again.status, 409);
    assert.equal(again.json.reason, 'stale_card');
    const stale = await act(id, 'approve', { card_id: card.card_id, expected_version: 0 });
    assert.equal(stale.json.reason, 'version_conflict');
    assert.equal(stale.json.current_version, 1);
    const card2 = (await getCard(id)).json;
    assert.notEqual(card2.card_id, card.card_id);
    assert.equal(card2.dataModel.version, 1);
    assert.equal(card2.dataModel.sources.account_id, 'dictionary'); // 確定の版の出所から始まる
    assert.equal(audits('ai.proposed').length, 1); // 確定の版から作ったカードは提案ではない
    const r = await act(id, 'approve', { card_id: card2.card_id, expected_version: 1, values: { amount: 1200, tax_by_rate: [{ category: 'taxable_10', amount_incl_tax: 1200, tax: 109 }] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 2);
    assert.deepEqual(r.json.warnings, []);
    assert.equal((db.prepare('SELECT count(*) n FROM reviews').get() as any).n, 2);
  });

  test('取引ビルダが拒否する入力は approve で 422 not_sendable（内訳 0 円・内訳の和 ≠ 合計）。内訳が空なら合計だけで可', async () => {
    const { id, card } = await ready({ dict: true });
    const base = { card_id: card.card_id, expected_version: 0 };
    const mismatch = await act(id, 'approve', { ...base, values: { amount: 1200 } });
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.json.reason, 'not_sendable');
    assert.match(mismatch.json.messages[0], /内訳の合計（1100 円）が支払金額（1200 円）と合いません/);
    const zero = await act(id, 'approve', {
      ...base,
      values: { tax_by_rate: [{ category: 'taxable_10', amount_incl_tax: 1100, tax: 100 }, { category: 'taxable_8_reduced', amount_incl_tax: 0, tax: 0 }] },
    });
    assert.equal(zero.status, 422);
    assert.match(zero.json.messages[0], /2 行目の金額が 0 円/);
    const prorate = await act(id, 'approve', { ...base, values: { proration_pct: 50.5 } });
    assert.equal(prorate.status, 422); // 型の検証で先に止まる
    assert.equal(jobs().length, 0);
    // approve 以外は警告だけ
    const rej = await act(id, 'reject', { ...base, values: { amount: 1200 } });
    assert.equal(rej.status, 200);
    assert.deepEqual(rej.json.warnings, ['amount_mismatch']);
    // 内訳が空なら合計だけで送れる
    const card2 = (await getCard(id)).json;
    const ok = await act(id, 'approve', { card_id: card2.card_id, expected_version: 1, values: { amount: 1200, tax_by_rate: [] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });

  test('税率の区分を変えると、内訳が 1 行ならその区分に揃えて保存する。複数行なら 422', async () => {
    const { id, card } = await ready({ dict: true });
    const r = await act(id, 'approve', { card_id: card.card_id, expected_version: 0, values: { tax_id: 'taxable_8_reduced' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.changed.includes('tax_by_rate'));
    const rv = db.prepare('SELECT tax_id, tax_by_rate_json, field_sources_json FROM reviews WHERE document_id = ?').get(id) as any;
    assert.equal(rv.tax_id, 'taxable_8_reduced');
    assert.deepEqual(JSON.parse(rv.tax_by_rate_json), [{ category: '8r', amount_incl_tax: 1100, tax: 100 }]);
    assert.equal(JSON.parse(rv.field_sources_json).tax_by_rate, 'human');

    const id2 = addDoc();
    addExtraction(id2, { vendor: '別の店', by_rate: [{ category: 'taxable_10', amount_incl_tax: 600, tax: 54 }, { category: 'taxable_8_reduced', amount_incl_tax: 500, tax: 37 }] }, [GEMINI]);
    const c2 = (await getCard(id2)).json;
    const bad = await act(id2, 'approve', { card_id: c2.card_id, expected_version: 0, values: { tax_id: 'taxable_8_reduced', payment: 'cash' } });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.reason, 'not_sendable');
    assert.match(bad.json.messages[0], /内訳を直してください/);
  });

  test('R10: approve で必須（日付・金額・取引先・科目・税・支払手段）が欠けると 422', async () => {
    const { id, card } = await ready();
    const r = await act(id, 'approve', { card_id: card.card_id, expected_version: 0, values: { txn_date: null } });
    assert.equal(r.status, 422);
    assert.equal(r.json.reason, 'missing_required');
    assert.deepEqual(r.json.fields, ['txn_date', 'payment']);
    assert.equal((db.prepare('SELECT count(*) n FROM reviews').get() as any).n, 0);
    assert.deepEqual(jobs(), []);
  });

  test('値はサーバーで再検証する（enum 外・形式・範囲・未知の項目）', async () => {
    const { id, card } = await ready();
    const bad = [
      { account_id: '900' },
      { account_id: 'x' },
      { tax_id: 'taxable_5' },
      { payment: 'card:bank:1' },
      { txn_date: '2026/10/14' },
      { amount: -1 },
      { amount: 1.5 },
      { invoice_reg_no: REG },
      { invoice_reg_no: 'T123' },
      { qualified_invoice: true, invoice_reg_no: null },
      { proration_pct: 101 },
      { tax_by_rate: [{ category: 'taxable_10', amount_incl_tax: -1, tax: 0 }] },
      { vendor: 3 },
      { hack: 1 },
    ];
    for (const values of bad) {
      const r = await act(id, 'approve', { card_id: card.card_id, expected_version: 0, values: { payment: 'cash', ...values } });
      assert.equal(r.status, 422, JSON.stringify(values));
      assert.equal(r.json.reason, 'invalid_values');
    }
    assert.equal((await act(id, 'approve', { expected_version: 0 })).status, 400);
    assert.equal((await act(id, 'approve', { card_id: card.card_id })).status, 400);
    assert.equal((await act(id, 'approve', { card_id: 'NOPE', expected_version: 0 })).status, 400);
    assert.equal((await act('NOPE', 'approve', { card_id: card.card_id, expected_version: 0 })).status, 404);
    const res = await app.request(`/api/documents/${id}/approve`, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 400);
    // 登録番号（検査数字が合うもの）と按分は受け付ける
    const ok = await act(id, 'approve', { card_id: card.card_id, expected_version: 0, values: { payment: 'card:credit_card:7', invoice_reg_no: validReg, proration_pct: 50 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const rv = db.prepare('SELECT * FROM reviews').get() as Record<string, any>;
    assert.equal(rv.invoice_reg_no, validReg);
    assert.equal(rv.qualified_invoice, 1);
    assert.equal(rv.proration_pct, 50);
    assert.equal(rv.credit_account, 'card:credit_card:7');
  });

  test('mark_private: 事業主貸・対象外で確定し、私用として学習する。ジョブは積まない', async () => {
    const { id, card } = await ready();
    const r = await act(id, 'mark_private', { card_id: card.card_id, expected_version: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, 'personal');
    assert.deepEqual(jobs(), []);
    const rv = db.prepare('SELECT * FROM reviews').get() as Record<string, any>;
    assert.equal(rv.decision, 'personal');
    assert.equal(rv.account_id, ACC.priv);
    assert.equal(rv.tax_id, 'out_of_scope');
    const rule = db.prepare('SELECT * FROM vendor_rules').get() as Record<string, any>;
    assert.equal(rule.account_id, ACC.priv);
    assert.equal(rule.tax_id, 'out_of_scope');
  });

  test('reject・mark_duplicate: 状態だけ変わり、ジョブも学習も無い。必須の欠けも許す', async () => {
    for (const [action, st, dec] of [
      ['reject', 'rejected', 'reject'],
      ['mark_duplicate', 'duplicate', 'duplicate'],
    ] as const) {
      const id = addDoc();
      addExtraction(id, { txn_date: null }, [GEMINI]);
      const card = (await getCard(id)).json;
      const r = await act(id, action, { card_id: card.card_id, expected_version: 0 });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(status(id), st);
      assert.equal((db.prepare('SELECT decision FROM reviews WHERE document_id = ?').get(id) as any).decision, dec);
      assert.equal(r.json.learned, null);
    }
    assert.deepEqual(jobs(), []);
    assert.equal((db.prepare('SELECT count(*) n FROM vendor_rules').get() as any).n, 0);
  });

  test('needs_attention の文書は確定しても状態を残す', async () => {
    const id = addDoc({ status: 'needs_attention' });
    addExtraction(id, {}, [GEMINI]);
    const card = (await getCard(id)).json;
    const r = await act(id, 'approve', { card_id: card.card_id, expected_version: 0, values: { payment: 'cash' } });
    assert.equal(r.status, 200);
    assert.equal(status(id), 'needs_attention');
  });

  test('同じ取引先を 3 回確定すると hit_count = 3。manual のルールは上書きしない', async () => {
    for (let i = 0; i < 3; i++) {
      const id = addDoc();
      addExtraction(id, { vendor: 'ラーメン山田' }, [GEMINI]);
      const card = (await getCard(id)).json;
      const r = await act(id, 'approve', { card_id: card.card_id, expected_version: 0, values: { payment: 'cash' } });
      assert.equal(r.status, 200);
    }
    const rule = db.prepare(`SELECT * FROM vendor_rules`).get() as Record<string, any>;
    assert.equal(rule.hit_count, 3);
    assert.equal(rule.origin, 'learned');

    upsertVendorRule(db, { name: '手動商店', accountId: ACC.travel, taxCategory: 'taxable_10', origin: 'manual', hitCount: 5 });
    const id = addDoc();
    addExtraction(id, { vendor: '手動商店' }, [GEMINI]);
    const card = (await getCard(id)).json;
    const r = await act(id, 'approve', { card_id: card.card_id, expected_version: 0, values: { account_id: ACC.supplies, payment: 'cash' } });
    assert.equal(r.json.learned.op, 'manual_kept');
    const manual = db.prepare(`SELECT * FROM vendor_rules WHERE origin = 'manual'`).get() as Record<string, any>;
    assert.equal(manual.account_id, ACC.travel);
    assert.equal(manual.hit_count, 5);
    assert.equal(manual.mismatch_count, 1);
  });
});

describe('GET /api/documents（T2-11）', () => {
  test('確認待ちは期限の近い順、要対応は別枠で理由つき、件数 API', async () => {
    const late = addDoc({ deadline: '2026-10-28' });
    const soon = addDoc({ deadline: '2026-10-19' }); // 残り 1 営業日
    const past = addDoc({ deadline: '2026-10-15' }); // 過ぎている
    const att = addDoc({ status: 'needs_attention' });
    appendAudit(db, { actor: 'worker', action: 'document.needs_attention', entity: 'document', entityId: att, payload: { reason: 'upload_rejected' } }, NOW);
    const done = addDoc();
    addExtraction(done, {}, [GEMINI]);
    const card = (await getCard(done)).json;
    await act(done, 'approve', { card_id: card.card_id, expected_version: 0, values: { payment: 'cash' } });

    const rv = (await (await app.request('/api/documents?status=review')).json()) as { items: any[] };
    assert.deepEqual(rv.items.map((i) => i.id), [past, soon, late]);
    assert.deepEqual(rv.items.map((i) => i.days_left), [-1, 1, 8]);
    assert.deepEqual(rv.items.map((i) => i.urgent), [true, true, false]);

    const at = (await (await app.request('/api/documents?status=attention')).json()) as { items: any[] };
    assert.deepEqual(at.items.map((i) => [i.id, i.needs_attention_reason]), [[att, 'upload_rejected']]);

    const ap = (await (await app.request('/api/documents?status=approved')).json()) as { items: any[] };
    assert.deepEqual(ap.items.map((i) => [i.id, i.reviewed]), [[done, true]]);

    const all = (await (await app.request('/api/documents')).json()) as { items: any[] };
    assert.equal(all.items.length, 5);
    assert.equal(all.items[0].id, done); // 新しい順のまま
    assert.equal(typeof all.items[0].paper_required, 'boolean');

    const counts = await (await app.request('/api/documents/counts')).json();
    assert.deepEqual(counts, { review: 3, attention: 1, urgent: 2 });
    assert.equal((await app.request('/api/documents?status=bogus')).status, 400);
  });
});
