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
// U7 の暫定（mvp-plan.md §3.2）。T0-3r の結果で変える。
export const DEFAULT_THINKING_LEVEL = 'low';
export const DEFAULT_MEDIA_RESOLUTION = 'medium';
// 出力トークン（思考トークン込み）の上限。トークン爆発の防止。応答の JSON は 1〜2 千トークン、思考は low で数百〜数千。
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
// T1-6: 取り込みのサイズ上限の初期値（freee は 64MB。mvp-plan.md T1-6 の変更）。
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// T1-14（D4）: web は 127.0.0.1 の固定ポート。バインド先は設定にしない（0.0.0.0 にできないようにする）。
export const WEB_HOST = '127.0.0.1';
export const DEFAULT_WEB_PORT = 8795;
// M7（keihi MCP）用に予約するだけ。M7 までは何も開かない。
export const DEFAULT_MCP_PORT = 8796;
// [backup]（docs/ops/backup.md、src/backup/*）。
export const DEFAULT_KEEP_SNAPSHOTS = 7;
export const DEFAULT_CHECK_INTERVAL_DAYS = 7;
export const DEFAULT_READ_DATA_SUBSET = '5%';
// F6（freee が再圧縮するか）が未確認なので、既定は「ダウンロードできること」の確認だけ。
export const DEFAULT_REMOTE_VERIFY_MODE: RemoteVerifyMode = 'download_only';
// [worker]（src/jobs/worker.ts）。キューが空になってからもう一度 claim するまでの猶予。
export const DEFAULT_WORKER_LINGER_MS = 1500;
// 再認可待ち（invalid_grant）のアップロードを待つ上限の日数。過ぎたら needs_attention にしてジョブを終える。
export const DEFAULT_REAUTH_WAIT_DAYS = 7;
// [reconcile]（src/deals/reconcile.ts）。verified を照合し直す発生日の日数と、listDeals を取るページ数の上限。
export const DEFAULT_VERIFIED_LOOKBACK_DAYS = 35;
export const DEFAULT_MAX_LIST_PAGES = 20;
// [retention]（docs/ops/retention.md の案。税理士確認 #8 で確定する）。
export const DEFAULT_RETENTION_YEARS = 7;
export const DEFAULT_RETENTION_EXTRA_YEARS = 1;
export const DEFAULT_RETENTION_START: RetentionStart = 'next_year_0316';
// [bank]（docs/mvp-plan-v3.md T104・T106・T107・T206）。backfill_from は V8 の初期案（周期の検出に 2 年分）。
export const DEFAULT_BACKFILL_FROM = '2025-01-01';
export const DEFAULT_DEDUP_DATE_WINDOW_DAYS = 0;
export const DEFAULT_TRANSFER_WINDOW_DAYS = 3;
export const DEFAULT_MATCH_DATE_WINDOW_DAYS = 3;
// カードの口座の照合の幅（Amazon は注文日と請求日がずれる。docs/cashflow.md §15）。
export const DEFAULT_MATCH_CARD_DATE_WINDOW_DAYS = 10;
export const MAX_MATCH_CARD_DATE_WINDOW_DAYS = 31;
// [cashflow]（docs/mvp-plan-v3.md T303、V11 の初期案）。予定外の支出の目安は直近 6 か月の中央値、残す額は今後 3 か月分の予定支出。
export const DEFAULT_UNPLANNED_LOOKBACK_MONTHS = 6;
export const DEFAULT_RESERVE_MONTHS = 3;
export const MAX_UNPLANNED_LOOKBACK_MONTHS = 24;
export const MAX_RESERVE_MONTHS = 12;
// [mail]（docs/cashflow.md §16、src/mail/）。
export const DEFAULT_MAIL_LABEL = 'keihi';
export const DEFAULT_MAIL_MAX_MESSAGES_PER_RUN = 100;
export const MAX_MAIL_MAX_MESSAGES_PER_RUN = 500;
export const MAX_MAIL_LABEL_LENGTH = 100;
export const MAX_MAIL_QUERY_LENGTH = 500;
export const MAIL_ACCOUNT_ID_RE = /^[A-Za-z0-9-]{1,32}$/;

