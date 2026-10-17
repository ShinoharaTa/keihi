// T0-2' freee 版 PoC（docs/freee-codex.md §3.2・§3.3）。T0-1 のダミー領収書だけを使う。
// F1〜F16 を個別に実行でき、結果を poc/freee-results.md に、作った ID を poc/freee-created.jsonl に書く。
//
//   node tools/poc/freee-poc.ts --dry-run                # API を呼ばずにリクエスト形だけ表示（トークン値は出さない）
//   node tools/poc/freee-poc.ts                          # テスト事業所で F1〜F14・F16
//   node tools/poc/freee-poc.ts --only F3,F4             # 指定した項目だけ
//   node tools/poc/freee-poc.ts --only F11               # 2 回目以降は、画面で確定した後の状態を読むだけ
//   node tools/poc/freee-poc.ts --prod --only F15        # 本番事業所（お試し）で読み取りだけ
//   node tools/poc/freee-poc.ts --cleanup                # freee-created.jsonl に記録した ID だけを削除
//
// 安全側の前提（freee-codex.md §3.2 共通、mvp-plan.md §4.3）:
// - client_id / client_secret は ~/.config/keihi/secrets.env（0600 以外は拒否）の FREEE_CLIENT_ID / FREEE_CLIENT_SECRET。
// - 事業所 ID は ~/.config/keihi/config.toml の [freee] poc_company_id / prod_company_id。
// - 書き込みはテスト事業所だけ。トークンの company_id が poc_company_id と一致しなければ止める。
//   本番事業所は --prod を付けたときだけ、F15 の読み取りだけを、GET 以外を拒否するクライアントで行う。
// - トークンは ~/.config/keihi/freee-token-{poc,prod}.json（0600）にだけ置き、ログ・結果には出さない。
// - 出力は ID・HTTP ステータス・X-Freee-Request-ID・件数と、ダミーに入れた値の照合結果だけ。
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  FreeeAuthError,
  TOKEN_URL,
  TokenStore,
  createTokenProvider,
  refreshWith,
  type ClientCredentials,
  type TokenProvider,
} from '../../src/providers/freee/auth.ts';
import {
  FreeeGuardError,
  createFreeeClient,
  type ApiResponse,
  type FreeeClient,
  type Method,
  type RequestOptions,
} from '../../src/providers/freee/client.ts';
import type { Truth } from '../fixtures/gen-receipts.ts';
import { ACCOUNTS, parseEnv, parseTomlSubset } from './gemini-poc.ts';

export const DEFAULT_CONFIG_DIR = path.join(homedir(), '.config', 'keihi');
export const DEFAULT_FIXTURES_DIR = 'test/fixtures/receipts';
export const DEFAULT_RESULTS = 'poc/freee-results.md';
export const DEFAULT_CREATED = 'poc/freee-created.jsonl';
// §3.1 手作業 6 でユーザーが画面で作る手動口座。
export const POC_CARD = 'keihi-PoC-card';
export const POC_BANK = 'keihi-PoC-bank';
// 取引・ルールに使う科目（テスト事業所が法人でもある名前）。
export const EXPENSE_ACCOUNT = '消耗品費';

export const STEPS = [
  { id: 'F1', title: '認可コード → トークン、users/me、companies', screen: [] },
  { id: 'F2', title: 'トークンの更新と、古いリフレッシュトークンの再利用', screen: [] },
  { id: 'F3', title: 'マスタ（account_items・taxes/codes・walletables・partners）', screen: [] },
  { id: 'F4', title: 'POST /receipts（メタデータなし / あり）', screen: ['電子保存項目の表示', '解像度・書類サイズの推測値'] },
  { id: 'F5', title: 'PUT /receipts/{id}（メタデータと登録番号を後から入れ、2 回直す）', screen: ['変更履歴が残るか'] },
  { id: 'F6', title: 'GET /receipts/{id}/download（sha256・mime_type・429）', screen: [] },
  { id: 'F7', title: 'GET /receipts?category=without_deal と照合キー', screen: [] },
  { id: 'F8', title: 'POST /deals（未決済・receipt_ids・ref_number）', screen: ['証憑の電子保存項目が取引から補完されるか'] },
  { id: 'F9', title: '取引を作ってから PUT /deals/{id} で receipt_ids を紐付け', screen: ['税額の表示（内税に固定されたか）'] },
  { id: 'F10', title: '決済済みの取引（手動のカード口座）と同額の明細', screen: ['「自動で経理」に消込の候補として出るか'] },
  { id: 'F11', title: '未決済の取引 + 同額の明細 → 画面で消込', screen: ['「自動で経理」で消込を推測するか（確定したら --only F11 を再実行）'] },
  { id: 'F12', title: 'user_matchers（act=4 / 11 / 0）と一致する明細', screen: ['明細の画面でルールの適用の表示'] },
  { id: 'F13', title: '削除（紐付き中の証憑・紐付いていない証憑・取引・ルール）', screen: ['削除済みの表示', '履歴'] },
  { id: 'F14', title: 'ファイルの種類と大きさ（JPEG・PNG・PDF・HEIC・6MB・20MB）', screen: [] },
  { id: 'F15', title: '本番事業所（お試し）で読み取りだけ', screen: ['カードの速報が出るか'] },
  { id: 'F16', title: 'レート制限のヘッダと呼び出し数', screen: [] },
] as const;
export type StepId = (typeof STEPS)[number]['id'];
const STEP_IDS = STEPS.map((s) => s.id) as readonly string[];

// ---- 設定とシークレット ----

export type FreeeConfig = { pocCompanyId: number | null; prodCompanyId: number | null };

