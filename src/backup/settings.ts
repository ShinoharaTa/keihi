// バックアップ系（tools/backup/*、src/backup/*）の設定（docs/mvp-plan.md M5、docs/mvp-plan-v0.1.md T5-0〜T5-3）。
// - config.toml の [paths]・[backup] は src/config.ts の loadConfig で読む（知らないセクション・キーはエラー）。
// - restic に渡すシークレットは secrets.env（0600 以外は拒否）から、決めた名前のものだけを取り出す。
//   GEMINI_API_KEY・FREEE_* は restic の子プロセスに渡さない。値はエラーメッセージに含めない。
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig, parseEnv, type RemoteVerifyMode } from '../config.ts';

export type { RemoteVerifyMode } from '../config.ts';
export { DEFAULT_CHECK_INTERVAL_DAYS, DEFAULT_KEEP_SNAPSHOTS, DEFAULT_READ_DATA_SUBSET, DEFAULT_REMOTE_VERIFY_MODE } from '../config.ts';

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
  const cfg = loadConfig(opts);
  const b = cfg.backup;
  const secretsPath = path.join(cfg.configDir, 'secrets.env');
  const resticEnv = readResticSecrets(secretsPath);
  const repository = b.repository ?? resticEnv.RESTIC_REPOSITORY ?? null;
  if (repository !== null) resticEnv.RESTIC_REPOSITORY = repository;

  return {
    configDir: cfg.configDir,
    dataDir: cfg.dataDir,
    dbPath: cfg.dbPath,
    objectsDir: cfg.objectsDir,
    snapshotsDir: path.join(cfg.dataDir, 'snapshots'),
    freeeTokenPath: cfg.freeeTokenPath,
    secretsPath,
    repository,
    keepSnapshots: b.keepSnapshots,
    checkIntervalDays: b.checkIntervalDays,
    readDataSubset: b.readDataSubset,
    drillDir: b.drillDir,
    remoteVerifyMode: b.remoteVerifyMode,
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
