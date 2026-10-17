// 日次バックアップ（docs/mvp-plan-v0.1.md T5-2）。keihi-backup.timer から毎日呼ぶ。中身は src/backup/backup.ts。
//
//   node tools/backup/run.ts [--config-dir DIR] [--data-dir DIR] [--check | --no-check]
//
// restic は RESTIC_BIN → ~/.local/bin/restic → PATH の順に探す（docs/ops/backup.md）。
// 失敗は audit（backup.run）に記録し、終了コード 1。始められない（restic・DB・設定が無い）ときは 2。
import { parseArgs } from 'node:util';
import { runBackup } from '../../src/backup/backup.ts';
import { COMMON_OPTIONS, prepare } from './common.ts';

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let values;
  try {
    values = parseArgs({ args: argv, options: { ...COMMON_OPTIONS, check: { type: 'boolean' }, 'no-check': { type: 'boolean' } } }).values;
  } catch (e) {
    console.error(`使い方: node tools/backup/run.ts [--config-dir DIR] [--data-dir DIR] [--check | --no-check]（${e instanceof Error ? e.message : String(e)}）`);
    return 2;
  }
  if (values.check && values['no-check']) {
    console.error('--check と --no-check は同時に指定できない');
    return 2;
  }
  let p;
  try {
    p = prepare(values, 'backup.run', env);
  } catch (e) {
    console.error(`backup: 開始できない: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  try {
    const check = values.check ? true : values['no-check'] ? false : undefined;
    const r = await runBackup({ settings: p.settings, db: p.db, restic: p.restic, check });
    if (r.ok) {
      console.log(`backup: ok（snapshot=${r.snapshot}、restic=${r.resticSnapshotId ?? '-'}、check=${r.check}、古いスナップショットを ${r.prunedLocal} 個削除）`);
      return 0;
    }
    console.error(`backup: 失敗: ${r.error}`);
    return 1;
  } finally {
    p.db.close();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