export async function loadFreeeConfig(configDir: string): Promise<FreeeConfig> {
  let src: string;
  try {
    src = await readFile(path.join(configDir, 'config.toml'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { pocCompanyId: null, prodCompanyId: null };
    throw e;
  }
  const f = parseTomlSubset(src).freee ?? {};
  const id = (k: string): number | null => {
    const v = f[k];
    if (v === undefined) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`config.toml の freee.${k} は正の整数で指定する`);
    return v;
  };
  return { pocCompanyId: id('poc_company_id'), prodCompanyId: id('prod_company_id') };
}

export async function loadFreeeCredentials(configDir: string): Promise<ClientCredentials> {
  const secretsPath = path.join(configDir, 'secrets.env');
  let st;
  try {
    st = await stat(secretsPath);
  } catch {
    throw new Error(`${secretsPath} が無い`);
  }
  if (!st.isFile()) throw new Error(`${secretsPath} が通常のファイルではない`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${secretsPath} のパーミッションが 0600 ではない（現在 0${mode.toString(8)}）。chmod 600 してから実行する`);
  }
  const env = parseEnv(await readFile(secretsPath, 'utf8'));
  if (!env.FREEE_CLIENT_ID) throw new Error(`${secretsPath} に FREEE_CLIENT_ID が無い`);
  if (!env.FREEE_CLIENT_SECRET) throw new Error(`${secretsPath} に FREEE_CLIENT_SECRET が無い`);
  return { clientId: env.FREEE_CLIENT_ID, clientSecret: env.FREEE_CLIENT_SECRET };
}

export type Target = 'poc' | 'prod';
export const tokenFile = (configDir: string, target: Target) => path.join(configDir, `freee-token-${target}.json`);

// ---- 秘密の伏せ字 ----

export type Redactor = { add(v: string | null | undefined): void; apply(s: string): string };

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  return {
    add(v) {
      if (v && v.length >= 6) secrets.add(v);
    },
    apply(s) {
      let out = s;
      for (const v of secrets) out = out.split(v).join('***');
      return out;
    },
  };
}

// ---- 作成した ID の記録（追記のみ） ----

export type CreatedType = 'deal' | 'receipt' | 'wallet_txn' | 'user_matcher';
export type CreatedEntry = { op: 'created' | 'deleted'; type: CreatedType; id: number; company_id: number; step: string; at: string };

export const ENTITY_PATH: Record<CreatedType, string> = {
  deal: '/api/1/deals',
  receipt: '/api/1/receipts',
  wallet_txn: '/api/1/wallet_txns',
  user_matcher: '/api/1/user_matchers',
};
// §3.3: 取引 → 証憑 → 明細 → ルールの順に消す（種類の中では新しいものから）。
export const CLEANUP_ORDER: CreatedType[] = ['deal', 'receipt', 'wallet_txn', 'user_matcher'];

export class CreatedLog {
  readonly file: string;
  readonly dryRun: boolean;
  constructor(file: string, opts: { dryRun: boolean }) {
    this.file = file;
    this.dryRun = opts.dryRun;
  }
  async readAll(): Promise<CreatedEntry[]> {
    let src: string;
    try {
      src = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    return src
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as CreatedEntry);
  }
  async append(e: CreatedEntry): Promise<void> {
    if (this.dryRun) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(e) + '\n');
  }
  // まだ消していないもの（作成順）。
  async outstanding(companyId: number): Promise<CreatedEntry[]> {
    const all = await this.readAll();
    const deleted = new Set(all.filter((e) => e.op === 'deleted').map((e) => `${e.company_id}:${e.type}:${e.id}`));
    return all.filter((e) => e.op === 'created' && e.company_id === companyId && !deleted.has(`${e.company_id}:${e.type}:${e.id}`));
  }
}

// ---- 実行の文脈と記録 ----

export type CallRec = { label: string; method: string; path: string; status: number; requestId: string | null };
export type StepResult = { id: string; title: string; calls: CallRec[]; notes: string[]; error: string | null };

type Masters = {
  accountItems: Record<string, unknown>[];
  taxes: Record<string, unknown>[];
  walletables: Record<string, unknown>[];
  expense: { id: number; taxCode: number } | null;
  taxName: string | null;
  card: { id: number } | null;
  bank: { id: number } | null;
};

type Uploaded = { id: number | null; bytes: Buffer; truth: Truth; res: ApiResponse };

export type Ctx = {
  client: FreeeClient;
  companyId: number;
  dryRun: boolean;
  fixturesDir: string;
  runId: string;
  stamp: string;
  today: string;
  created: CreatedLog;
  log: (s: string) => void;
  redactor: Redactor;
  heic: string | null;
  auth: { store: TokenStore | null; creds: ClientCredentials; fetch: typeof fetch };
  cache: { masters?: Masters; receipts: Map<string, Uploaded> };
  rate: { headers: Map<string, string>; total: number; byStep: Map<string, number> };
  cur: StepResult;
};

const RATE_HEADER = /^(x-ratelimit-|retry-after$)/i;

async function call(ctx: Ctx, label: string, method: Method, p: string, opts: RequestOptions = {}): Promise<ApiResponse> {
  const res = await ctx.client.request(method, p, opts);
  ctx.cur.calls.push({ label, method, path: p, status: res.status, requestId: res.requestId });
  ctx.rate.total++;
  ctx.rate.byStep.set(ctx.cur.id, (ctx.rate.byStep.get(ctx.cur.id) ?? 0) + 1);
  res.headers.forEach((v, k) => {
    if (RATE_HEADER.test(k)) ctx.rate.headers.set(k.toLowerCase(), v);
  });
  ctx.log(`${ctx.cur.id} ${label}: ${method} ${p} → ${res.status}${res.requestId ? ` req=${res.requestId}` : ''}`);
  return res;
}

const note = (ctx: Ctx, s: string) => {
  ctx.cur.notes.push(s);
  ctx.log(`${ctx.cur.id}   ${s}`);
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// freee のエラー本文から最初のメッセージだけ取り出す（個人情報を含まない定型文）。
export function errorMessage(json: unknown): string {
  const o = obj(json);
  const errs = arr(o.errors);
  const msgs = errs.flatMap((e) => (Array.isArray(e.messages) ? e.messages.map(String) : []));
  const m = msgs[0] ?? (typeof o.message === 'string' ? o.message : '');
  return m.slice(0, 120);
}

const statusText = (res: ApiResponse) => `${res.status}${res.ok ? '' : ` ${errorMessage(res.json)}`}`.trim();

async function record(ctx: Ctx, type: CreatedType, id: number | null): Promise<void> {
  if (id === null) return;
  await ctx.created.append({ op: 'created', type, id, company_id: ctx.companyId, step: ctx.cur.id, at: new Date().toISOString() });
}

async function markDeleted(ctx: { created: CreatedLog; companyId: number }, type: CreatedType, id: number, step: string): Promise<void> {
  await ctx.created.append({ op: 'deleted', type, id, company_id: ctx.companyId, step, at: new Date().toISOString() });
}

// ---- フィクスチャ ----

export async function loadTruth(dir: string, file: string): Promise<{ truth: Truth; bytes: Buffer }> {
  const base = file.replace(/\.[^.]+$/, '');
  const truth = JSON.parse(await readFile(path.join(dir, `${base}.truth.json`), 'utf8')) as Truth;
  return { truth, bytes: await readFile(path.join(dir, file)) };
}

export function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.heic' || ext === '.heif') return 'image/heic';
  throw new Error(`未対応の形式: ${ext}`);
}

// JPEG の SOI の直後に COM セグメント（ダミーの文字列）を足して、ちょうど size バイトにする。画像データは変えない。
export function padJpegTo(buf: Buffer, size: number): Buffer {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('JPEG ではない');
  let need = size - buf.length;
  if (need < 0) throw new Error('元のファイルが目標より大きい');
  const fill = Buffer.from('TEST / DUMMY PADDING ');
  const segs: Buffer[] = [];
  const MAX = 2 + 65535; // マーカー 2 バイト + 長さ（長さ 2 バイトを含む）最大 65535
  while (need > 0) {
    let n = Math.min(need, MAX);
    // 最後に 4 バイト未満が残らないようにする（COM の最小は 4 バイト）。
    if (need - n > 0 && need - n < 4) n -= 4;
    if (n < 4) throw new Error('差が 4 バイト未満で合わせられない');
    const seg = Buffer.alloc(n);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg.writeUInt16BE(n - 2, 2);
    for (let i = 4; i < n; i++) seg[i] = fill[(i - 4) % fill.length];
    segs.push(seg);
    need -= n;
  }
  return Buffer.concat([buf.subarray(0, 2), ...segs, buf.subarray(2)]);
}

// ---- 共通の操作 ----

// key ごとの証憑。同じ実行の中では使い回し、無ければ上げる。
const RECEIPT_SPECS: Record<string, { file: string; meta: boolean }> = {
  F4a: { file: 'r01_receipt58.jpg', meta: false },
  F4b: { file: 'r02_receipt58.png', meta: true },
};

function metaFields(t: Truth): Record<string, string> {
  return {
    receipt_metadatum_partner_name: t.vendor,
    receipt_metadatum_issue_date: t.date,
    receipt_metadatum_amount: String(t.total),
    document_type: t.kind === 'invoice_a4' ? 'invoice' : 'receipt',
    qualified_invoice: t.registration_number ? 'qualified' : 'not_qualified',
  };
}

async function uploadReceipt(
  ctx: Ctx,
  label: string,
  file: string,
  opts: { meta?: boolean; description?: string; bytes?: Buffer; truth?: Truth; name?: string } = {},
): Promise<Uploaded> {
  const loaded = opts.bytes && opts.truth ? { bytes: opts.bytes, truth: opts.truth } : await loadTruth(ctx.fixturesDir, file);
  const name = opts.name ?? file;
  const form = new FormData();
  form.set('company_id', String(ctx.companyId));
  form.set('receipt', new Blob([new Uint8Array(loaded.bytes)], { type: mimeOf(name) }), name);
  form.set('description', opts.description ?? `${ctx.runId}-${label}`);
  if (opts.meta) for (const [k, v] of Object.entries(metaFields(loaded.truth))) form.set(k, v);
  const res = await call(ctx, label, 'POST', '/api/1/receipts', { form });
  const id = res.ok ? num(obj(obj(res.json).receipt).id) : null;
  await record(ctx, 'receipt', id);
  return { id, bytes: loaded.bytes, truth: loaded.truth, res };
}

async function ensureReceipt(ctx: Ctx, key: string): Promise<Uploaded> {
  const hit = ctx.cache.receipts.get(key);
  if (hit && hit.id !== null) return hit;
  const spec = RECEIPT_SPECS[key];
  const up = await uploadReceipt(ctx, key, spec.file, { meta: spec.meta });
  ctx.cache.receipts.set(key, up);
  return up;
}

async function ensureMasters(ctx: Ctx, force = false): Promise<Masters> {
  if (ctx.cache.masters && !force) return ctx.cache.masters;
  const q = { company_id: ctx.companyId };
  const ai = await call(ctx, 'account_items', 'GET', '/api/1/account_items', { query: q });
  const tx = await call(ctx, 'taxes/codes', 'GET', '/api/1/taxes/codes');
  const wl = await call(ctx, 'walletables', 'GET', '/api/1/walletables', { query: q });
  const accountItems = arr(obj(ai.json).account_items);
  const taxes = arr(obj(tx.json).taxes);
  const walletables = arr(obj(wl.json).walletables);
  const e = accountItems.find((a) => a.name === EXPENSE_ACCOUNT);
  const expense = e && num(e.id) !== null && num(e.default_tax_code) !== null ? { id: num(e.id)!, taxCode: num(e.default_tax_code)! } : null;
  const tax = expense ? taxes.find((t) => num(t.code) === expense.taxCode) : undefined;
  const pick = (name: string, type: string) => {
    const w = walletables.find((x) => x.name === name && x.type === type);
    return w && num(w.id) !== null ? { id: num(w.id)! } : null;
  };
  ctx.cache.masters = {
    accountItems,
    taxes,
    walletables,
    expense,
    taxName: tax && typeof tax.name_ja === 'string' ? tax.name_ja : null,
    card: pick(POC_CARD, 'credit_card'),
    bank: pick(POC_BANK, 'bank_account'),
  };
  return ctx.cache.masters;
}

function requireExpense(m: Masters): { id: number; taxCode: number } {
  if (!m.expense) throw new Error(`勘定科目「${EXPENSE_ACCOUNT}」がマスタに無い`);
  return m.expense;
}
function requireCard(m: Masters): { id: number } {
  if (!m.card) throw new Error(`手動のカード口座「${POC_CARD}」が無い（§3.1 手作業 6）`);
  return m.card;
}

async function createDeal(
  ctx: Ctx,
  label: string,
  truth: Truth,
  opts: { receiptIds?: number[]; cardId?: number } = {},
): Promise<{ id: number | null; res: ApiResponse }> {
  const m = await ensureMasters(ctx);
  const ex = requireExpense(m);
  const body: Record<string, unknown> = {
    company_id: ctx.companyId,
    issue_date: truth.date,
    type: 'expense',
    ref_number: `${ctx.runId}-${label}`,
    details: [{ account_item_id: ex.id, tax_code: ex.taxCode, amount: truth.total, description: `${ctx.runId} ダミー ${truth.vendor}` }],
  };
  if (opts.receiptIds) body.receipt_ids = opts.receiptIds;
  if (opts.cardId !== undefined) {
    body.payments = [{ date: truth.date, from_walletable_type: 'credit_card', from_walletable_id: opts.cardId, amount: truth.total }];
  }
  const res = await call(ctx, label, 'POST', '/api/1/deals', { json: body });
  const id = res.ok ? num(obj(obj(res.json).deal).id) : null;
  await record(ctx, 'deal', id);
  return { id, res };
}

async function createWalletTxn(
  ctx: Ctx,
  label: string,
  t: { date: string; amount: number; description: string; walletableId: number },
): Promise<{ id: number | null; res: ApiResponse }> {
  const res = await call(ctx, label, 'POST', '/api/1/wallet_txns', {
    json: {
      company_id: ctx.companyId,
      entry_side: 'expense',
      walletable_type: 'credit_card',
      walletable_id: t.walletableId,
      date: t.date,
      amount: t.amount,
      description: t.description,
    },
  });
  const id = res.ok ? num(obj(obj(res.json).wallet_txn).id) : null;
  await record(ctx, 'wallet_txn', id);
  return { id, res };
}

async function createRule(
  ctx: Ctx,
  label: string,
  r: { act: number; description: string; extra?: Record<string, unknown> },
  opts: { record?: boolean } = {},
): Promise<{ id: number | null; res: ApiResponse }> {
  const res = await call(ctx, label, 'POST', '/api/1/user_matchers', {
    query: { company_id: ctx.companyId },
    json: {
      act: r.act,
      active: true,
      condition: 0, // 部分一致
      description: r.description,
      entry_side_str: 'expense',
      priority: 0,
      walletable: POC_CARD,
      ...r.extra,
    },
  });
  const id = res.ok ? num(obj(res.json).id) : null;
  if (opts.record !== false) await record(ctx, 'user_matcher', id);
  return { id, res };
}

async function deleteEntity(ctx: Ctx, label: string, type: CreatedType, id: number): Promise<ApiResponse> {
  const res = await call(ctx, label, 'DELETE', `${ENTITY_PATH[type]}/${id}`, { query: { company_id: ctx.companyId } });
  if (res.ok || res.status === 404) await markDeleted(ctx, type, id, ctx.cur.id);
  return res;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function countBy(xs: Record<string, unknown>[], k: string): string {
  const m = new Map<string, number>();
  for (const x of xs) m.set(String(x[k]), (m.get(String(x[k])) ?? 0) + 1);
  return [...m.entries()].map(([v, n]) => `${v}:${n}`).join(' ') || '（なし）';
}

// 明細の description の「形式だけ」（F15）。漢字かな→J、英字→A、数字→9、空白→_、記号はそのまま。長さは 24 文字で切る。
export function shapeOf(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFKC')) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|ー/u.test(ch)) out += 'J';
    else if (/[A-Za-z]/.test(ch)) out += 'A';
    else if (/[0-9]/.test(ch)) out += '9';
    else if (/\s/.test(ch)) out += '_';
    else if (/[\p{P}\p{S}]/u.test(ch)) out += ch;
    else out += '?';
  }
  out = out.replace(/(.)\1+/g, (m, c: string) => `${c}{${m.length}}`);
  return out.length > 24 ? `${out.slice(0, 24)}…` : out;
}

// ---- F1〜F16 ----

const step: Record<StepId, (ctx: Ctx) => Promise<void>> = {
  async F1(ctx) {
    if (ctx.auth.store) {
      const t = await ctx.auth.store.read();
      if (t) {
        note(ctx, `token: expires_in=${t.expires_in}（6 時間 = 21600 と${t.expires_in === 21600 ? '一致' : '不一致'}）`);
        note(ctx, `token: company_id=${t.company_id ?? 'なし'}（設定の事業所 ID と${t.company_id === ctx.companyId ? '一致' : '不一致'}）`);
      }
    } else {
      note(ctx, 'dry-run: トークンファイルは読まない');
    }
    const me = await call(ctx, 'users/me', 'GET', '/api/1/users/me', { query: { companies: true } });
    note(ctx, `users/me: ${statusText(me)}、事業所 ${arr(obj(obj(me.json).user).companies).length} 件`);
    const cs = await call(ctx, 'companies', 'GET', '/api/1/companies');
    const list = arr(obj(cs.json).companies);
    const mine = list.find((c) => num(c.id) === ctx.companyId);
    note(ctx, `companies: ${statusText(cs)}、${list.length} 件、設定の事業所 ${mine ? `あり（role=${String(mine.role)}）` : 'なし'}`);
  },

  async F2(ctx) {
    const { creds, fetch: f } = ctx.auth;
    const rec = (label: string, status: number) => {
      ctx.cur.calls.push({ label, method: 'POST', path: '/public_api/token', status, requestId: null });
      ctx.log(`${ctx.cur.id} ${label}: POST ${TOKEN_URL} → ${status}`);
    };
    const attempt = async (label: string, refreshToken: string) => {
      try {
        const t = await refreshWith(creds, refreshToken, { fetch: f });
        ctx.redactor.add(t.access_token);
        ctx.redactor.add(t.refresh_token);
        rec(label, 200);
        return { ok: true as const, token: t };
      } catch (e) {
        if (!(e instanceof FreeeAuthError)) throw e;
        rec(label, e.status ?? 0);
        return { ok: false as const, status: e.status, error: e.error };
      }
    };
    const store = ctx.auth.store;
    if (!store) {
      await attempt('refresh(1)', 'DRY-RUN-REFRESH-TOKEN');
      await attempt('refresh(old)', 'DRY-RUN-REFRESH-TOKEN');
      note(ctx, 'dry-run: トークンファイルは更新しない');
      return;
    }
    await store.withLock(async () => {
      const old = await store.read();
      if (!old) throw new Error(`${store.path} が無い`);
      const first = await attempt('refresh(1)', old.refresh_token);
      if (!first.ok) {
        note(ctx, `1 回目の更新が失敗: ${first.status} ${first.error ?? ''}（再認可が要る）`);
        return;
      }
      // 新しいリフレッシュトークンを先に保存する（古い方はもう使えない前提）。
      if (first.token.company_id === null) first.token.company_id = old.company_id;
      await store.write(first.token);
      note(ctx, `1 回目: 成功。expires_in=${first.token.expires_in}、リフレッシュトークンが${first.token.refresh_token === old.refresh_token ? '同じ' : '新しくなった'}`);
      const second = await attempt('refresh(old)', old.refresh_token);
      if (second.ok) {
        if (second.token.company_id === null) second.token.company_id = old.company_id;
        await store.write(second.token);
        note(ctx, '古いリフレッシュトークンの再利用: **成功した**（1 回限りではなかった）。2 回目の応答を保存した');
      } else {
        note(ctx, `古いリフレッシュトークンの再利用: 失敗 ${second.status} error=${second.error ?? '（なし）'}（invalid_grant を含むか: ${second.error === 'invalid_grant' ? 'はい' : 'いいえ'}）`);
      }
    });
  },

  async F3(ctx) {
    const m = await ensureMasters(ctx, true);
    const pt = await call(ctx, 'partners', 'GET', '/api/1/partners', { query: { company_id: ctx.companyId } });
    note(ctx, `account_items ${m.accountItems.length} 件、taxes/codes ${m.taxes.length} 件、walletables ${m.walletables.length} 件（${countBy(m.walletables, 'type')}）、partners ${arr(obj(pt.json).partners).length} 件（${statusText(pt)}）`);
    const names = new Set(m.accountItems.map((a) => a.name));
    const missing = ACCOUNTS.filter((a) => !names.has(a));
    note(ctx, `D11 の科目 ${ACCOUNTS.length} 件のうち同名が無いもの ${missing.length} 件: ${missing.join('、') || '（なし）'}`);
    note(ctx, `「${EXPENSE_ACCOUNT}」: ${m.expense ? `id=${m.expense.id} default_tax_code=${m.expense.taxCode} 税区分名=${m.taxName ?? '不明'}` : '無い'}`);
    note(ctx, `手動口座: ${POC_CARD} ${m.card ? `id=${m.card.id}` : '無い'}、${POC_BANK} ${m.bank ? `id=${m.bank.id}` : '無い'}`);
  },

  async F4(ctx) {
    for (const key of ['F4a', 'F4b']) {
      const up = await ensureReceipt(ctx, key);
      const r = obj(obj(up.res.json).receipt);
      note(
        ctx,
        `${key}（${RECEIPT_SPECS[key].meta ? 'メタデータあり' : 'メタデータなし'}）: ${statusText(up.res)} id=${up.id ?? '-'} ` +
          `origin=${String(r.origin)} status=${String(r.status)} mime_type=${String(r.mime_type)} ` +
          `receipt_metadatum=${JSON.stringify(r.receipt_metadatum ?? null)} document_type=${String(r.document_type)} qualified_invoice=${String(r.qualified_invoice)}`,
      );
    }
  },

  async F5(ctx) {
    const up = await ensureReceipt(ctx, 'F4a');
    if (up.id === null) throw new Error('F4a の証憑が無い');
    const t = up.truth;
    const body = (amount: number) => ({
      company_id: ctx.companyId,
      receipt_metadatum: { partner_name: t.vendor, issue_date: t.date, amount },
      qualified_invoice: t.registration_number ? 'qualified' : 'not_qualified',
      ...(t.registration_number ? { invoice_registration_number: t.registration_number } : {}),
      document_type: 'receipt',
    });
    const puts: [string, number][] = [
      ['PUT(入れる)', t.total],
      ['PUT(直す 1)', t.total + 1],
      ['PUT(直す 2)', t.total],
    ];
    for (const [label, amount] of puts) {
      const res = await call(ctx, label, 'PUT', `/api/1/receipts/${up.id}`, { json: body(amount) });
      const r = obj(obj(res.json).receipt);
      note(ctx, `${label} amount=${amount}: ${statusText(res)} 応答の金額=${String(obj(r.receipt_metadatum).amount)} 登録番号=${r.invoice_registration_number === t.registration_number ? '一致' : String(r.invoice_registration_number)}`);
    }
  },

  async F6(ctx) {
    for (const key of ['F4a', 'F4b']) {
      const up = await ensureReceipt(ctx, key);
      if (up.id === null) throw new Error(`${key} の証憑が無い`);
      const q = { query: { company_id: ctx.companyId } };
      const dl = await call(ctx, `${key} download`, 'GET', `/api/1/receipts/${up.id}/download`, { ...q, binary: true });
      const meta = await call(ctx, `${key} get`, 'GET', `/api/1/receipts/${up.id}`, q);
      const same = dl.bytes ? sha256(dl.bytes) === sha256(up.bytes) : false;
      note(
        ctx,
        `${key}: ${statusText(dl)} 取得 ${dl.bytes?.length ?? 0}B / 上げた ${up.bytes.length}B、sha256 ${same ? '一致' : '不一致'}、` +
          `content-type=${dl.headers.get('content-type') ?? '-'}、mime_type=${String(obj(obj(meta.json).receipt).mime_type)}`,
      );
    }
    // 1 秒 3 回の上限を少しだけ超える（5 回を同時に）。
    const up = await ensureReceipt(ctx, 'F4a');
    const burst = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        call(ctx, `burst ${i}`, 'GET', `/api/1/receipts/${up.id}/download`, { query: { company_id: ctx.companyId }, binary: true }),
      ),
    );
    const rl = burst
      .flatMap((r) => [...r.headers.entries()].filter(([k]) => RATE_HEADER.test(k)).map(([k, v]) => `${k}=${v}`))
      .filter((v, i, a) => a.indexOf(v) === i);
    note(ctx, `5 回同時: ステータス ${burst.map((r) => r.status).join(',')}、レート制限ヘッダ ${rl.join(' ') || '（なし）'}`);
  },

  async F7(ctx) {
    const key = `${ctx.runId}-F7`;
    const up = await uploadReceipt(ctx, 'F7', 'r04_receipt58_wareki.jpg', { meta: true, description: key });
    const echoed = obj(obj(up.res.json).receipt).description;
    note(ctx, `POST: ${statusText(up.res)} id=${up.id ?? '-'}、応答の description ${echoed === undefined ? 'なし' : echoed === key ? '一致' : '不一致'}`);
    const res = await call(ctx, 'list', 'GET', '/api/1/receipts', {
      query: { company_id: ctx.companyId, start_date: `${ctx.today.slice(0, 4)}-01-01`, end_date: ctx.today, category: 'without_deal' },
    });
    const list = arr(obj(res.json).receipts);
    const hit = list.find((r) => num(r.id) === up.id);
    note(ctx, `without_deal: ${statusText(res)} ${list.length} 件、上げた証憑 ${hit ? 'あり' : 'なし'}、description の照合キー ${hit && hit.description === key ? '返る' : '返らない'}、照合キーで探して ${list.filter((r) => r.description === key).length} 件`);
  },

  async F8(ctx) {
    const up = await uploadReceipt(ctx, 'F8 receipt', 'r05_receipt58_no-registration-number.jpg', { meta: true });
    if (up.id === null) throw new Error('証憑を上げられなかった');
    const d = await createDeal(ctx, 'F8', up.truth, { receiptIds: [up.id] });
    const deal = obj(obj(d.res.json).deal);
    note(ctx, `POST /deals: ${statusText(d.res)} id=${d.id ?? '-'} status=${String(deal.status)} due_amount=${String(deal.due_amount)} receipts=${arr(deal.receipts).length}`);
    const res = await call(ctx, 'with_deal', 'GET', '/api/1/receipts', {
      query: { company_id: ctx.companyId, start_date: `${ctx.today.slice(0, 4)}-01-01`, end_date: ctx.today, category: 'with_deal' },
    });
    note(ctx, `with_deal に証憑 ${arr(obj(res.json).receipts).some((r) => num(r.id) === up.id) ? 'あり' : 'なし'}`);
  },

  async F9(ctx) {
    const up = await uploadReceipt(ctx, 'F9 receipt', 'r07_receipt58_grayscale.jpg', { meta: true });
    if (up.id === null) throw new Error('証憑を上げられなかった');
    const d = await createDeal(ctx, 'F9', up.truth);
    if (d.id === null) throw new Error(`取引を作れなかった: ${statusText(d.res)}`);
    const q = { query: { company_id: ctx.companyId } };
    const before = obj(obj((await call(ctx, 'get(前)', 'GET', `/api/1/deals/${d.id}`, q)).json).deal);
    const details = arr(before.details).map((x) => {
      const out: Record<string, unknown> = {};
      for (const k of ['id', 'account_item_id', 'tax_code', 'amount', 'vat', 'description']) if (x[k] !== undefined && x[k] !== null) out[k] = x[k];
      return out;
    });
    const put = await call(ctx, 'PUT receipt_ids', 'PUT', `/api/1/deals/${d.id}`, {
      json: {
        company_id: ctx.companyId,
        issue_date: before.issue_date,
        type: before.type,
        ref_number: before.ref_number,
        details,
        receipt_ids: [up.id],
      },
    });
    const after = obj(obj((await call(ctx, 'get(後)', 'GET', `/api/1/deals/${d.id}`, q)).json).deal);
    const sig = (dl: Record<string, unknown>[]) => dl.map((x) => `${String(x.tax_code)}/${String(x.amount)}/${String(x.vat)}`).join(',');
    note(ctx, `PUT: ${statusText(put)}、証憑 ${arr(after.receipts).some((r) => num(r.id) === up.id) ? '紐付いた' : '紐付いていない'}`);
    note(ctx, `明細行（tax_code/amount/vat）: 前 ${sig(arr(before.details))} → 後 ${sig(arr(after.details))}（${sig(arr(before.details)) === sig(arr(after.details)) ? '変化なし' : '変化あり'}）`);
  },

  async F10(ctx) {
    const m = await ensureMasters(ctx);
    const card = requireCard(m);
    const { truth } = await loadTruth(ctx.fixturesDir, 'r11_receipt80.jpg');
    const d = await createDeal(ctx, 'F10', truth, { cardId: card.id });
    const deal = obj(obj(d.res.json).deal);
    note(ctx, `決済済みの取引: ${statusText(d.res)} id=${d.id ?? '-'} status=${String(deal.status)} payments=${arr(deal.payments).length}`);
    const q = { company_id: ctx.companyId, walletable_type: 'credit_card', walletable_id: card.id, start_date: truth.date, end_date: truth.date };
    const list = arr(obj((await call(ctx, 'wallet_txns', 'GET', '/api/1/wallet_txns', { query: q })).json).wallet_txns);
    note(ctx, `同じ日のカード明細 ${list.length} 件、同額 ${list.filter((x) => x.amount === truth.total).length} 件（取引から明細が${list.some((x) => x.amount === truth.total) ? '作られた' : '作られない'}）`);
    const w = await createWalletTxn(ctx, 'F10 txn', { date: truth.date, amount: truth.total, description: `${ctx.runId}-F10`, walletableId: card.id });
    const wt = obj(obj(w.res.json).wallet_txn);
    note(ctx, `同額の明細: ${statusText(w.res)} id=${w.id ?? '-'} status=${String(wt.status)} due_amount=${String(wt.due_amount)} rule_matched=${String(wt.rule_matched)}`);
  },

  async F11(ctx) {
    const q = { query: { company_id: ctx.companyId } };
    const prev = ctx.dryRun ? [] : (await ctx.created.outstanding(ctx.companyId)).filter((e) => e.step === 'F11');
    const prevDeal = prev.filter((e) => e.type === 'deal').at(-1);
    if (prevDeal) {
      // 2 回目以降: 画面で確定した後の状態を読むだけ（新しく作らない）。
      const deal = obj(obj((await call(ctx, 'get deal', 'GET', `/api/1/deals/${prevDeal.id}`, q)).json).deal);
      note(ctx, `前回の取引 id=${prevDeal.id}: status=${String(deal.status)} due_amount=${String(deal.due_amount)}`);
      for (const w of prev.filter((e) => e.type === 'wallet_txn')) {
        const wt = obj(obj((await call(ctx, 'get txn', 'GET', `/api/1/wallet_txns/${w.id}`, q)).json).wallet_txn);
        note(ctx, `前回の明細 id=${w.id}: status=${String(wt.status)} due_amount=${String(wt.due_amount)}`);
      }
      return;
    }
    const m = await ensureMasters(ctx);
    const card = requireCard(m);
    const { truth } = await loadTruth(ctx.fixturesDir, 'r15_receipt80_no-registration-number.jpg');
    const d = await createDeal(ctx, 'F11', truth);
    const deal = obj(obj(d.res.json).deal);
    note(ctx, `未決済の取引: ${statusText(d.res)} id=${d.id ?? '-'} status=${String(deal.status)} due_amount=${String(deal.due_amount)}`);
    const w = await createWalletTxn(ctx, 'F11 txn', { date: truth.date, amount: truth.total, description: `${ctx.runId}-F11`, walletableId: card.id });
    const wt = obj(obj(w.res.json).wallet_txn);
    note(ctx, `同額の明細: ${statusText(w.res)} id=${w.id ?? '-'} status=${String(wt.status)} rule_matched=${String(wt.rule_matched)}`);
    note(ctx, '→ 画面の「自動で経理」で確定してから `--only F11` を再実行すると、状態だけを読む');
  },

  async F12(ctx) {
    const m = await ensureMasters(ctx);
    const card = requireCard(m);
    requireExpense(m);
    if (!m.taxName) throw new Error(`「${EXPENSE_ACCOUNT}」の税区分名が分からない（act=0 に tax_name が要る）`);
    const rules = [
      { label: 'act=4 無視', act: 4, tag: 'IGN', amount: 1100, extra: {} },
      { label: 'act=11 プライベート', act: 11, tag: 'PRV', amount: 2200, extra: {} },
      { label: 'act=0 取引を推測', act: 0, tag: 'EXP', amount: 3300, extra: { account_item_name: EXPENSE_ACCOUNT, tax_name: m.taxName } },
    ];
    for (const r of rules) {
      const desc = `KHPOC${ctx.stamp}${r.tag}`;
      const c = await createRule(ctx, r.label, { act: r.act, description: desc, extra: r.extra });
      note(ctx, `ルール ${r.label}: ${statusText(c.res)} id=${c.id ?? '-'}`);
      const w = await createWalletTxn(ctx, `${r.tag} txn`, { date: ctx.today, amount: r.amount, description: `${desc} ダミー`, walletableId: card.id });
      const wt = obj(obj(w.res.json).wallet_txn);
      note(ctx, `  一致する明細: ${statusText(w.res)} id=${w.id ?? '-'} rule_matched=${String(wt.rule_matched)} status=${String(wt.status)}${wt.status === 3 ? '（無視）' : ''}`);
    }
    const dup = await createRule(ctx, '同じルールの 2 回目', { act: 4, description: `KHPOC${ctx.stamp}IGN` });
    note(ctx, `同じルールの 2 回目: ${statusText(dup.res)}（400 になるか: ${dup.res.status === 400 ? 'はい' : 'いいえ'}）`);
  },

  async F13(ctx) {
    const q = { query: { company_id: ctx.companyId } };
    const loose = await uploadReceipt(ctx, 'F13 loose', 'r03_receipt58_reduced-rate-mix.jpg', { meta: true });
    const linked = await uploadReceipt(ctx, 'F13 linked', 'r08_receipt58_injected-instruction.png', { meta: true });
    if (loose.id === null || linked.id === null) throw new Error('証憑を上げられなかった');
    const d = await createDeal(ctx, 'F13', linked.truth, { receiptIds: [linked.id] });
    const rule = await createRule(ctx, 'F13 rule', { act: 4, description: `KHPOC${ctx.stamp}DEL` });

    const r1 = await deleteEntity(ctx, 'del linked receipt', 'receipt', linked.id);
    note(ctx, `紐付き中の証憑の削除: ${statusText(r1)}（エラーになるか: ${r1.ok ? 'いいえ' : 'はい'}）`);
    const r2 = await deleteEntity(ctx, 'del loose receipt', 'receipt', loose.id);
    note(ctx, `紐付いていない証憑の削除: ${statusText(r2)}`);
    const g = await call(ctx, 'get loose', 'GET', `/api/1/receipts/${loose.id}`, q);
    note(ctx, `削除後の GET: ${statusText(g)} status=${String(obj(obj(g.json).receipt).status)}`);
    if (d.id !== null) {
      const r3 = await deleteEntity(ctx, 'del deal', 'deal', d.id);
      note(ctx, `取引の削除: ${statusText(r3)}`);
    }
    if (rule.id !== null) {
      const r4 = await deleteEntity(ctx, 'del rule', 'user_matcher', rule.id);
      note(ctx, `ルールの削除: ${statusText(r4)}`);
    }
  },

  async F14(ctx) {
    const base = await loadTruth(ctx.fixturesDir, 'r17_receipt80_grayscale.jpg');
    const cases: { label: string; file: string; bytes?: Buffer; truth?: Truth; name?: string }[] = [
      { label: 'JPEG', file: 'r16_receipt80_under-200dpi.jpg' },
      { label: 'PNG', file: 'r20_receipt80_reduced-rate-mix_no-registration-number.png' },
      { label: 'PDF', file: 'r23_invoice-a4.pdf' },
      { label: 'JPEG 6MB', file: 'r17_receipt80_grayscale.jpg', bytes: padJpegTo(base.bytes, 6 * 1024 * 1024), truth: base.truth, name: 'r17_receipt80_grayscale_6mb.jpg' },
      { label: 'JPEG 20MB', file: 'r17_receipt80_grayscale.jpg', bytes: padJpegTo(base.bytes, 20 * 1024 * 1024), truth: base.truth, name: 'r17_receipt80_grayscale_20mb.jpg' },
    ];
    if (ctx.heic) {
      cases.push({ label: 'HEIC', file: ctx.heic, bytes: await readFile(ctx.heic), truth: base.truth, name: path.basename(ctx.heic) });
    }
    for (const c of cases) {
      const up = await uploadReceipt(ctx, `F14 ${c.label}`, c.file, { bytes: c.bytes, truth: c.truth, name: c.name });
      note(ctx, `${c.label}（${up.bytes.length}B）: ${statusText(up.res)} id=${up.id ?? '-'} mime_type=${String(obj(obj(up.res.json).receipt).mime_type)}`);
    }
    if (!ctx.heic) note(ctx, 'HEIC: 未実施（本機の sharp では HEIC を作れない。ダミーの HEIC を --heic で渡すと試す）');
  },

  async F15(ctx) {
    if (!ctx.client.readOnly) throw new FreeeGuardError('F15 は読み取り専用のクライアント（--prod）でだけ実行する');
    const q = { company_id: ctx.companyId };
    const start = new Date(Date.parse(`${ctx.today}T00:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10);
    const cs = await call(ctx, 'companies', 'GET', '/api/1/companies');
    note(ctx, `companies: ${statusText(cs)}（403 にならないか: ${cs.status === 403 ? '403' : 'OK'}）`);
    const wl = arr(obj((await call(ctx, 'walletables', 'GET', '/api/1/walletables', { query: { ...q, with_sync_status: true } })).json).walletables);
    note(ctx, `walletables ${wl.length} 件: type ${countBy(wl, 'type')}、sync_status ${countBy(wl, 'sync_status')}`);
    const wt = await call(ctx, 'wallet_txns', 'GET', '/api/1/wallet_txns', { query: { ...q, start_date: start, end_date: ctx.today, limit: 100 } });
    const txns = arr(obj(wt.json).wallet_txns);
    const shapes = new Map<string, number>();
    for (const t of txns) {
      const s = shapeOf(typeof t.description === 'string' ? t.description : '');
      shapes.set(s, (shapes.get(s) ?? 0) + 1);
    }
    const top = [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    note(ctx, `wallet_txns（${start}〜${ctx.today}、最大 100 件）: ${statusText(wt)} ${txns.length} 件、status ${countBy(txns, 'status')}、walletable_type ${countBy(txns, 'walletable_type')}`);
    note(ctx, `description の形式（上位 5、J=漢字かな A=英字 9=数字）: ${top.map(([s, n]) => `\`${s}\`×${n}`).join(' ') || '（なし）'}`);
    const um = arr(obj((await call(ctx, 'user_matchers', 'GET', '/api/1/user_matchers', { query: q })).json).user_matchers);
    note(ctx, `user_matchers ${um.length} 件: act ${countBy(um, 'act')}`);
    const rc = arr(obj((await call(ctx, 'receipts', 'GET', '/api/1/receipts', { query: { ...q, start_date: start, end_date: ctx.today } })).json).receipts);
    note(ctx, `receipts（直近 30 日）${rc.length} 件: origin ${countBy(rc, 'origin')}`);
  },

  async F16(ctx) {
    if (ctx.rate.total === 0) await call(ctx, 'companies', 'GET', '/api/1/companies');
    const hs = [...ctx.rate.headers.entries()].map(([k, v]) => `${k}=${v}`);
    note(ctx, `この実行で見えたレート制限ヘッダ: ${hs.join(' ') || '（なし）'}`);
    note(ctx, `この実行の API 呼び出し ${ctx.rate.total} 回（トークンの更新を除く）: ${[...ctx.rate.byStep.entries()].map(([k, n]) => `${k}=${n}`).join(' ')}`);
    note(ctx, '1 日 3,000 回に対する keihi の想定呼び出し数: 上の項目ごとの回数をもとに記入する');
  },
};

// ---- 結果ファイル（F ごとの自動記録のブロックだけを書き換え、ユーザーのメモは残す） ----

const begin = (id: string) => `<!-- ${id}:auto:begin -->`;
const end = (id: string) => `<!-- ${id}:auto:end -->`;

export function resultsTemplate(): string {
  const lines = [
    '# freee 版 PoC の結果（T0-2\'、docs/freee-codex.md §3.2）',
    '',
    'トークン・個人情報は書かない。自動記録のブロック（`<!-- Fn:auto -->`）はスクリプトが書き換える。それ以外はユーザーのメモ。',
    '',
  ];
  for (const s of STEPS) {
    lines.push(`## ${s.id} ${s.title}`, '', begin(s.id), '（未実行）', end(s.id), '');
    if (s.screen.length) {
      lines.push('画面で確認（ユーザー記入）:');
      for (const x of s.screen) lines.push(`- ${x}: `);
      lines.push('');
    }
  }
  lines.push('## 結論: §5.2 の流れ（F10・F11・F12）が成り立つか', '', '- （記入）', '');
  return lines.join('\n');
}

