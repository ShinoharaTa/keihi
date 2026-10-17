// リストア訓練（docs/mvp-plan-v0.1.md T5-3）。keihi-drill.timer から四半期に 1 回呼ぶ。中身は src/backup/drill.ts。
//
//   node tools/backup/drill.ts [--config-dir DIR] [--data-dir DIR]
//
// 結果は標準出力と audit（backup.drill）。失敗は終了コード 1（復元先は調査用に残す）。始められないときは 2。
// 通知（Q6）は未決なので、ここでは行わない。
import { runDrill } from '../../src/backup/drill.ts';
import { parseCommon, prepare } from './common.ts';

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let values;
  try {
    values = parseCommon(argv).values;
  } catch (e) {
    console.error(`使い方: node tools/backup/drill.ts [--config-dir DIR] [--data-dir DIR]（${e instanceof Error ? e.message : String(e)}）`);
    return 2;
  }
  let p;
  try {
    p = prepare(values, 'backup.drill', env);
  } catch (e) {
    console.error(`drill: 開始できない: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  try {
    const r = await runDrill({ settings: p.settings, db: p.db, restic: p.restic });
    const summary = `snapshot=${r.snapshot ?? '-'}、check=${r.check}、documents=${r.documents}、objects=${r.objectsVerified}（スナップショット後の追加 ${r.objectsExtra}）`;
    if (r.ok) {
      console.log(`drill: ok（${summary}）`);
      return 0;
    }
    console.error(`drill: 失敗 ${r.failureCount} 件（${summary}）`);
    for (const f of r.failures) console.error(`  - ${f}`);
    if (r.kept) console.error(`復元先を残した: ${r.target}`);
    return 1;
  } finally {
    p.db.close();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
