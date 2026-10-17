// T0-3 Gemini PoC（docs/mvp-plan.md）。T0-1 のダミー領収書だけを使う。
// 30 枚 × thinking {low, medium} × media_resolution {medium, high} で Gemini を呼び、
// 正解 JSON との一致（日付・合計・取引先・登録番号・科目）、トークン数、レイテンシを CSV に書く。
//
//   node tools/poc/gemini-poc.ts --dry-run --limit 2     # API を呼ばずにリクエスト形だけ検証
//   node tools/poc/gemini-poc.ts --fx 150                # 実行（為替 1 USD = 150 円で換算）
//
// 安全側の前提（classification-ocr.md B-2、mvp-plan.md T1-2・§4.3、D13）:
// - API キーは ~/.config/keihi/secrets.env（0600 以外は拒否）の GEMINI_API_KEY。ログ・CSV・例外に出さない。
// - ~/.config/keihi/config.toml に `[gemini] paid_tier_confirmed = true` が無ければ実行しない。
// - Gemini へは EXIF などのメタデータを除いた派生画像（src/ai/gemini/derive.ts deriveForAi）を inline で送る。Files API・キャッシュは使わない。
// - 送る形（派生画像・プロンプト・応答スキーマ）は本番と同じ src/ai/gemini/client.ts の extractReceipt を使う。
//   科目は PoC 用の名前（ACCOUNTS。ID = 名前）、税は税率の区分（schema.ts）。スキーマの検証は src/ai/validate.ts。
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  GeminiError,
  buildGenerateContentBody,
  buildReceiptInput,
  createGeminiClient,
  extractReceipt,
  generateContentUrl,
  DEFAULT_BASE_URL,
  type GeminiClient,
  type MediaResolution,
  type ThinkingLevel,
  type Usage,
} from '../../src/ai/gemini/client.ts';
import { buildResponseSchema as buildSchema, type Schema, type SchemaAccount } from '../../src/ai/gemini/schema.ts';
import { validateSchema } from '../../src/ai/validate.ts';
import type { Truth } from '../fixtures/gen-receipts.ts';
import { assertSecretsFile, mimeOf } from './common.ts';

// classification-ocr.md B-1 / a2ui-review-ui.md §1.4。モデル ID は config.toml の gemini.model で上書きできる。
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_CONFIG_DIR = path.join(homedir(), '.config', 'keihi');
export const DEFAULT_FIXTURES_DIR = 'test/fixtures/receipts';
export const DEFAULT_OUT = 'poc/gemini-results.csv';
export const DEFAULT_SUMMARY = 'poc/gemini-summary.md';

// Gemini 3.8 Flash の単価（USD / 1M トークン。出力は思考トークンを含む）。classification-ocr.md B-1。
export const PRICES = {
  until_2026_12_31: { in: 0.75, out: 3.75 },
  from_2027_01_01: { in: 1.5, out: 7.5 },
} as const;

export type Condition = { thinking: ThinkingLevel; media: MediaResolution };
export const CONDITIONS: Condition[] = [
  { thinking: 'low', media: 'medium' },
  { thinking: 'low', media: 'high' },
  { thinking: 'medium', media: 'medium' },
  { thinking: 'medium', media: 'high' },
];

// ---- 設定とシークレット ----

// 行から # 以降のコメントを落とす。引用符の中の # はコメントにしない。
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

// config.toml の最小パーサ（[section] と key = string|bool|number、# コメントのみ）。T1-2 で置き換える。
export function parseTomlSubset(src: string): Record<string, Record<string, string | number | boolean>> {
  const out: Record<string, Record<string, string | number | boolean>> = { '': {} };
  let section = '';
  for (const [i, line0] of src.split(/\r?\n/).entries()) {
    const line = stripTomlComment(line0).trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      out[section] ??= {};
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`config.toml ${i + 1} 行目を解釈できない`);
    const raw = kv[2];
    let v: string | number | boolean;
    if (raw === 'true' || raw === 'false') v = raw === 'true';
    else if (/^"([^"\\]*)"$/.test(raw)) v = raw.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(raw)) v = Number(raw);
    else throw new Error(`config.toml ${i + 1} 行目の値を解釈できない`);
    out[section][kv[1]] = v;
  }
  return out;
}

