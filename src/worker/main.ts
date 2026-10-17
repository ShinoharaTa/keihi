// worker のエントリ（docs/mvp-plan-v0.1.md T1-8、§4.4 keihi-worker.service）。
// 実行可能なジョブが無くなったら終了する（ワンショット）。常駐しない。ポートを開かない。
// - Provider は config.toml の [provider] kind（既定 freee）と [freee] target（既定 poc）から、最初に要るジョブで 1 回だけ作る
//   （設定が無くても Provider を使わないジョブは動く）。freee の予算の日の区切りは [freee] day_boundary。
//
//   node src/worker/main.ts [--db /path/to.db]
import { parseArgs } from 'node:util';
import { loadConfig, requireFreee, type Config } from '../config.ts';
import { openDb, type Db } from '../db/index.ts';
import { runUntilEmpty, type Handlers } from '../jobs/worker.ts';
import { createFakeProvider } from '../providers/fake/index.ts';
import { resetHourJstFor } from '../providers/freee/budget.ts';
import { createFreeeProvider, freeeTokenPaths, type FreeeProvider } from '../providers/freee/provider.ts';
import { extract } from './handlers/extract.ts';
import { createUploadReceiptHandler } from './handlers/uploadReceipt.ts';

export type WorkerRuntime = {
  cfg: Config;
  db: Db;
  provider(): FreeeProvider;
};

// 設定から Provider を組み立てる。fake は開発用（freee を呼ばない。状態はこのプロセスの中だけ）。
export function buildProvider(cfg: Config, db: Db, opts: { fetch?: typeof fetch } = {}): FreeeProvider {
  if (cfg.provider.kind === 'fake') return createFakeProvider();
  const f = requireFreee(cfg, cfg.freee.target);
  const { tokenPath, lockPath } = freeeTokenPaths(cfg.dataDir);
  return createFreeeProvider({
    db,
    companyId: f.companyId,
    creds: { clientId: f.clientId, clientSecret: f.clientSecret },
    tokenPath,
    lockPath,
    fetch: opts.fetch,
    resetHourJst: resetHourJstFor(cfg.freee.dayBoundary),
  });
}

export function createRuntime(cfg: Config, db: Db, opts: { fetch?: typeof fetch } = {}): WorkerRuntime {
  let provider: FreeeProvider | null = null;
  return {
    cfg,
    db,
    provider: () => (provider ??= buildProvider(cfg, db, opts)),
  };
}

let current: WorkerRuntime | null = null;

function runtime(): WorkerRuntime {
  if (!current) throw new Error('worker の実行環境が未設定（main() から動かす）');
  return current;
}

// HANDLERS はテストと他のハンドラの登録のために定数のまま置く。依存は main() が設定した実行環境から取る。
export const HANDLERS: Handlers = {
  upload_receipt: createUploadReceiptHandler(() => {
    const rt = runtime();
    return { provider: rt.provider(), objectsDir: rt.cfg.objectsDir, calendar: { yearEndHolidays: rt.cfg.calendar.yearEndHolidays } };
  }),
  extract,
};

// 実行環境を設定して HANDLERS を動かす（テストからも使う）。
export async function runWith(rt: WorkerRuntime, opts: { now?: () => Date; log?: (s: string) => void } = {}) {
  current = rt;
  try {
    return await runUntilEmpty(rt.db, HANDLERS, opts);
  } finally {
    current = null;
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { db: { type: 'string' } } });
  const cfg = loadConfig();
  const db = openDb(values.db ?? cfg.dbPath);
  try {
    const s = await runWith(createRuntime(cfg, db), { log: (s) => console.log(s) });
    console.log(`worker: done=${s.done} failed=${s.failed}`);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
