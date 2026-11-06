// worker のエントリ（docs/mvp-plan-v0.1.md T1-8、§4.4 keihi-worker.service）。
// 実行可能なジョブが無くなったら（[worker] linger_ms の猶予の後）終了する（ワンショット）。常駐しない。ポートを開かない。
// 再試行のバックオフや取りこぼしは keihi-worker.timer（2 分ごと）が拾う。
// - Provider は config.toml の [provider] kind（既定 freee）と [freee] target（既定 poc）から、最初に要るジョブで 1 回だけ作る
//   （設定が無くても Provider を使わないジョブは動く）。freee の予算の日の区切りは [freee] day_boundary。
// - Gemini（[gemini]）も同じく、最初に要るジョブで 1 回だけ作る（no_ai の抽出では作らない）。
//
//   node src/worker/main.ts [--db /path/to.db]
import { parseArgs } from 'node:util';
import { createGeminiFromConfig, type Gemini } from '../ai/gemini/client.ts';
import { loadConfig, requireFreee, type Config } from '../config.ts';
import { openDb, type Db } from '../db/index.ts';
import { runUntilEmpty, type Handlers, type RunOptions } from '../jobs/worker.ts';
import { createFakeProvider } from '../providers/fake/index.ts';
import { refreshIfExpiringSoon, TOKEN_URL, TokenStore } from '../providers/freee/auth.ts';
import { budgetedFetch, createBudget, resetHourJstFor } from '../providers/freee/budget.ts';
import { createFreeeProvider, freeeTokenPaths, type FreeeProvider } from '../providers/freee/provider.ts';
import { createDailyHandler } from './handlers/daily.ts';
import { createExtractHandler } from './handlers/extract.ts';
import { createReconcileHandler } from './handlers/reconcile.ts';
import { createSendDealHandler } from './handlers/send.ts';
import { createSyncBankHandler } from './handlers/syncBank.ts';
import { createUpdateReceiptMetaHandler } from './handlers/updateReceiptMeta.ts';
import { createUploadReceiptHandler } from './handlers/uploadReceipt.ts';

export type WorkerRuntime = {
  cfg: Config;
  db: Db;
  provider(): FreeeProvider;
  gemini(): Gemini;
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

// daily のトークン更新（残り 30 日）。トークンエンドポイントの呼び出しは予算（auth）に通す。fake では null。
export function buildTokenRefresher(cfg: Config, db: Db, opts: { fetch?: typeof fetch } = {}) {
  if (cfg.provider.kind === 'fake') return null;
  return () => {
    const f = requireFreee(cfg, cfg.freee.target);
    const { tokenPath, lockPath } = freeeTokenPaths(cfg.dataDir);
    const budget = createBudget({ db, resetHourJst: resetHourJstFor(cfg.freee.dayBoundary) });
    return refreshIfExpiringSoon({
      store: new TokenStore(tokenPath, lockPath),
      creds: { clientId: f.clientId, clientSecret: f.clientSecret },
      fetch: budgetedFetch(budget, 'auth', new URL(TOKEN_URL).pathname, opts.fetch ?? fetch),
    });
  };
}

export function createRuntime(cfg: Config, db: Db, opts: { fetch?: typeof fetch } = {}): WorkerRuntime {
  let provider: FreeeProvider | null = null;
  let gemini: Gemini | null = null;
  return {
    cfg,
    db,
    provider: () => (provider ??= buildProvider(cfg, db, opts)),
    gemini: () => (gemini ??= createGeminiFromConfig(cfg, { fetch: opts.fetch })),
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
    return {
      provider: rt.provider(),
      objectsDir: rt.cfg.objectsDir,
      calendar: { yearEndHolidays: rt.cfg.calendar.yearEndHolidays },
      reauthWaitDays: rt.cfg.worker.reauthWaitDays,
    };
  }),
  extract: createExtractHandler(() => {
    const rt = runtime();
    return { gemini: rt.gemini, objectsDir: rt.cfg.objectsDir };
  }),
  update_receipt_meta: createUpdateReceiptMetaHandler(() => ({ provider: runtime().provider() })),
  send_deal: createSendDealHandler(() => ({ provider: runtime().provider() })),
  reconcile_deals: createReconcileHandler(() => {
    const rt = runtime();
    return { provider: rt.provider(), verifiedLookbackDays: rt.cfg.reconcile.verifiedLookbackDays, maxListPages: rt.cfg.reconcile.maxListPages };
  }),
  sync_bank: createSyncBankHandler(() => {
    const rt = runtime();
    return { provider: rt.provider(), providerKind: rt.cfg.provider.kind, backfillFrom: rt.cfg.bank.backfillFrom, transferWindowDays: rt.cfg.bank.transferWindowDays };
  }),
  daily: createDailyHandler(() => {
    const rt = runtime();
    return {
      provider: rt.provider,
      providerKind: rt.cfg.provider.kind,
      refreshToken: buildTokenRefresher(rt.cfg, rt.db),
      // 月 1 回の証憑の照合は予算の用途 sync で数える（既定の user ではない）。
      remoteVerify: {
        provider: () => {
          const p = rt.provider();
          return { downloadReceipt: (id: number) => p.downloadReceipt(id, { purpose: 'sync' }) };
        },
        objectsDir: rt.cfg.objectsDir,
        mode: rt.cfg.backup.remoteVerifyMode,
      },
    };
  }),
};

// 実行環境を設定して HANDLERS を動かす（テストからも使う）。
export async function runWith(rt: WorkerRuntime, opts: RunOptions = {}) {
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
    const s = await runWith(createRuntime(cfg, db), { log: (s) => console.log(s), lingerMs: cfg.worker.lingerMs });
    console.log(`worker: done=${s.done} failed=${s.failed}`);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