// secrets.env の最小パーサ（KEY=VALUE、# コメント、両端の引用符）。値はエラーに含めない。
// dotenv の慣例に合わせ、引用符なしの値では空白に続く # 以降をコメントとして落とす。引用符の中はそのまま。
export function parseEnv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line0 of src.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    const close = q === '"' || q === "'" ? v.indexOf(q, 1) : -1;
    if (close > 0) v = v.slice(1, close);
    else v = v.replace(/(?:^|\s)#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

export type GeminiSettings = { model: string; apiKey: string };

async function readConfig(configDir: string): Promise<Record<string, Record<string, string | number | boolean>> | null> {
  try {
    return parseTomlSubset(await readFile(path.join(configDir, 'config.toml'), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function modelFrom(config: Record<string, Record<string, string | number | boolean>> | null): string {
  const m = config?.gemini?.model;
  if (m === undefined) return DEFAULT_MODEL;
  if (typeof m !== 'string' || !m) throw new Error('config.toml の gemini.model は文字列で指定する');
  return m;
}

// dry-run 用: シークレットは読まない。config.toml があればモデル ID だけ拾う。
export async function loadModelOnly(configDir: string): Promise<string> {
  return modelFrom(await readConfig(configDir));
}

export async function loadGeminiSettings(configDir: string): Promise<GeminiSettings> {
  const config = await readConfig(configDir);
  if (config?.gemini?.paid_tier_confirmed !== true) {
    throw new Error(
      `${path.join(configDir, 'config.toml')} に [gemini] paid_tier_confirmed = true が無い。` +
        '無料枠のキーは使わない（Cloud Billing を有効にした keihi 専用プロジェクトのキーだけを使う）',
    );
  }
  const secretsPath = path.join(configDir, 'secrets.env');
  await assertSecretsFile(secretsPath);
  const apiKey = parseEnv(await readFile(secretsPath, 'utf8')).GEMINI_API_KEY;
  if (!apiKey) throw new Error(`${secretsPath} に GEMINI_API_KEY が無い`);
  return { model: modelFrom(config), apiKey };
}

// ---- 送信する画像のメタデータの確認（dry-run 用。派生画像は deriveForAi が作る） ----

// PNG: eXIf と文字列系チャンク、tIME。
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 長さを持たない単独マーカー（TEM・RST0〜7・SOI・EOI）。
const isStandaloneMarker = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd9);

type JpegSegment = { marker: number; start: number; end: number };

// SOI の後のセグメントを順に返す。start は詰め物（連続する 0xFF）の先頭、end は次のセグメントの先頭。
// SOS は end = 末尾で返して止まる（以降は画像データ）。壊れていれば例外。
function* jpegSegments(buf: Buffer): Generator<JpegSegment> {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('JPEG ではない');
  let p = 2;
  while (p < buf.length) {
    if (buf[p] !== 0xff) throw new Error('JPEG のマーカーが壊れている');
    let q = p;
    while (buf[q] === 0xff) q++;
    if (q >= buf.length) throw new Error('JPEG のマーカーが壊れている');
    const marker = buf[q];
    if (marker === 0xda) {
      yield { marker, start: p, end: buf.length };
      return;
    }
    if (isStandaloneMarker(marker)) {
      yield { marker, start: p, end: q + 1 };
      p = q + 1;
      continue;
    }
    if (q + 3 > buf.length) throw new Error('JPEG のマーカーが壊れている');
    const end = q + 1 + buf.readUInt16BE(q + 1);
    if (end > buf.length) throw new Error('JPEG のセグメントが途中で切れている');
    yield { marker, start: p, end };
    p = end;
  }
}

// ---- 応答スキーマ・検証（本番の schema.ts / validate.ts を PoC の科目で使う） ----

// 科目: 青色申告決算書の経費科目 + 任意科目 + 事業主貸（classification-ocr.md A-5）。
// PoC 用。ID は名前そのもの（freee の勘定科目 ID は使わない）。
export const ACCOUNTS = [
  '租税公課', '荷造運賃', '水道光熱費', '旅費交通費', '通信費', '広告宣伝費', '接待交際費', '損害保険料',
  '修繕費', '消耗品費', '減価償却費', '福利厚生費', '給料賃金', '外注工賃', '利子割引料', '地代家賃',
  '貸倒金', '雑費', '新聞図書費', '支払手数料', '会議費', '研修費', '車両費', '事業主貸',
] as const;
export const POC_ACCOUNTS: readonly SchemaAccount[] = ACCOUNTS.map((a) => ({ id: a, name: a }));

export function buildResponseSchema(): Schema {
  return buildSchema(POC_ACCOUNTS);
}

export { validateSchema };

// ---- 採点 ----

export const normalizeText = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');

export type Score = {
  date: boolean;
  total: boolean;
  vendor: boolean;
  reg_no: boolean;
  account: boolean;
  got: { date: string; total: string; vendor: string; reg_no: string; account: string };
};

export function scoreOutput(truth: Pick<Truth, 'date' | 'total' | 'vendor' | 'registration_number' | 'expected_account'>, out: unknown): Score {
  const o = (out ?? {}) as { extraction?: Record<string, unknown>; account_candidates?: { account_id?: unknown }[] };
  const ex = o.extraction ?? {};
  const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  const regNo = typeof ex.invoice_reg_no === 'string' && ex.invoice_reg_no.trim() ? normalizeText(ex.invoice_reg_no).toUpperCase() : null;
  const account = Array.isArray(o.account_candidates) ? o.account_candidates[0]?.account_id : undefined;
  return {
    date: ex.txn_date === truth.date,
    total: ex.amount_total === truth.total,
    vendor: typeof ex.vendor_name === 'string' && normalizeText(ex.vendor_name) === normalizeText(truth.vendor),
    reg_no: regNo === truth.registration_number,
    account: account === truth.expected_account,
    got: { date: s(ex.txn_date), total: s(ex.amount_total), vendor: s(ex.vendor_name), reg_no: s(regNo), account: s(account) },
  };
}

// ---- 実行 ----

export type Fixture = { file: string; mime: string; bytes: Buffer; truth: Truth };

export async function loadFixtures(dir: string, limit?: number): Promise<Fixture[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.truth.json')).sort();
  const picked = limit === undefined ? names : names.slice(0, limit);
  const out: Fixture[] = [];
  for (const n of picked) {
    const truth = JSON.parse(await readFile(path.join(dir, n), 'utf8')) as Truth;
    const mime = mimeOf(truth.file);
    // 原本のまま持つ。送るときに extractReceipt が deriveForAi で派生画像にする。
    out.push({ file: truth.file, mime, bytes: await readFile(path.join(dir, truth.file)), truth });
  }
  return out;
}

export type Row = {
  file: string;
  variations: string;
  injected: boolean;
  thinking: ThinkingLevel;
  media: MediaResolution;
  model: string;
  model_version: string;
  error: string;
  schema_ok: boolean | null;
  schema_errors: string;
  score: Score | null;
  usage: Usage | null;
  latency_ms: number;
};

export async function runConditions(opts: {
  client: GeminiClient;
  model: string;
  fixtures: Fixture[];
  conditions?: Condition[];
  log?: (s: string) => void;
}): Promise<Row[]> {
  const { client, model, fixtures, log = () => {} } = opts;
  const conditions = opts.conditions ?? CONDITIONS;
  const schema = buildResponseSchema();
  const gemini = { client, model, thinkingLevel: 'low' as ThinkingLevel, mediaResolution: 'medium' as MediaResolution };
  const rows: Row[] = [];
  const total = fixtures.length * conditions.length;
  for (const fx of fixtures) {
    for (const c of conditions) {
      const base = {
        file: fx.file,
        variations: fx.truth.variations.join('|'),
        injected: fx.truth.injected_instruction !== null,
        thinking: c.thinking,
        media: c.media,
        model,
      };
      let row: Row;
      try {
        const r = await extractReceipt(gemini, { original: fx.bytes, accounts: POC_ACCOUNTS }, { thinkingLevel: c.thinking, mediaResolution: c.media });
        const errs = validateSchema(schema, r.json);
        row = {
          ...base,
          model_version: r.modelVersion ?? '',
          error: '',
          schema_ok: errs.length === 0,
          schema_errors: errs.slice(0, 5).join('; '),
          score: scoreOutput(fx.truth, r.json),
          usage: r.usage,
          latency_ms: r.latencyMs,
        };
      } catch (e) {
        const ge = e instanceof GeminiError ? e : null;
        row = {
          ...base,
          model_version: '',
          error: ge ? `${ge.code}${ge.status ? ` ${ge.status}` : ''}: ${ge.message}` : e instanceof Error ? e.message : String(e),
          schema_ok: ge?.code === 'invalid_json' ? false : null,
          schema_errors: '',
          score: null,
          usage: ge?.usage ?? null,
          latency_ms: ge?.latencyMs ?? 0,
        };
      }
      rows.push(row);
      const matched = row.score ? [row.score.date, row.score.total, row.score.vendor, row.score.reg_no, row.score.account].filter(Boolean).length : 0;
      log(
        `[${rows.length}/${total}] ${fx.file} thinking=${c.thinking} media=${c.media} ` +
          (row.error ? `ERROR ${row.error.slice(0, 200)}` : `match=${matched}/5 schema_ok=${row.schema_ok} ${row.latency_ms}ms`),
      );
    }
  }
  return rows;
}

// ---- CSV と要約 ----

export const CSV_HEADER = [
  'file', 'variations', 'injected', 'thinking', 'media_resolution', 'model', 'model_version', 'error',
  'schema_ok', 'schema_errors',
  'match_date', 'match_total', 'match_vendor', 'match_reg_no', 'match_account', 'match_count',
  'got_date', 'got_total', 'got_vendor', 'got_reg_no', 'got_account',
  'tokens_in', 'tokens_out', 'tokens_thoughts', 'latency_ms',
];

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: Row[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    const sc = r.score;
    const m = sc ? [sc.date, sc.total, sc.vendor, sc.reg_no, sc.account] : [];
    lines.push(
      [
        r.file, r.variations, r.injected, r.thinking, r.media, r.model, r.model_version, r.error,
        r.schema_ok ?? '', r.schema_errors,
        ...(sc ? m : ['', '', '', '', '']), sc ? m.filter(Boolean).length : '',
        sc?.got.date, sc?.got.total, sc?.got.vendor, sc?.got.reg_no, sc?.got.account,
        r.usage?.tokensIn, r.usage?.tokensOut, r.usage?.tokensThoughts, r.latency_ms,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export type ConditionSummary = {
  thinking: ThinkingLevel;
  media: MediaResolution;
  n: number;
  errors: number;
  // 一致率の分母はエラーを含む全件（エラーは不一致として数える）。
  rate: { date: number; total: number; vendor: number; reg_no: number; account: number; all5: number };
  schema_ok_rate: number;
  injected_n: number;
  injected_schema_ok: number;
  avg_tokens_in: number;
  avg_tokens_out: number;
  avg_latency_ms: number;
  // 1 枚あたりの円換算（成功した呼び出しの平均）。
  yen_per_image: { until_2026_12_31: number; from_2027_01_01: number };
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function costUsd(u: Usage, p: { in: number; out: number }): number {
  return (u.tokensIn * p.in + u.tokensOut * p.out) / 1_000_000;
}

export function summarize(rows: Row[], fxYenPerUsd: number, conditions: Condition[] = CONDITIONS): ConditionSummary[] {
  return conditions.map((c) => {
    const rs = rows.filter((r) => r.thinking === c.thinking && r.media === c.media);
    const n = rs.length;
    const rate = (f: (s: Score) => boolean) => (n ? rs.filter((r) => r.score && f(r.score)).length / n : 0);
    const ok = rs.filter((r) => !r.error && r.usage);
    const inj = rs.filter((r) => r.injected);
    return {
      thinking: c.thinking,
      media: c.media,
      n,
      errors: rs.filter((r) => r.error).length,
      rate: {
        date: rate((s) => s.date),
        total: rate((s) => s.total),
        vendor: rate((s) => s.vendor),
        reg_no: rate((s) => s.reg_no),
        account: rate((s) => s.account),
        all5: rate((s) => s.date && s.total && s.vendor && s.reg_no && s.account),
      },
      schema_ok_rate: n ? rs.filter((r) => r.schema_ok === true).length / n : 0,
      injected_n: inj.length,
      injected_schema_ok: inj.filter((r) => r.schema_ok === true).length,
      avg_tokens_in: mean(ok.map((r) => r.usage!.tokensIn)),
      avg_tokens_out: mean(ok.map((r) => r.usage!.tokensOut)),
      avg_latency_ms: mean(ok.map((r) => r.latency_ms)),
      yen_per_image: {
        until_2026_12_31: mean(ok.map((r) => costUsd(r.usage!, PRICES.until_2026_12_31))) * fxYenPerUsd,
        from_2027_01_01: mean(ok.map((r) => costUsd(r.usage!, PRICES.from_2027_01_01))) * fxYenPerUsd,
      },
    };
  });
}

export function summaryMarkdown(s: ConditionSummary[], meta: { model: string; fx: number; images: number }): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines = [
    `# Gemini PoC 要約`,
    ``,
    `model=${meta.model} / 画像 ${meta.images} 枚 / 1 USD = ${meta.fx} 円`,
    `一致率の分母はエラーを含む全件。円換算は成功した呼び出しの平均（出力は思考トークン込み）。`,
    ``,
    `| thinking | media | 日付 | 合計 | 取引先 | 登録番号 | 科目 | 5項目 | schema | 混入 schema | err | in | out | ms | 円/枚 2026 | 円/枚 2027 |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const c of s) {
    lines.push(
      `| ${c.thinking} | ${c.media} | ${pct(c.rate.date)} | ${pct(c.rate.total)} | ${pct(c.rate.vendor)} | ${pct(c.rate.reg_no)} | ${pct(c.rate.account)} | ${pct(c.rate.all5)} | ${pct(c.schema_ok_rate)} | ${c.injected_schema_ok}/${c.injected_n} | ${c.errors} | ${Math.round(c.avg_tokens_in)} | ${Math.round(c.avg_tokens_out)} | ${Math.round(c.avg_latency_ms)} | ${c.yen_per_image.until_2026_12_31.toFixed(3)} | ${c.yen_per_image.from_2027_01_01.toFixed(3)} |`,
    );
  }
  return lines.join('\n') + '\n';
}

// ---- dry-run: リクエスト形の検証 ----

const INLINE_LIMIT_BYTES = 20 * 1024 * 1024; // inline リクエストの目安上限。超えたら警告だけ出す。

export function hasJpegExif(buf: Buffer): boolean {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  try {
    for (const s of jpegSegments(buf)) if (s.marker === 0xe1) return true;
  } catch {
    // 壊れた JPEG は、読めた範囲に APP1 が無ければ false
  }
  return false;
}

export function hasPngMetadata(buf: Buffer): boolean {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return false;
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    if (PNG_DROP.has(buf.toString('latin1', p + 4, p + 8))) return true;
    p += 12 + len;
  }
  return false;
}

export function checkRequestShape(url: string, body: Record<string, unknown>, model: string): string[] {
  const errs: string[] = [];
  if (!url.startsWith(`${DEFAULT_BASE_URL}/`) || !url.endsWith(`/models/${model}:generateContent`)) errs.push('URL が generateContent ではない');
  if (/[?&]key=/.test(url)) errs.push('URL に API キーのクエリがある');
  const json = JSON.stringify(body);
  if (/"allOf"|"\$ref"/.test(json)) errs.push('スキーマに allOf / $ref がある');
  if (/"fileData"|"fileUri"|"cachedContent"/.test(json)) errs.push('inline 以外のデータ参照がある');
  const gc = body.generationConfig as Record<string, unknown> | undefined;
  if (gc?.responseMimeType !== 'application/json') errs.push('responseMimeType が application/json ではない');
  if (JSON.stringify(gc?.responseJsonSchema) !== JSON.stringify(buildResponseSchema())) errs.push('responseJsonSchema が応答スキーマと違う');
  const contents = body.contents as { parts: { inlineData?: { mimeType: string; data: string } }[] }[];
  const inline = contents?.[0]?.parts?.[0]?.inlineData;
  if (!inline) errs.push('inlineData が無い');
  else {
    const bytes = Buffer.from(inline.data, 'base64');
    if (inline.mimeType === 'image/jpeg' && hasJpegExif(bytes)) errs.push('JPEG に EXIF が残っている');
    if (inline.mimeType === 'image/png' && hasPngMetadata(bytes)) errs.push('PNG にメタデータが残っている');
  }
  return errs;
}

// ---- CLI ----

export type MainDeps = { fetch?: typeof fetch; log?: (s: string) => void; error?: (s: string) => void };

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const error = deps.error ?? ((s: string) => console.error(s));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean', default: false },
        limit: { type: 'string' },
        fx: { type: 'string' },
        fixtures: { type: 'string', default: DEFAULT_FIXTURES_DIR },
        out: { type: 'string', default: DEFAULT_OUT },
        summary: { type: 'string', default: DEFAULT_SUMMARY },
        'config-dir': { type: 'string', default: DEFAULT_CONFIG_DIR },
      },
    }));
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    error(`--limit は 1 以上の整数: ${values.limit}`);
    return 2;
  }
  const dryRun = values['dry-run'];
  const fx = values.fx === undefined ? undefined : Number(values.fx);
  if (!dryRun && (fx === undefined || !Number.isFinite(fx) || fx <= 0)) {
    error('--fx（1 USD あたりの円）を正の数で指定する。例: --fx 150');
    return 2;
  }

  try {
    if (dryRun) {
      const model = await loadModelOnly(values['config-dir']);
      const fixtures = await loadFixtures(values.fixtures, limit);
      const schema = buildResponseSchema();
      log(`dry-run: model=${model} images=${fixtures.length} conditions=${CONDITIONS.length} schema=${JSON.stringify(schema).length}B（API は呼ばない）`);
      let bad = 0;
      for (const f of fixtures) {
        for (const c of CONDITIONS) {
          const input = await buildReceiptInput({ original: f.bytes, accounts: POC_ACCOUNTS }, { model, thinkingLevel: c.thinking, mediaResolution: c.media });
          const url = generateContentUrl(DEFAULT_BASE_URL, model);
          const body = buildGenerateContentBody(input);
          const size = Buffer.byteLength(JSON.stringify(body));
          const errs = checkRequestShape(url, body, model);
          if (errs.length) bad++;
          const gc = body.generationConfig as { thinkingConfig: { thinkingLevel: string }; mediaResolution: string };
          log(
            `${f.file} ${f.mime} thinking=${gc.thinkingConfig.thinkingLevel} media=${gc.mediaResolution} ` +
              `body=${(size / 1024).toFixed(0)}KB ${errs.length ? `NG ${errs.join('; ')}` : 'OK'}` +
              (size > INLINE_LIMIT_BYTES ? ' WARN 20MB 超' : ''),
          );
        }
      }
      return bad ? 1 : 0;
    }

    const settings = await loadGeminiSettings(values['config-dir']);
    const fixtures = await loadFixtures(values.fixtures, limit);
    const client = createGeminiClient({ apiKey: settings.apiKey, fetch: deps.fetch });
    const rows = await runConditions({ client, model: settings.model, fixtures, log });
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, toCsv(rows));
    const md = summaryMarkdown(summarize(rows, fx!), { model: settings.model, fx: fx!, images: fixtures.length });
    await mkdir(path.dirname(values.summary), { recursive: true });
    await writeFile(values.summary, md);
    log(md);
    log(`wrote ${values.out} / ${values.summary}`);
    return 0;
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
