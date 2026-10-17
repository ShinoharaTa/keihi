// Hono の app（docs/mvp-plan-v0.1.md T1-14 の app.ts の部分だけ）。サーバーの起動（main.ts）は T1-14 で作る。
// テストは app.request() で行い、ポートを開かない。
// 認証（Tailscale-User-Login の照合）は T1-14 で実装する。ここでは /api/* の前に差し込む口だけを持ち、
// 差し忘れを防ぐため auth は必須の引数にしている。
import { Hono, type MiddlewareHandler } from 'hono';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { ingestRoutes } from './routes/ingest.ts';

export type AppDeps = {
  db: Db;
  objectsDir: string;
  config: Pick<Config, 'ingest' | 'calendar' | 'deadline'>;
  auth: MiddlewareHandler;
  triggerWorker: () => void;
  now?: () => Date;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use('/api/*', deps.auth);
  app.route('/api', ingestRoutes(deps));
  return app;
}
