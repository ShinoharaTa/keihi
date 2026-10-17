// 設定とシークレットの読み込み（docs/mvp-plan.md T1-2、docs/mvp-plan-v0.1.md T1-2、§4.3）。
// - ~/.config/keihi/config.toml（シークレットを置かない）+ ~/.config/keihi/secrets.env（0600 以外は拒否）。
// - 形式は PoC（tools/poc/*.ts）と互換: [gemini] model / paid_tier_confirmed、[freee] poc_company_id / prod_company_id、
//   secrets.env の GEMINI_API_KEY / FREEE_CLIENT_ID / FREEE_CLIENT_SECRET。
// - 知らないセクション・キーはエラーにする（綴り違いで安全側の設定が効かないのを防ぐ）。
// - ディレクトリは作らない。シークレットの値はエラーメッセージに含めない。dumpConfig はシークレットを *** にする。
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

export const DEFAULT_CONFIG_DIR = path.join(homedir(), '.config', 'keihi');
export const DEFAULT_DATA_DIR = path.join(homedir(), '.local', 'share', 'keihi');
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
// T1-6: 取り込みのサイズ上限の初期値（freee は 64MB。mvp-plan.md T1-6 の変更）。
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type DeadlineMode = 'early' | 'cycle';
export type FreeeTarget = 'poc' | 'prod';

export type Secrets = {
  geminiApiKey: string | null;
  freeeClientId: string | null;
  freeeClientSecret: string | null;
};

export type Config = {
  configDir: string;
  dataDir: string;
  dbPath: string;
  objectsDir: string;
  freeeTokenPath: string;
  gemini: { model: string; paidTierConfirmed: boolean };
  freee: { pocCompanyId: number | null; prodCompanyId: number | null };
  ingest: { maxBytes: number };
  // R6。deadline_mode の既定は短い方（早期入力方式）。年末年始（12/29〜1/3）は既定で休業日に含めない（短い方に倒す）。
  calendar: { deadlineMode: DeadlineMode; yearEndHolidays: boolean };
  secrets: Secrets;
};

export type LoadOptions = { configDir?: string; dataDir?: string };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// secrets.env の最小パーサ（KEY=VALUE、# コメント、両端の引用符、先頭の export）。値はエラーに含めない。
export function parseEnv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line0 of src.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

type Table = Record<string, unknown>;

const KNOWN: Record<string, string[]> = {
  paths: ['data_dir'],
  gemini: ['model', 'paid_tier_confirmed'],
  freee: ['poc_company_id', 'prod_company_id'],
  ingest: ['max_upload_bytes'],
  calendar: ['deadline_mode', 'year_end_holidays'],
};