export type DeadlineMode = 'early' | 'cycle';
export type CountFrom = 'receipt_day' | 'next_day';
export type FreeeTarget = 'poc' | 'prod';
// 予算（T1-15）の日の区切り。F16 が分かるまで JST の暦日だけ。
export type DayBoundary = 'jst';
export type ProviderKind = 'freee' | 'fake';
export type ThinkingLevel = 'low' | 'medium' | 'high';
export type MediaResolution = 'low' | 'medium' | 'high';
const LEVELS = ['low', 'medium', 'high'] as const;
export type RemoteVerifyMode = 'sha256' | 'download_only';
// 起算日の規則。next_year_0316 = 受領日の年分の翌年 3/16（国税庁: 保存期間は確定申告期限の翌日から起算。docs/legal.md §1.5）。
export type RetentionStart = 'next_year_0316';
// "imap" は予約（実装していない。指定したら起動時エラー）。
export type MailProvider = 'gmail_api';
// since: 取り始める日。null なら初回実行日の 30 日前（src/mail/fetch.ts）。
export type MailAccount = { id: string; label: string; query: string; since: string | null };

export type Secrets = {
  geminiApiKey: string | null;
  freeeClientId: string | null;
  freeeClientSecret: string | null;
  gmailClientId: string | null;
  gmailClientSecret: string | null;
};

export type Config = {
  configDir: string;
  dataDir: string;
  dbPath: string;
  objectsDir: string;
  freeeTokenPath: string;
  gemini: { model: string; paidTierConfirmed: boolean; thinkingLevel: ThinkingLevel; mediaResolution: MediaResolution; maxOutputTokens: number };
  // target は worker が使う事業所（既定 poc。G1 で prod に変える）。
  freee: { pocCompanyId: number | null; prodCompanyId: number | null; target: FreeeTarget; dayBoundary: DayBoundary };
  // fake は開発用（プロセス内のメモリだけ。freee を呼ばない）。
  provider: { kind: ProviderKind };
  ingest: { maxBytes: number };
  // R6。deadline_mode の既定は短い方（早期入力方式）。年末年始（12/29〜1/3）は既定で休業日に含めない（短い方に倒す）。
  calendar: { deadlineMode: DeadlineMode; yearEndHolidays: boolean };
  // 7 営業日の数え始め。既定は早い方（受領日が営業日ならその日を 1 日目）。税理士確認 #3 の結果で変える前提。
  deadline: { countFrom: CountFrom };
  // T1-14。allowedUsers は Tailscale-User-Login の許可リスト（空なら誰も通さない）。
  // allowedHosts は Host ヘッダの許可リスト（`127.0.0.1:<port>` は常に含む。tailscale serve のホスト名は設定で足す）。
  web: { port: number; allowedUsers: string[]; allowedHosts: string[] };
  mcp: { port: number };
  // repository は restic の保存先（無ければ secrets.env の RESTIC_REPOSITORY。src/backup/settings.ts）。
  // drillDir はリストア訓練の復元先の親ディレクトリ（既定 <data_dir>/drill）。
  backup: {
    repository: string | null;
    keepSnapshots: number;
    checkIntervalDays: number;
    readDataSubset: string;
    drillDir: string;
    remoteVerifyMode: RemoteVerifyMode;
  };
  retention: { years: number; extraYears: number; start: RetentionStart };
  // lingerMs: キューが空と判断した後に待ってもう一度 claim する時間（start --no-block が動作中の oneshot に畳まれる対策）。
  // reauthWaitDays: 再認可待ちのアップロードを待つ上限の日数（src/worker/handlers/uploadReceipt.ts）。
  worker: { lingerMs: number; reauthWaitDays: number };
  // 日次照合（src/worker/handlers/reconcile.ts → src/deals/reconcile.ts）。
  reconcile: { verifiedLookbackDays: number; maxListPages: number };
  // 明細（R-A）。backfillFrom: 過去の明細を取り始める日（YYYY-MM-DD）。
  // dedupDateWindowDays: API と CSV の重複を照合する日付の幅。transferWindowDays: 振替の入出金の日付差の上限。
  // matchDateWindowDays: 領収書の日付から明細の日付までの幅。matchCardDateWindowDays: 同じくカードの口座の幅。
  bank: { backfillFrom: string; dedupDateWindowDays: number; transferWindowDays: number; matchDateWindowDays: number; matchCardDateWindowDays: number };
  // 資金繰り表（src/cashflow/forecast.ts）。unplannedLookbackMonths: 予定外の収支の目安を出すのに見る月数。
  // reserveMonths: 「月末に残す額」に積む予定支出の月数。includeUnplannedIncome: 予定外の収入の目安を残高に足すか（既定 false）。
  cashflow: { unplannedLookbackMonths: number; reserveMonths: number; includeUnplannedIncome: boolean };
  // メールからの証憑の取り込み。enabled = false なら daily も手動も積まない。accounts は [[mail.accounts]]（トークンはアカウントごと）。
  mail: { enabled: boolean; provider: MailProvider; maxMessagesPerRun: number; extractHints: boolean; accounts: MailAccount[] };
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
  gemini: ['model', 'paid_tier_confirmed', 'thinking_level', 'media_resolution', 'max_output_tokens'],
  freee: ['poc_company_id', 'prod_company_id', 'target', 'day_boundary'],
  provider: ['kind'],
  ingest: ['max_upload_bytes'],
  calendar: ['deadline_mode', 'year_end_holidays'],
  deadline: ['count_from'],
  web: ['port', 'allowed_users', 'allowed_hosts'],
  mcp: ['port'],
  backup: ['repository', 'keep_snapshots', 'check_interval_days', 'read_data_subset', 'drill_dir', 'remote_verify_mode'],
  retention: ['years', 'extra_years', 'start'],
  worker: ['linger_ms', 'reauth_wait_days'],
  reconcile: ['verified_lookback_days', 'max_list_pages'],
  bank: ['backfill_from', 'dedup_date_window_days', 'transfer_window_days', 'match_date_window_days', 'match_card_date_window_days'],
  cashflow: ['unplanned_lookback_months', 'reserve_months', 'include_unplanned_income'],
  mail: ['enabled', 'provider', 'max_messages_per_run', 'extract_hints', 'accounts'],
};
const MAIL_ACCOUNT_KEYS = ['id', 'label', 'query', 'since'];

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