export function renderBlock(r: StepResult, meta: { at: string; runId: string }): string {
  const lines = [`_自動記録 ${meta.at} run=${meta.runId}_`, ''];
  for (const c of r.calls) lines.push(`- \`${c.method} ${c.path}\`（${c.label}）→ ${c.status}${c.requestId ? ` req=${c.requestId}` : ''}`);
  for (const n of r.notes) lines.push(`- ${n}`);
  if (r.error) lines.push(`- **エラー**: ${r.error}`);
  return lines.join('\n');
}

export function updateResults(src: string, results: StepResult[], meta: { at: string; runId: string }, redact: (s: string) => string): string {
  let out = src;
  for (const r of results) {
    const b = begin(r.id);
    const e = end(r.id);
    const i = out.indexOf(b);
    const j = out.indexOf(e);
    const block = `${b}\n${redact(renderBlock(r, meta))}\n${e}`;
    if (i >= 0 && j > i) out = out.slice(0, i) + block + out.slice(j + e.length);
    else out += `\n## ${r.id} ${r.title}\n\n${block}\n`;
  }
  return out;
}

// ---- 後片付け ----

export async function runCleanup(opts: {
  client: FreeeClient;
  created: CreatedLog;
  log: (s: string) => void;
}): Promise<{ deleted: number; failed: number; skipped: number }> {
  const { client, created, log } = opts;
  const all = await created.readAll();
  const outstanding = await created.outstanding(client.companyId);
  const skipped = new Set(all.filter((e) => e.op === 'created' && e.company_id !== client.companyId).map((e) => `${e.type}:${e.id}`)).size;
  if (skipped) log(`cleanup: 事業所 ${client.companyId} 以外の記録 ${skipped} 件は触らない`);
  let deleted = 0;
  let failed = 0;
  for (const type of CLEANUP_ORDER) {
    for (const e of outstanding.filter((x) => x.type === type).reverse()) {
      const res = await client.request('DELETE', `${ENTITY_PATH[type]}/${e.id}`, { query: { company_id: client.companyId } });
      log(`cleanup: DELETE ${ENTITY_PATH[type]}/${e.id}（${e.step}）→ ${res.status}${res.requestId ? ` req=${res.requestId}` : ''}${res.ok ? '' : ` ${errorMessage(res.json)}`}`);
      if (res.ok || res.status === 404) {
        await markDeleted({ created, companyId: client.companyId }, type, e.id, 'cleanup');
        deleted++;
      } else {
        failed++;
      }
    }
  }
  log(`cleanup: 削除 ${deleted} 件、失敗 ${failed} 件。手動口座（${POC_CARD} / ${POC_BANK}）は画面で削除する（§3.3）`);
  return { deleted, failed, skipped };
}

