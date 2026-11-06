// Hono の app（docs/mvp-plan-v0.1.md T1-14 の app.ts の部分だけ）。サーバーの起動（main.ts）は T1-14 で作る。
// テストは app.request() で行い、ポートを開かない。
// 認証（Host・Origin・Tailscale-User-Login の照合。src/web/auth.ts）は全ルートの前に差し込む。/healthz だけ auth の中で通す。
// 差し忘れを防ぐため auth は必須の引数にしている。pwaDir があれば PWA（pwa/dist/）も配信する。
import { Hono, type MiddlewareHandler } from 'hono';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { attentionRoutes } from './routes/attention.ts';
import { documentsRoutes } from './routes/documents.ts';
import { exportRoutes } from './routes/export.ts';
import { ingestRoutes } from './routes/ingest.ts';
import { reviewRoutes } from './routes/review.ts';
import { staticRoutes } from './routes/static.ts';
import { statusRoutes } from './routes/status.ts';

export type AppDeps = {
  db: Db;
  objectsDir: string;
  config: Pick<Config, 'ingest' | 'calendar' | 'deadline' | 'retention'>;
  auth: MiddlewareHandler;
  triggerWorker: () => void;
  now?: () => Date;
  pwaDir?: string;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use('*', deps.auth);
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/api', ingestRoutes(deps));
  app.route('/api', statusRoutes(deps));
  app.route('/api', documentsRoutes(deps));
  app.route('/api', reviewRoutes(deps));
  app.route('/api', attentionRoutes(deps));
  app.route('/api', exportRoutes(deps));
  if (deps.pwaDir !== undefined) app.route('/', staticRoutes({ pwaDir: deps.pwaDir }));
  return app;
}
