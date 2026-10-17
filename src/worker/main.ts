// worker のエントリ（docs/mvp-plan-v0.1.md T1-8、§4.4 keihi-worker.service）。
// 実行可能なジョブが無くなったら終了する（ワンショット）。常駐しない。ポートを開かない。
//
//   node src/worker/main.ts [--db /path/to.db]
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { runUntilEmpty, type Handlers } from '../jobs/worker.ts';
import { extract } from './handlers/extract.ts';
import { uploadReceipt } from './handlers/uploadReceipt.ts';

export const HANDLERS: Handlers = {
  upload_receipt: uploadReceipt,
  extract,
};

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { db: { type: 'string' } } });
  const file = values.db ?? loadConfig().dbPath;
  const db = openDb(file);
  try {
    const s = await runUntilEmpty(db, HANDLERS, { log: (s) => console.log(s) });
    console.log(`worker: done=${s.done} failed=${s.failed}`);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