// ---- dry-run: API を呼ばず、リクエスト形を表示して決まった応答を返す ----

const SECRET_FORM_KEYS = new Set(['client_id', 'client_secret', 'code', 'refresh_token']);

export function describeBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (body instanceof URLSearchParams) {
    return `form{${[...body.entries()].map(([k, v]) => `${k}=${SECRET_FORM_KEYS.has(k) ? '***' : v}`).join(', ')}}`;
  }
  if (body instanceof FormData) {
    const parts: string[] = [];
    for (const [k, v] of body.entries()) {
      parts.push(typeof v === 'string' ? `${k}=${v}` : `${k}=<${(v as File).name} ${v.type} ${v.size}B>`);
    }
    return `multipart{${parts.join(', ')}}`;
  }
  if (typeof body === 'string') return `json${body.length > 600 ? `${body.slice(0, 600)}…` : body}`;
  return '<body>';
}

export function createDryRunFetch(log: (s: string) => void, companyId: number): typeof fetch {
  let seq = 900000;
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'x-freee-request-id': 'dry-run' } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ? 'Bearer ***' : '-';
    log(`  DRY ${method} ${url.origin}${url.pathname}${url.search} auth=${auth} ${describeBody(init?.body)}`.trimEnd());
    const p = url.pathname;
    if (`${url.origin}${p}` === TOKEN_URL) {
      return json(200, { access_token: 'dry-run-access-token', refresh_token: 'dry-run-refresh-token', token_type: 'bearer', expires_in: 21600, created_at: Math.floor(Date.now() / 1000), company_id: companyId, scope: 'read write' });
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (p === '/api/1/users/me') return json(200, { user: { id: 1, companies: [{ id: companyId }] } });
    if (p === '/api/1/companies') return json(200, { companies: [{ id: companyId, role: 'admin' }] });
    if (p === '/api/1/account_items') return json(200, { account_items: [{ id: 101, name: EXPENSE_ACCOUNT, default_tax_code: 136 }] });
    if (p === '/api/1/taxes/codes') return json(200, { taxes: [{ code: 136, name: 'purchase_with_tax_10', name_ja: '課対仕入10%' }] });
    if (p === '/api/1/walletables') return json(200, { walletables: [{ id: 201, name: POC_CARD, type: 'credit_card' }, { id: 202, name: POC_BANK, type: 'bank_account' }] });
    if (p === '/api/1/partners') return json(200, { partners: [] });
    if (p === '/api/1/receipts' && method === 'POST') return json(201, { receipt: { id: seq++, status: 'confirmed', origin: 'public_api' } });
    if (p === '/api/1/receipts') return json(200, { receipts: [] });
    if (/^\/api\/1\/receipts\/\d+\/download$/.test(p)) return new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    if (/^\/api\/1\/receipts\/\d+$/.test(p)) return json(200, { receipt: { id: Number(p.split('/').at(-1)), status: 'confirmed' } });
    if (p === '/api/1/deals' && method === 'POST') return json(201, { deal: { id: seq++, status: 'unsettled' } });
    if (/^\/api\/1\/deals\/\d+$/.test(p)) {
      return json(200, { deal: { id: Number(p.split('/').at(-1)), issue_date: '2026-01-01', type: 'expense', details: [{ id: 1, account_item_id: 101, tax_code: 136, amount: 100, vat: 9 }], receipts: [] } });
    }
    if (p === '/api/1/wallet_txns' && method === 'POST') return json(201, { wallet_txn: { id: seq++, status: 1, rule_matched: false } });
    if (p === '/api/1/wallet_txns') return json(200, { wallet_txns: [] });
    if (/^\/api\/1\/wallet_txns\/\d+$/.test(p)) return json(200, { wallet_txn: { id: Number(p.split('/').at(-1)), status: 1 } });
    if (p === '/api/1/user_matchers' && method === 'POST') return json(201, { id: seq++ });
    if (p === '/api/1/user_matchers') return json(200, { user_matchers: [] });
    return json(200, {});
  }) as typeof fetch;
}

