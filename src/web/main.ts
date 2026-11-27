// web サーバーの起動（docs/mvp-plan.md T1-14、docs/mvp-plan-v0.1.md T1-14・D4、§4.4 keihi-web.service）。
// - 既定は 127.0.0.1 の web.port（既定 8795）にだけバインドする。0.0.0.0 は環境変数 KEIHI_BIND_HOST でだけ（コンテナ用）。
//   ヘッダだけの認証（[web] auth = "tailscale"）のまま 127.0.0.1 以外にバインドしようとしたら起動しない（KEIHI_INSECURE_HEADER_AUTH=1 は手元の検証用）。
// - mcp.port（既定 8796）は M7 まで予約のみ。ここでは何も開かない。
// - マイグレーションは既定ではしない（先に `npm run migrate`）。KEIHI_MIGRATE_ON_START=1 のときだけ listen の前に適用する。データディレクトリは作らない。
// - PWA は pwa/dist/（`npm run build` の成果物）を配信する。無ければ API だけ動く。
// - worker の起動は [worker] mode（src/jobs/scheduler.ts）。systemd（既定）は今までどおり、spawn はこのプロセスが子プロセスで動かす（コンテナ用）。
// - SIGTERM / SIGINT で新しい接続を止め、処理中のリクエストを待って（最大 SHUTDOWN_GRACE_MS）、
//   並行して worker の子プロセスも止めて（最大 WORKER_STOP_TIMEOUT_MS。過ぎたら SIGKILL）、DB を閉じて終わる。
//
//   node src/web/main.ts [--config-dir DIR] [--data-dir DIR]
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { serve, type ServerType } from '@hono/node-server';
import { ConfigError, loadConfig, WEB_HOST, type Config } from '../config.ts';
import { openDb, type Db } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { createWorkerControl, type WorkerControl, type WorkerSpawn } from '../jobs/scheduler.ts';
import { addSecrets, log as processLog, setService, type Logger } from '../log.ts';
import { createApp, requestLogEnabled } from './app.ts';
import { createAuth } from './auth.ts';

export const PWA_DIST = path.resolve(import.meta.dirname, '../../pwa/dist');
// 停止のとき、処理中のリクエストを待つ上限。過ぎたら残りの接続を切る。
export const SHUTDOWN_GRACE_MS = 8000;
// 停止のとき、worker の子プロセスが実行中のジョブを終えるのを待つ上限。過ぎたら SIGKILL
// （切られたジョブは running のまま残り、15 分後に取り直される。src/jobs/queue.ts の LOCK_TIMEOUT_MS）。
// コンテナの停止の猶予（docker stop / Coolify の Stop Grace Period の既定 30 秒）に収まる長さにしている。
export const WORKER_STOP_TIMEOUT_MS = 20_000;

// 起動時の検査。ヘッダ（Tailscale-User-Login）だけの認証は、127.0.0.1 に来た接続を信用する前提（D7）なので、それ以外では使わない。
// none（認証なし）はバインド先に関わらず通し、warn を 1 行出す（届く範囲はネットワーク側で絞る前提）。
export function checkBindAuth(web: Pick<Config['web'], 'host' | 'auth'>, env: NodeJS.ProcessEnv, log: Logger = processLog): void {
  if (web.auth === 'none') {
    log.warn('web: 認証なし（[web] auth = "none"）で起動する。届く範囲はネットワーク側（VPN・LAN）で絞ること');
    return;
  }
  if (web.host === WEB_HOST || web.auth !== 'tailscale') return;
  if (env.KEIHI_INSECURE_HEADER_AUTH === '1') {
    log.warn(`web: KEIHI_INSECURE_HEADER_AUTH=1 なので、${web.host} にヘッダだけの認証のまま起動する（手元の検証用。公開しない）`);
    return;
  }
  throw new ConfigError('ヘッダだけの認証は 127.0.0.1 でしか使えない。[web] auth = "cloudflare_access" にする');
}

// spawn はテスト用（子の worker の起動を差し替える）。
export type StartOptions = { env?: NodeJS.ProcessEnv; log?: Logger; port?: number; spawn?: WorkerSpawn };