function optEnum<T extends string>(t: Table, sec: string, key: string, values: readonly T[]): T | null {
  const v = optString(t, sec, key);
  if (v === null) return null;
  if (!(values as readonly string[]).includes(v)) throw new ConfigError(`config.toml の ${sec}.${key} は ${values.map((x) => `"${x}"`).join(' / ')} のどれか`);
  return v as T;
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

function optIntUpTo(t: Table, sec: string, key: string, max: number): number | null {
  const v = optPositiveInt(t, sec, key);
  if (v !== null && v > max) throw new ConfigError(`config.toml の ${sec}.${key} は 1〜${max} で指定する`);
  return v;
}

function optNonNegativeInt(t: Table, sec: string, key: string): number | null {
  let v = section(t, sec)[key];
  if (v === undefined) return null;
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ConfigError(`config.toml の ${sec}.${key} は 0 以上の整数で指定する`);
  return v;
}

function optNonNegativeIntUpTo(t: Table, sec: string, key: string, max: number): number | null {
  const v = optNonNegativeInt(t, sec, key);
  if (v !== null && v > max) throw new ConfigError(`config.toml の ${sec}.${key} は 0〜${max} で指定する`);
  return v;
}

function optStringArray(t: Table, sec: string, key: string): string[] | null {
  const v = section(t, sec)[key];
  if (v === undefined) return null;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x !== '')) {
    throw new ConfigError(`config.toml の ${sec}.${key} は空でない文字列の配列で指定する`);
  }
  return v as string[];
}

