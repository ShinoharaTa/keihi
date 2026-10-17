// バックアップ系（tools/backup/*、src/backup/*）の設定（docs/mvp-plan.md M5、docs/mvp-plan-v0.1.md T5-0〜T5-3）。
// - src/config.ts の loadConfig は知らないセクションを拒否するので、[backup] が config.ts に統合されるまでは
//   ここで config.toml を自前で読む。見るのは [paths] data_dir と [backup] だけ（他のセクションは無視する）。
// - [backup] の知らないキーはエラー（綴り違いで安全側の設定が効かないのを防ぐ。config.ts と同じ方針）。
// - restic に渡すシークレットは secrets.env（0600 以外は拒否）から、決めた名前のものだけを取り出す。
//   GEMINI_API_KEY・FREEE_* は restic の子プロセスに渡さない。値はエラーメッセージに含めない。
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ConfigError, DEFAULT_CONFIG_DIR, DEFAULT_DATA_DIR, parseEnv } from '../config.ts';

export type RemoteVerifyMode = 'sha256' | 'download_only';

export const DEFAULT_KEEP_SNAPSHOTS = 7;
export const DEFAULT_CHECK_INTERVAL_DAYS = 7;
export const DEFAULT_READ_DATA_SUBSET = '5%';
// F6（freee が再圧縮するか）が未確認なので、既定は「ダウンロードできること」の確認だけ。
export const DEFAULT_REMOTE_VERIFY_MODE: RemoteVerifyMode = 'download_only';

// secrets.env から restic の子プロセスに渡す名前（保存先の差し替え: b2 / s3 互換 / sftp / ローカル。Q4）。
export const RESTIC_SECRET_KEYS = [
  'RESTIC_PASSWORD',
  'RESTIC_REPOSITORY',
  'B2_ACCOUNT_ID',
  'B2_ACCOUNT_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_DEFAULT_REGION',
] as const;

const BACKUP_KEYS = ['repository', 'keep_snapshots', 'check_interval_days', 'read_data_subset', 'drill_dir', 'remote_verify_mode'];

export type BackupSettings = {
  configDir: string;
  dataDir: string;
  dbPath: string;
  objectsDir: string;
  snapshotsDir: string;
  freeeTokenPath: string;
  secretsPath: string;
  // restic の保存先。config の [backup] repository、無ければ secrets.env の RESTIC_REPOSITORY。
  repository: string | null;
  keepSnapshots: number;
  checkIntervalDays: number;
  readDataSubset: string;
  // リストア訓練の復元先の親ディレクトリ（毎回この下に drill-<ts> を作る）。
  drillDir: string;
  remoteVerifyMode: RemoteVerifyMode;
  // restic に渡す環境変数（secrets.env の RESTIC_SECRET_KEYS のうち値があるもの）。
  resticEnv: Record<string, string>;
};

export type BackupLoadOptions = { configDir?: string; dataDir?: string };

type Table = Record<string, unknown>;

function readToml(file: string): Table {
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  try {
    return parseToml(src) as Table;
  } catch (e) {
    throw new ConfigError(`${file} を解釈できない: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

function table(t: Table, name: string): Table {
  const v = t[name];
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(`config.toml の ${name} はテーブルで書く`);
  return v as Table;
}

function str(sec: Table, name: string, key: string): string | null {
  const v = sec[key];
  if (v === undefined) return null;
  if (typeof v !== 'string' || !v) throw new ConfigError(`config.toml の ${name}.${key} は空でない文字列で指定する`);
  return v;
}

function posInt(sec: Table, name: string, key: string): number | null {
  let v = sec[key];
  if (v === undefined) return null;
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new ConfigError(`config.toml の ${name}.${key} は正の整数で指定する`);
  return v;
}

function readResticSecrets(file: string): Record<string, string> {
  let st;
  try {
    st = statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  if (!st.isFile()) throw new ConfigError(`${file} が通常のファイルではない`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) throw new ConfigError(`${file} のパーミッションが 0600 ではない（現在 0${mode.toString(8)}）。chmod 600 してから実行する`);
  const env = parseEnv(readFileSync(file, 'utf8'));
  const out: Record<string, string> = {};
  for (const k of RESTIC_SECRET_KEYS) if (env[k]) out[k] = env[k];
  return out;
}

export function loadBackupSettings(opts: BackupLoadOptions = {}): BackupSettings {
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const t = readToml(path.join(configDir, 'config.toml'));
  const paths = table(t, 'paths');
  const b = table(t, 'backup');
  for (const k of Object.keys(b)) if (!BACKUP_KEYS.includes(k)) throw new ConfigError(`config.toml の backup.${k} は知らないキー`);

  const dataDir = opts.dataDir ?? str(paths, 'paths', 'data_dir') ?? DEFAULT_DATA_DIR;
  if (!path.isAbsolute(dataDir)) throw new ConfigError('config.toml の paths.data_dir は絶対パスで指定する');
  const drillDir = str(b, 'backup', 'drill_dir') ?? path.join(dataDir, 'drill');
  if (!path.isAbsolute(drillDir)) throw new ConfigError('config.toml の backup.drill_dir は絶対パスで指定する');
  const mode = str(b, 'backup', 'remote_verify_mode') ?? DEFAULT_REMOTE_VERIFY_MODE;
  if (mode !== 'sha256' && mode !== 'download_only') throw new ConfigError('config.toml の backup.remote_verify_mode は "sha256" か "download_only"');
  const subset = str(b, 'backup', 'read_data_subset') ?? DEFAULT_READ_DATA_SUBSET;
  if (!/^(?:\d{1,2}(?:\.\d+)?%|100%)$/.test(subset)) throw new ConfigError('config.toml の backup.read_data_subset は "5%" のような割合で指定する');

  const secretsPath = path.join(configDir, 'secrets.env');
  const resticEnv = readResticSecrets(secretsPath);
  const repository = str(b, 'backup', 'repository') ?? resticEnv.RESTIC_REPOSITORY ?? null;
  if (repository !== null) resticEnv.RESTIC_REPOSITORY = repository;

  return {
    configDir,
    dataDir,
    dbPath: path.join(dataDir, 'keihi.db'),
    objectsDir: path.join(dataDir, 'objects'),
    snapshotsDir: path.join(dataDir, 'snapshots'),
    freeeTokenPath: path.join(dataDir, 'freee-token.json'),
    secretsPath,
    repository,
    keepSnapshots: posInt(b, 'backup', 'keep_snapshots') ?? DEFAULT_KEEP_SNAPSHOTS,
    checkIntervalDays: posInt(b, 'backup', 'check_interval_days') ?? DEFAULT_CHECK_INTERVAL_DAYS,
    readDataSubset: subset,
    drillDir,
    remoteVerifyMode: mode,
    resticEnv,
  };
}

// restic の実行ファイル。RESTIC_BIN（テストで偽物に差し替える）→ ~/.local/bin/restic → PATH の restic。
// systemd --user の PATH には ~/.local/bin が入らないので、明示的に見る。見つからなければ null。
export function findRestic(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.RESTIC_BIN) return isExecutable(env.RESTIC_BIN) ? env.RESTIC_BIN : null;
  const cands = [path.join(env.HOME || homedir(), '.local', 'bin', 'restic')];
  for (const d of (env.PATH ?? '').split(path.delimiter)) if (d) cands.push(path.join(d, 'restic'));
  return cands.find(isExecutable) ?? null;
}

function isExecutable(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