function readConfigToml(file: string): Table {
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let t: Table;
  try {
    t = parseToml(src) as Table;
  } catch (e) {
    throw new ConfigError(`${file} を解釈できない: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  for (const [sec, v] of Object.entries(t)) {
    const keys = KNOWN[sec];
    if (!keys) throw new ConfigError(`${file} の [${sec}] は知らないセクション`);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(`${file} の ${sec} はテーブルで書く`);
    for (const k of Object.keys(v)) if (!keys.includes(k)) throw new ConfigError(`${file} の ${sec}.${k} は知らないキー`);
  }
  return t;
}

function section(t: Table, name: string): Table {
  return (t[name] as Table | undefined) ?? {};
}

function optString(t: Table, sec: string, key: string): string | null {
  const v = section(t, sec)[key];
  if (v === undefined) return null;
  if (typeof v !== 'string' || !v) throw new ConfigError(`config.toml の ${sec}.${key} は空でない文字列で指定する`);
  return v;
}

function optBool(t: Table, sec: string, key: string): boolean | null {
  const v = section(t, sec)[key];
  if (v === undefined) return null;
  if (typeof v !== 'boolean') throw new ConfigError(`config.toml の ${sec}.${key} は true / false で指定する`);
  return v;
}

function optPositiveInt(t: Table, sec: string, key: string): number | null {
  let v = section(t, sec)[key];
  if (v === undefined) return null;
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new ConfigError(`config.toml の ${sec}.${key} は正の整数で指定する`);
  return v;
}

function readSecrets(file: string): Secrets {
  let st;
  try {
    st = statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { geminiApiKey: null, freeeClientId: null, freeeClientSecret: null };
    throw e;
  }
  if (!st.isFile()) throw new ConfigError(`${file} が通常のファイルではない`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) throw new ConfigError(`${file} のパーミッションが 0600 ではない（現在 0${mode.toString(8)}）。chmod 600 してから起動する`);
  const env = parseEnv(readFileSync(file, 'utf8'));
  return {
    geminiApiKey: env.GEMINI_API_KEY || null,
    freeeClientId: env.FREEE_CLIENT_ID || null,
    freeeClientSecret: env.FREEE_CLIENT_SECRET || null,
  };
}

export function loadConfig(opts: LoadOptions = {}): Config {
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const t = readConfigToml(path.join(configDir, 'config.toml'));
  const dataDir = opts.dataDir ?? optString(t, 'paths', 'data_dir') ?? DEFAULT_DATA_DIR;
  if (!path.isAbsolute(dataDir)) throw new ConfigError('config.toml の paths.data_dir は絶対パスで指定する');
  const mode = optString(t, 'calendar', 'deadline_mode') ?? 'early';
  if (mode !== 'early' && mode !== 'cycle') throw new ConfigError('config.toml の calendar.deadline_mode は "early" か "cycle"');
  const pocCompanyId = optPositiveInt(t, 'freee', 'poc_company_id');
  const prodCompanyId = optPositiveInt(t, 'freee', 'prod_company_id');
  if (pocCompanyId !== null && pocCompanyId === prodCompanyId) throw new ConfigError('config.toml の freee.poc_company_id と prod_company_id が同じ');
  return {
    configDir,
    dataDir,
    dbPath: path.join(dataDir, 'keihi.db'),
    objectsDir: path.join(dataDir, 'objects'),
    freeeTokenPath: path.join(dataDir, 'freee-token.json'),
    gemini: {
      model: optString(t, 'gemini', 'model') ?? DEFAULT_GEMINI_MODEL,
      paidTierConfirmed: optBool(t, 'gemini', 'paid_tier_confirmed') ?? false,
    },
    freee: { pocCompanyId, prodCompanyId },
    ingest: { maxBytes: optPositiveInt(t, 'ingest', 'max_upload_bytes') ?? DEFAULT_MAX_UPLOAD_BYTES },
    calendar: { deadlineMode: mode, yearEndHolidays: optBool(t, 'calendar', 'year_end_holidays') ?? false },
    secrets: readSecrets(path.join(configDir, 'secrets.env')),
  };
}

// Gemini を呼ぶ処理の起動時に呼ぶ。有料 tier の確認とキーが無ければ止める（classification-ocr.md の受け入れ条件）。
export function requireGemini(cfg: Config): { model: string; apiKey: string } {
  if (!cfg.gemini.paidTierConfirmed) {
    throw new ConfigError(
      `${path.join(cfg.configDir, 'config.toml')} に [gemini] paid_tier_confirmed = true が無い。` +
        '無料枠のキーは使わない（Cloud Billing を有効にした keihi 専用プロジェクトのキーだけを使う）',
    );
  }
  if (!cfg.secrets.geminiApiKey) throw new ConfigError(`${path.join(cfg.configDir, 'secrets.env')} に GEMINI_API_KEY が無い`);
  return { model: cfg.gemini.model, apiKey: cfg.secrets.geminiApiKey };
}

// freee を呼ぶ処理の起動時に呼ぶ。対象の事業所 ID（テストと本番は別の名前）と client_id / secret が無ければ止める。
export function requireFreee(cfg: Config, target: FreeeTarget): { companyId: number; clientId: string; clientSecret: string } {
  const key = target === 'prod' ? 'prod_company_id' : 'poc_company_id';
  const companyId = target === 'prod' ? cfg.freee.prodCompanyId : cfg.freee.pocCompanyId;
  if (companyId === null) throw new ConfigError(`${path.join(cfg.configDir, 'config.toml')} に [freee] ${key} が無い`);
  const secretsPath = path.join(cfg.configDir, 'secrets.env');
  if (!cfg.secrets.freeeClientId) throw new ConfigError(`${secretsPath} に FREEE_CLIENT_ID が無い`);
  if (!cfg.secrets.freeeClientSecret) throw new ConfigError(`${secretsPath} に FREEE_CLIENT_SECRET が無い`);
  return { companyId, clientId: cfg.secrets.freeeClientId, clientSecret: cfg.secrets.freeeClientSecret };
}

const mask = (v: string | null) => (v === null ? null : '***');

// 設定値のダンプ（ログ・CLI 表示用）。シークレットは *** にする。トークンは設定に持たないのでパスだけ出す。
export function dumpConfig(cfg: Config): string {
  const safe = {
    ...cfg,
    secrets: {
      geminiApiKey: mask(cfg.secrets.geminiApiKey),
      freeeClientId: mask(cfg.secrets.freeeClientId),
      freeeClientSecret: mask(cfg.secrets.freeeClientSecret),
    },
  };
  return JSON.stringify(safe, null, 2);
}