// ---- CLI ----

export type MainDeps = {
  fetch?: typeof fetch;
  log?: (s: string) => void;
  error?: (s: string) => void;
  now?: () => Date;
};

function jstParts(d: Date): { today: string; stamp: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { today: `${p.year}-${p.month}-${p.day}`, stamp: `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}` };
}

export function parseOnly(v: string | undefined): StepId[] | null {
  if (v === undefined) return null;
  const ids = v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const id of ids) if (!STEP_IDS.includes(id)) throw new Error(`--only の値が不正: ${id}（F1〜F16）`);
  return ids as StepId[];
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const redactor = createRedactor();
  const log = (s: string) => (deps.log ?? ((x: string) => console.log(x)))(redactor.apply(s));
  const error = (s: string) => (deps.error ?? ((x: string) => console.error(x)))(redactor.apply(s));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean', default: false },
        only: { type: 'string' },
        cleanup: { type: 'boolean', default: false },
        prod: { type: 'boolean', default: false },
        heic: { type: 'string' },
        fixtures: { type: 'string', default: DEFAULT_FIXTURES_DIR },
        results: { type: 'string', default: DEFAULT_RESULTS },
        created: { type: 'string', default: DEFAULT_CREATED },
        'config-dir': { type: 'string', default: DEFAULT_CONFIG_DIR },
      },
    }));
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const dryRun = values['dry-run'];
  const prod = values.prod;
  let only: StepId[] | null;
  try {
    only = parseOnly(values.only);
  } catch (e) {
    error((e as Error).message);
    return 2;
  }
  if (prod && values.cleanup) {
    error('--prod と --cleanup は一緒に使わない（本番事業所には何も書かない）');
    return 2;
  }
  if (prod && only && only.some((id) => id !== 'F15')) {
    error('--prod で実行できるのは F15（読み取りだけ）だけ');
    return 2;
  }
  if (!prod && only?.includes('F15')) {
    error('F15 は本番事業所の読み取り。--prod を付けたときだけ実行する');
    return 2;
  }
  const steps: StepId[] = prod ? ['F15'] : (only ?? STEPS.map((s) => s.id).filter((id) => id !== 'F15'));
  // F16 は他の項目のヘッダを見るので最後に回す。
  steps.sort((a, b) => (a === 'F16' ? 1 : 0) - (b === 'F16' ? 1 : 0));

  const configDir = values['config-dir'];
  try {
    const config = await loadFreeeConfig(configDir);
    const target: Target = prod ? 'prod' : 'poc';
    let companyId = prod ? config.prodCompanyId : config.pocCompanyId;
    if (prod && companyId !== null && companyId === config.pocCompanyId) throw new Error('prod_company_id と poc_company_id が同じ');
    let tokens: TokenProvider;
    let store: TokenStore | null = null;
    let creds: ClientCredentials;
    let doFetch: typeof fetch;
    if (dryRun) {
      companyId ??= prod ? 2 : 1;
      log(`dry-run: 事業所 ${companyId}（${target}）、項目 ${values.cleanup ? 'cleanup' : steps.join(',')}。API は呼ばない。シークレットとトークンは読まない。応答は固定のダミーなので判定は意味を持たない`);
      doFetch = createDryRunFetch(log, companyId);
      creds = { clientId: 'DRY-RUN-CLIENT-ID', clientSecret: 'DRY-RUN-CLIENT-SECRET' };
      tokens = { get: async () => 'DRY-RUN-ACCESS-TOKEN' };
    } else {
      if (companyId === null) {
        throw new Error(`${path.join(configDir, 'config.toml')} に [freee] ${prod ? 'prod_company_id' : 'poc_company_id'} が無い`);
      }
      creds = await loadFreeeCredentials(configDir);
      redactor.add(creds.clientSecret);
      store = new TokenStore(tokenFile(configDir, target));
      const t = await store.read();
      if (!t) throw new Error(`${store.path} が無い。先に node tools/poc/freee-auth.ts${prod ? ' --prod' : ''} で認可する`);
      redactor.add(t.access_token);
      redactor.add(t.refresh_token);
      if (t.company_id !== companyId) {
        throw new Error(`トークンの事業所（${t.company_id ?? 'なし'}）が設定の ${prod ? 'prod' : 'poc'}_company_id（${companyId}）と違う。止める`);
      }
      doFetch = deps.fetch ?? fetch;
      const base = createTokenProvider({ store, creds, fetch: doFetch });
      tokens = {
        async get(o) {
          const v = await base.get(o);
          redactor.add(v);
          return v;
        },
      };
    }
    const client = createFreeeClient({ tokens, companyId, readOnly: prod, fetch: doFetch });
    const created = new CreatedLog(values.created, { dryRun });

    if (values.cleanup) {
      const r = await runCleanup({ client, created, log });
      return r.failed ? 1 : 0;
    }

    const now = (deps.now ?? (() => new Date()))();
    const { today, stamp } = jstParts(now);
    const results: StepResult[] = [];
    const ctx: Ctx = {
      client,
      companyId,
      dryRun,
      fixturesDir: values.fixtures,
      runId: `kh-POC-${stamp}`,
      stamp,
      today,
      created,
      log,
      redactor,
      heic: values.heic ?? null,
      auth: { store, creds, fetch: doFetch },
      cache: { receipts: new Map() },
      rate: { headers: new Map(), total: 0, byStep: new Map() },
      cur: { id: '', title: '', calls: [], notes: [], error: null },
    };
    let fatal = false;
    for (const id of steps) {
      const def = STEPS.find((s) => s.id === id)!;
      ctx.cur = { id, title: def.title, calls: [], notes: [], error: null };
      log(`== ${id} ${def.title}`);
      try {
        await step[id](ctx);
      } catch (e) {
        ctx.cur.error = redactor.apply(e instanceof Error ? e.message : String(e));
        error(`${id} エラー: ${ctx.cur.error}`);
        if (e instanceof FreeeGuardError) fatal = true;
      }
      results.push(ctx.cur);
      if (fatal) break;
    }
    if (!dryRun) {
      let src: string;
      try {
        src = await readFile(values.results, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        src = resultsTemplate();
      }
      await mkdir(path.dirname(values.results), { recursive: true });
      await writeFile(values.results, updateResults(src, results, { at: now.toISOString(), runId: ctx.runId }, redactor.apply));
      log(`wrote ${values.results} / ${values.created}`);
    }
    return results.some((r) => r.error) ? 1 : 0;
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
