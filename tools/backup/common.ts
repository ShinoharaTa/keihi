// tools/backup/run.ts と drill.ts の共通部分: 引数、設定、DB、restic の用意。
// 終了コード: 0 = 成功 / 1 = バックアップ・訓練の失敗（audit に記録済み）/ 2 = 設定・restic・DB が無いなど始められない。
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { appendAudit } from '../../src/audit.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { createRestic, ResticNotFoundError, type Restic } from '../../src/backup/restic.ts';
import { findRestic, loadBackupSettings, type BackupSettings } from '../../src/backup/settings.ts';

export type Prepared = { settings: BackupSettings; db: Db; restic: Restic };

export const COMMON_OPTIONS = { 'config-dir': { type: 'string' }, 'data-dir': { type: 'string' } } as const;

export function parseCommon(argv: string[]) {
  return parseArgs({ args: argv, options: COMMON_OPTIONS });
}

// 始められないときは例外を投げる。restic が無いときは、DB に audit で失敗を残してから投げる（DB が無ければ作らない）。
export function prepare(values: { 'config-dir'?: string; 'data-dir'?: string }, action: string, env: NodeJS.ProcessEnv = process.env): Prepared {
  const settings = loadBackupSettings({ configDir: values['config-dir'], dataDir: values['data-dir'] });
  if (!existsSync(settings.dbPath)) throw new Error(`${settings.dbPath} が無い（npm run migrate の後に実行する）`);
  const db = openDb(settings.dbPath);
  const bin = findRestic(env);
  if (!bin) {
    const e = new ResticNotFoundError();
    appendAudit(db, { actor: 'backup', action, entity: 'backup', payload: { ok: false, error: e.message } });
    db.close();
    throw e;
  }
  return { settings, db, restic: createRestic(bin, settings.resticEnv, env) };
}