// 設定を読み、DB を開き、listen を始める（listen の失敗は server の 'error' で来る）。port はテスト用の上書き（0 で空いているポート）。
export function startWeb(argv: string[], opts: StartOptions = {}): { server: ServerType; db: Db; cfg: Config; control: WorkerControl } {
  const env = opts.env ?? process.env;
  const log = opts.log ?? processLog;
  const { values } = parseArgs({ args: argv, options: { 'config-dir': { type: 'string' }, 'data-dir': { type: 'string' } } });
  const cfg = loadConfig({ configDir: values['config-dir'], dataDir: values['data-dir'], env });
  addSecrets(Object.values(cfg.secrets));
  checkBindAuth(cfg.web, env, log);
  if (cfg.web.allowedUsers.length === 0) log.warn('web: [web] allowed_users が空なので、/healthz 以外はすべて 403 になる');
  const db = openDb(cfg.dbPath);
  let control: WorkerControl | null = null;
  try {
    if (env.KEIHI_MIGRATE_ON_START === '1') {
      const done = migrate(db);
      log.info(done.length ? `web: マイグレーションを適用: ${done.join(', ')}` : 'web: 適用するマイグレーションは無い');
    }
    const pwaDir = existsSync(PWA_DIST) ? PWA_DIST : undefined;
    if (!pwaDir) log.warn(`web: ${PWA_DIST} が無いので PWA は配信しない（npm run build）`);
    // spawn の方式は jobs 表を読む（daily の補填）ので、マイグレーションの後に作る。
    // 子の worker には、web が実際に使っている設定の場所と DB を渡す（--config-dir / --data-dir で起動しても同じものを開く）。
    const worker = (control = createWorkerControl({
      mode: cfg.worker.mode,
      db,
      log,
      stopTimeoutMs: WORKER_STOP_TIMEOUT_MS,
      spawn: opts.spawn,
      workerArgs: ['--db', cfg.dbPath],
      workerEnv: { ...env, KEIHI_CONFIG_DIR: cfg.configDir, KEIHI_DATA_DIR: cfg.dataDir },
    }));
    if (cfg.worker.mode !== 'systemd') log.info(`web: worker の起動は ${cfg.worker.mode}`);
    const app = createApp({
      db,
      objectsDir: cfg.objectsDir,
      config: cfg,
      auth: createAuth(cfg.web, { log }),
      triggerWorker: () => worker.trigger(),
      pwaDir,
      requestLog: requestLogEnabled(env),
      log,
    });
    const server = serve({ fetch: app.fetch, hostname: cfg.web.host, port: opts.port ?? cfg.web.port }, (info) => {
      log.info(`web: listening on http://${info.address}:${info.port}`);
    });
    return { server, db, cfg, control: worker };
  } catch (e) {
    // 子プロセスがいれば SIGTERM を送る（待たない。子は自分の接続で DB を閉じる）。
    void control?.stop();
    db.close();
    throw e;
  }
}

// SIGTERM / SIGINT の処理（2 回目以降は無視）。接続を閉じるのと worker を止めるのは並行。両方終わってから DB を閉じる。
export function createShutdown(
  server: ServerType,
  db: Db,
  opts: { log?: Logger; exit?: (code: number) => void; graceMs?: number; control?: WorkerControl } = {},
): () => void {
  const log = opts.log ?? processLog;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const http = server as Server;
  let stopping = false;
  let workerStopped: Promise<void> = Promise.resolve();
  const afterClose = async () => {
    try {
      await workerStopped;
      db.close();
    } finally {
      exit(0);
    }
  };
  return () => {
    if (stopping) return;
    stopping = true;
    log.info('web: shutting down');
    if (opts.control) {
      workerStopped = opts.control.stop().catch((err) => {
        log.error('web: worker を止められない', { err });
      });
    }
    const timer = setTimeout(() => http.closeAllConnections(), opts.graceMs ?? SHUTDOWN_GRACE_MS);
    timer.unref();
    http.close(() => {
      clearTimeout(timer);
      void afterClose();
    });
    http.closeIdleConnections();
  };
}

export function main(argv: string[]): void {
  setService('keihi-web');
  const log = processLog;
  process.on('uncaughtException', (err) => {
    log.error('web: uncaught exception', { err });
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    log.error('web: unhandled rejection', { err });
    process.exit(1);
  });
  let started: ReturnType<typeof startWeb>;
  try {
    started = startWeb(argv);
  } catch (e) {
    if (e instanceof ConfigError) log.error(`web: 起動しない: ${e.message}`);
    else log.error('web: 起動に失敗', { err: e });
    process.exitCode = 1;
    return;
  }
  const { server, db, control } = started;
  server.on('error', (err: NodeJS.ErrnoException) => {
    log.error(`web: listen に失敗（${err.code ?? err.message}）`, { err });
    process.exitCode = 1;
    void control
      .stop()
      .catch(() => {})
      .finally(() => {
        try {
          db.close();
        } catch {
          // 閉じ済み
        }
      });
  });
  const stop = createShutdown(server, db, { control });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.main) main(process.argv.slice(2));
