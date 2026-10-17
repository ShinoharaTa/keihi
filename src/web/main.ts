// web サーバーの起動（docs/mvp-plan.md T1-14、docs/mvp-plan-v0.1.md T1-14・D4、§4.4 keihi-web.service）。
// - 127.0.0.1 の web.port（既定 8795）にだけバインドする。バインド先は設定にしない。
// - mcp.port（既定 8796）は M7 まで予約のみ。ここでは何も開かない。
// - マイグレーションはしない（先に `npm run migrate`）。データディレクトリも作らない。
// - PWA は pwa/dist/（`npm run build` の成果物）を配信する。無ければ API だけ動く。
//
//   node src/web/main.ts [--config-dir DIR] [--data-dir DIR]
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { loadConfig, WEB_HOST } from '../config.ts';
import { openDb } from '../db/index.ts';
import { triggerWorker } from '../jobs/trigger.ts';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';

export const PWA_DIST = path.resolve(import.meta.dirname, '../../pwa/dist');

export function main(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { 'config-dir': { type: 'string' }, 'data-dir': { type: 'string' } } });
  const cfg = loadConfig({ configDir: values['config-dir'], dataDir: values['data-dir'] });
  if (cfg.web.allowedUsers.length === 0) console.warn('web: [web] allowed_users が空なので、/healthz 以外はすべて 403 になる');
  const db = openDb(cfg.dbPath);
  const pwaDir = existsSync(PWA_DIST) ? PWA_DIST : undefined;
  if (!pwaDir) console.warn(`web: ${PWA_DIST} が無いので PWA は配信しない（npm run build）`);
  const app = createApp({
    db,
    objectsDir: cfg.objectsDir,
    config: cfg,
    auth: createAuth(cfg.web),
    triggerWorker: () => triggerWorker(),
    pwaDir,
  });
  const server = serve({ fetch: app.fetch, hostname: WEB_HOST, port: cfg.web.port }, (info) => {
    console.log(`web: listening on http://${info.address}:${info.port}`);
  });
  const stop = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.main) main(process.argv.slice(2));