function optPort(t: Table, sec: string, key: string): number | null {
  const v = optPositiveInt(t, sec, key);
  if (v !== null && v > 65535) throw new ConfigError(`config.toml の ${sec}.${key} は 1〜65535 で指定する`);
  return v;
}

// YYYY-MM-DD で、暦にある日付。
function optDate(t: Table, sec: string, key: string): string | null {
  const v = section(t, sec)[key];
  if (v === undefined) return null;
  const msg = `config.toml の ${sec}.${key} は "YYYY-MM-DD" の文字列で指定する`;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ConfigError(msg);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new ConfigError(msg);
  return v;
}

// [mail] と [[mail.accounts]]。
function readMail(t: Table): Config['mail'] {
  const provider = optString(t, 'mail', 'provider') ?? 'gmail_api';
  if (provider === 'imap') throw new ConfigError('config.toml の mail.provider = "imap" はまだ実装していない（mail_provider_not_implemented）。"gmail_api" を使う');
  if (provider !== 'gmail_api') throw new ConfigError('config.toml の mail.provider は "gmail_api"');
  const raw = section(t, 'mail').accounts;
  if (raw !== undefined && (!Array.isArray(raw) || !raw.every((a) => typeof a === 'object' && a !== null && !Array.isArray(a)))) {
    throw new ConfigError('config.toml の mail.accounts は [[mail.accounts]] の表の配列で書く');
  }
  const accounts: MailAccount[] = [];
  for (const [i, a] of ((raw ?? []) as Table[]).entries()) {
    const where = `mail.accounts[${i}]`;
    for (const k of Object.keys(a)) if (!MAIL_ACCOUNT_KEYS.includes(k)) throw new ConfigError(`config.toml の ${where}.${k} は知らないキー`);
    const sub: Table = { [where]: a };
    const id = optString(sub, where, 'id');
    if (id === null || !MAIL_ACCOUNT_ID_RE.test(id)) throw new ConfigError(`config.toml の ${where}.id は英数字と - の 1〜32 字で指定する`);
    if (accounts.some((x) => x.id === id)) throw new ConfigError(`config.toml の mail.accounts の id "${id}" が重複している`);
    const label = optString(sub, where, 'label') ?? DEFAULT_MAIL_LABEL;
    if (label.length > MAX_MAIL_LABEL_LENGTH) throw new ConfigError(`config.toml の ${where}.label は 1〜${MAX_MAIL_LABEL_LENGTH} 字で指定する`);
    const query = a.query ?? '';
    if (typeof query !== 'string' || query.length > MAX_MAIL_QUERY_LENGTH) throw new ConfigError(`config.toml の ${where}.query は 0〜${MAX_MAIL_QUERY_LENGTH} 字の文字列で指定する`);
    accounts.push({ id, label, query, since: optDate(sub, where, 'since') });
  }
  return {
    enabled: optBool(t, 'mail', 'enabled') ?? false,
    provider,
    maxMessagesPerRun: optIntUpTo(t, 'mail', 'max_messages_per_run', MAX_MAIL_MAX_MESSAGES_PER_RUN) ?? DEFAULT_MAIL_MAX_MESSAGES_PER_RUN,
    extractHints: optBool(t, 'mail', 'extract_hints') ?? true,
    accounts,
  };
}

function readSecrets(file: string): Secrets {
  let st;
  try {
    st = statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { geminiApiKey: null, freeeClientId: null, freeeClientSecret: null, gmailClientId: null, gmailClientSecret: null };
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
    gmailClientId: env.GMAIL_CLIENT_ID || null,
    gmailClientSecret: env.GMAIL_CLIENT_SECRET || null,
  };
}

