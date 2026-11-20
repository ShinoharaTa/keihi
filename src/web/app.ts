// Hono の app（docs/mvp-plan-v0.1.md T1-14 の app.ts の部分だけ）。サーバーの起動（main.ts）は T1-14 で作る。
// テストは app.request() で行い、ポートを開かない。
// 認証（Host・Origin・Tailscale-User-Login の照合。src/web/auth.ts）は全ルートの前に差し込む。/healthz だけ auth の中で通す。
// 差し忘れを防ぐため auth は必須の引数にしている。pwaDir があれば PWA（pwa/dist/）も配信する。
// ヘルスチェック（/health・/health/live・/health/ready）は auth より前（Host の許可リストも認証も通さない。コンテナ・リバースプロキシ用）。
// アクセスログ（requestLog）も auth より前。onError は log に出して、応答は Hono の既定と同じ。
import { randomUUID } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { HTTPException } from 'hono/http-exception';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { listMigrations } from '../db/migrate.ts';
import { log as processLog, type Logger } from '../log.ts';
import { attentionRoutes } from './routes/attention.ts';
import { bankRoutes } from './routes/bank.ts';
import { cashflowRoutes } from './routes/cashflow.ts';
import { documentsRoutes } from './routes/documents.ts';
import { expensesRoutes } from './routes/expenses.ts';
import { exportRoutes } from './routes/export.ts';
import { ingestRoutes } from './routes/ingest.ts';
import { mailRoutes } from './routes/mail.ts';
import { reviewRoutes } from './routes/review.ts';
import { staticRoutes } from './routes/static.ts';
import { statusRoutes } from './routes/status.ts';
import { tagRoutes } from './routes/tags.ts';
import { taxRoutes } from './routes/tax.ts';

export type AppDeps = {
  db: Db;
  objectsDir: string;
  // provider は口座（money_accounts.provider）に使う。省略時は freee。bank は CSV の取り込み（重複排除・振替の日付幅）に使う。省略時は既定値。
  // mail はメールの取り込み（省略時は enabled = false・アカウント 0 件）。
  config: Pick<Config, 'ingest' | 'calendar' | 'deadline' | 'retention' | 'cashflow'> & Partial<Pick<Config, 'provider' | 'bank' | 'mail'>>;
  auth: MiddlewareHandler;
  triggerWorker: () => void;
  now?: () => Date;
  pwaDir?: string;
  // /health/ready の判定。省略時は DB に SELECT 1 が通り、schema_migrations が最新まで適用済みなら ok。
  ready?: () => Readiness;
  // requestLog: アクセスログを出すか（既定 false。src/web/main.ts が requestLogEnabled で決める）。log の既定はプロセス共通の log。
  requestLog?: boolean;
  log?: Logger;
};

export type Readiness = { ok: true } | { ok: false; reason: 'db' | 'migrations' };

const NO_STORE = { 'Cache-Control': 'no-store' };
const HEALTH_PATHS = new Set(['/health', '/health/live', '/health/ready', '/healthz']);

// DB に SELECT 1 が通り、schema_migrations の最大の version が expected 以上なら ok。
export function dbReadiness(db: Db, expected: number): () => Readiness {
  return () => {
    try {
      db.prepare('SELECT 1').get();
    } catch {
      return { ok: false, reason: 'db' };
    }
    try {
      const r = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
      return (r.v ?? 0) >= expected ? { ok: true } : { ok: false, reason: 'migrations' };
    } catch {
      return { ok: false, reason: 'migrations' };
    }
  };
}

// LOG_REQUESTS が 1 なら有効・0 なら無効、未設定なら LOG_FORMAT=json のときだけ有効。
export function requestLogEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.LOG_REQUESTS === '1') return true;
  if (env.LOG_REQUESTS === '0') return false;
  return env.LOG_FORMAT === 'json';
}

// X-Request-Id → Cf-Ray → 新規。受け取った値は 128 字まで・[\w.:-] 以外を捨てる。
export function requestIdOf(c: Context): string {
  for (const h of ['X-Request-Id', 'Cf-Ray']) {
    const v = (c.req.header(h) ?? '').replace(/[^\w.:-]/g, '').slice(0, 128);
    if (v) return v;
  }
  return randomUUID();
}

const requestIds = new WeakMap<Request, string>();

// アクセスログ。ヘルスチェックは出さない。path にクエリを含めない。利用者は出さない。
function requestLogger(log: Logger): MiddlewareHandler {
  return async (c, next) => {
    if (HEALTH_PATHS.has(c.req.path)) return next();
    const start = performance.now();
    const requestId = requestIdOf(c);
    requestIds.set(c.req.raw, requestId);
    await next();
    c.header('X-Request-Id', requestId);
    log.info('request', { method: c.req.method, path: c.req.path, status: c.res.status, duration_ms: Math.round(performance.now() - start), request_id: requestId });
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const log = deps.log ?? processLog;
  app.onError((err, c) => {
    // Hono の既定と同じ（HTTPException はその応答を返す）。
    if ('getResponse' in err) {
      const res = (err as HTTPException).getResponse();
      return c.newResponse(res.body, res);
    }
    log.error('web: unhandled error', { err, method: c.req.method, path: c.req.path, request_id: requestIds.get(c.req.raw) ?? requestIdOf(c) });
    return c.text('Internal Server Error', 500);
  });
  const ready = deps.ready ?? dbReadiness(deps.db, listMigrations().length);
  const ok = (c: Context) => c.json({ status: 'ok' }, 200, NO_STORE);
  app.get('/health', ok);
  app.get('/health/live', ok);
  app.get('/health/ready', (c) => {
    const r = ready();
    return r.ok ? ok(c) : c.json({ status: 'unavailable', reason: r.reason }, 503, NO_STORE);
  });
  if (deps.requestLog) app.use('*', requestLogger(log));
  app.use('*', deps.auth);
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/api', ingestRoutes(deps));
  app.route('/api', statusRoutes(deps));
  app.route('/api', documentsRoutes(deps));
  app.route('/api', reviewRoutes(deps));
  app.route('/api', attentionRoutes(deps));
  app.route('/api', cashflowRoutes(deps));
  app.route('/api', exportRoutes(deps));
  app.route('/api', bankRoutes(deps));
  app.route('/api', expensesRoutes(deps));
  app.route('/api', tagRoutes(deps));
  app.route('/api', taxRoutes(deps));
  app.route('/api', mailRoutes(deps));
  if (deps.pwaDir !== undefined) app.route('/', staticRoutes({ pwaDir: deps.pwaDir }));
  return app;
}