export function loadConfig(opts: LoadOptions = {}): Config {
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const t = readConfigToml(path.join(configDir, 'config.toml'));
  const dataDir = opts.dataDir ?? optString(t, 'paths', 'data_dir') ?? DEFAULT_DATA_DIR;
  if (!path.isAbsolute(dataDir)) throw new ConfigError('config.toml の paths.data_dir は絶対パスで指定する');
  const mode = optString(t, 'calendar', 'deadline_mode') ?? 'early';
  if (mode !== 'early' && mode !== 'cycle') throw new ConfigError('config.toml の calendar.deadline_mode は "early" か "cycle"');
  const countFrom = optString(t, 'deadline', 'count_from') ?? 'receipt_day';
  if (countFrom !== 'receipt_day' && countFrom !== 'next_day') throw new ConfigError('config.toml の deadline.count_from は "receipt_day" か "next_day"');
  const pocCompanyId = optPositiveInt(t, 'freee', 'poc_company_id');
  const prodCompanyId = optPositiveInt(t, 'freee', 'prod_company_id');
  if (pocCompanyId !== null && pocCompanyId === prodCompanyId) throw new ConfigError('config.toml の freee.poc_company_id と prod_company_id が同じ');
  const webPort = optPort(t, 'web', 'port') ?? DEFAULT_WEB_PORT;
  const mcpPort = optPort(t, 'mcp', 'port') ?? DEFAULT_MCP_PORT;
  if (webPort === mcpPort) throw new ConfigError('config.toml の web.port と mcp.port が同じ');
  const allowedHosts = [`${WEB_HOST}:${webPort}`];
  for (const h of optStringArray(t, 'web', 'allowed_hosts') ?? []) {
    const v = h.toLowerCase();
    if (!allowedHosts.includes(v)) allowedHosts.push(v);
  }
  const drillDir = optString(t, 'backup', 'drill_dir') ?? path.join(dataDir, 'drill');
  if (!path.isAbsolute(drillDir)) throw new ConfigError('config.toml の backup.drill_dir は絶対パスで指定する');
  const remoteVerifyMode = optString(t, 'backup', 'remote_verify_mode') ?? DEFAULT_REMOTE_VERIFY_MODE;
  if (remoteVerifyMode !== 'sha256' && remoteVerifyMode !== 'download_only') throw new ConfigError('config.toml の backup.remote_verify_mode は "sha256" か "download_only"');
  const readDataSubset = optString(t, 'backup', 'read_data_subset') ?? DEFAULT_READ_DATA_SUBSET;
  if (!/^(?:\d{1,2}(?:\.\d+)?%|100%)$/.test(readDataSubset)) throw new ConfigError('config.toml の backup.read_data_subset は "5%" のような割合で指定する');
  return {
    configDir,
    dataDir,
    dbPath: path.join(dataDir, 'keihi.db'),
    objectsDir: path.join(dataDir, 'objects'),
    freeeTokenPath: path.join(dataDir, 'freee-token.json'),
    gemini: {
      model: optString(t, 'gemini', 'model') ?? DEFAULT_GEMINI_MODEL,
      paidTierConfirmed: optBool(t, 'gemini', 'paid_tier_confirmed') ?? false,
      thinkingLevel: optEnum(t, 'gemini', 'thinking_level', LEVELS) ?? DEFAULT_THINKING_LEVEL,
      mediaResolution: optEnum(t, 'gemini', 'media_resolution', LEVELS) ?? DEFAULT_MEDIA_RESOLUTION,
      maxOutputTokens: optPositiveInt(t, 'gemini', 'max_output_tokens') ?? DEFAULT_MAX_OUTPUT_TOKENS,
    },
    freee: {
      pocCompanyId,
      prodCompanyId,
      target: optEnum(t, 'freee', 'target', ['poc', 'prod'] as const) ?? 'poc',
      dayBoundary: optEnum(t, 'freee', 'day_boundary', ['jst'] as const) ?? 'jst',
    },
    provider: { kind: optEnum(t, 'provider', 'kind', ['freee', 'fake'] as const) ?? 'freee' },
    ingest: { maxBytes: optPositiveInt(t, 'ingest', 'max_upload_bytes') ?? DEFAULT_MAX_UPLOAD_BYTES },
    calendar: { deadlineMode: mode, yearEndHolidays: optBool(t, 'calendar', 'year_end_holidays') ?? false },
    deadline: { countFrom },
    web: { port: webPort, allowedUsers: optStringArray(t, 'web', 'allowed_users') ?? [], allowedHosts },
    mcp: { port: mcpPort },
    backup: {
      repository: optString(t, 'backup', 'repository'),
      keepSnapshots: optPositiveInt(t, 'backup', 'keep_snapshots') ?? DEFAULT_KEEP_SNAPSHOTS,
      checkIntervalDays: optPositiveInt(t, 'backup', 'check_interval_days') ?? DEFAULT_CHECK_INTERVAL_DAYS,
      readDataSubset,
      drillDir,
      remoteVerifyMode,
    },
    retention: {
      years: optPositiveInt(t, 'retention', 'years') ?? DEFAULT_RETENTION_YEARS,
      extraYears: optNonNegativeInt(t, 'retention', 'extra_years') ?? DEFAULT_RETENTION_EXTRA_YEARS,
      start: optEnum(t, 'retention', 'start', ['next_year_0316'] as const) ?? DEFAULT_RETENTION_START,
    },
    worker: {
      lingerMs: optNonNegativeInt(t, 'worker', 'linger_ms') ?? DEFAULT_WORKER_LINGER_MS,
      reauthWaitDays: optPositiveInt(t, 'worker', 'reauth_wait_days') ?? DEFAULT_REAUTH_WAIT_DAYS,
    },
    reconcile: {
      verifiedLookbackDays: optPositiveInt(t, 'reconcile', 'verified_lookback_days') ?? DEFAULT_VERIFIED_LOOKBACK_DAYS,
      maxListPages: optPositiveInt(t, 'reconcile', 'max_list_pages') ?? DEFAULT_MAX_LIST_PAGES,
    },
    bank: {
      backfillFrom: optDate(t, 'bank', 'backfill_from') ?? DEFAULT_BACKFILL_FROM,
      dedupDateWindowDays: optNonNegativeInt(t, 'bank', 'dedup_date_window_days') ?? DEFAULT_DEDUP_DATE_WINDOW_DAYS,
      transferWindowDays: optNonNegativeInt(t, 'bank', 'transfer_window_days') ?? DEFAULT_TRANSFER_WINDOW_DAYS,
      matchDateWindowDays: optNonNegativeInt(t, 'bank', 'match_date_window_days') ?? DEFAULT_MATCH_DATE_WINDOW_DAYS,
      matchCardDateWindowDays: optNonNegativeIntUpTo(t, 'bank', 'match_card_date_window_days', MAX_MATCH_CARD_DATE_WINDOW_DAYS) ?? DEFAULT_MATCH_CARD_DATE_WINDOW_DAYS,
    },
    cashflow: {
      unplannedLookbackMonths: optIntUpTo(t, 'cashflow', 'unplanned_lookback_months', MAX_UNPLANNED_LOOKBACK_MONTHS) ?? DEFAULT_UNPLANNED_LOOKBACK_MONTHS,
      reserveMonths: optIntUpTo(t, 'cashflow', 'reserve_months', MAX_RESERVE_MONTHS) ?? DEFAULT_RESERVE_MONTHS,
      includeUnplannedIncome: optBool(t, 'cashflow', 'include_unplanned_income') ?? false,
    },
    mail: readMail(t),
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

// Gmail を呼ぶ処理の起動時に呼ぶ（client_id / secret は全アカウントで 1 組）。
export function requireGmail(cfg: Config): { clientId: string; clientSecret: string } {
  const secretsPath = path.join(cfg.configDir, 'secrets.env');
  if (!cfg.secrets.gmailClientId) throw new ConfigError(`${secretsPath} に GMAIL_CLIENT_ID が無い`);
  if (!cfg.secrets.gmailClientSecret) throw new ConfigError(`${secretsPath} に GMAIL_CLIENT_SECRET が無い`);
  return { clientId: cfg.secrets.gmailClientId, clientSecret: cfg.secrets.gmailClientSecret };
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
      gmailClientId: mask(cfg.secrets.gmailClientId),
      gmailClientSecret: mask(cfg.secrets.gmailClientSecret),
    },
  };
  return JSON.stringify(safe, null, 2);
}
