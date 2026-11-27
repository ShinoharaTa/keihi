// web の起動と停止（src/web/main.ts）。設定・DB は一時ディレクトリ、ポートは 127.0.0.1 の 0 番（空いているポート）。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerType } from '@hono/node-server';
import { ConfigError } from '../../src/config.ts';
import { createLogger, type Logger } from '../../src/log.ts';
import { checkBindAuth, createShutdown, startWeb } from '../../src/web/main.ts';

let root: string;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-webmain-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function capture(): { log: Logger; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { log: createLogger({ service: 'keihi-web', env: {}, out: (l) => out.push(l), err: (l) => err.push(l) }), out, err };
}

async function dirs(toml: string): Promise<{ configDir: string; dataDir: string }> {
  const d = path.join(root, String(n++));
  const configDir = path.join(d, 'config');
  const dataDir = path.join(d, 'data');
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.toml'), toml);
  return { configDir, dataDir };
}

const TOML = '[provider]\nkind = "fake"\n[web]\nallowed_users = ["you@example.com"]\n';

function listening(server: ServerType): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server.listening) resolve((server.address() as AddressInfo).port);
    server.once('listening', () => resolve((server.address() as AddressInfo).port));
    server.once('error', reject);
  });
}

// fetch は Host を差し替えられないので node:http で送る。
function getWithHost(port: number, p: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('起動時の検査', () => {
  test('127.0.0.1 なら tailscale のまま通す。0.0.0.0 で tailscale なら ConfigError', () => {
    const { log, err } = capture();
    checkBindAuth({ host: '127.0.0.1', auth: 'tailscale' }, {}, log);
    checkBindAuth({ host: '0.0.0.0', auth: 'cloudflare_access' }, {}, log);
    assert.throws(
      () => checkBindAuth({ host: '0.0.0.0', auth: 'tailscale' }, {}, log),
      (e: unknown) => e instanceof ConfigError && /ヘッダだけの認証は 127.0.0.1 でしか使えない。\[web\] auth = "cloudflare_access" にする/.test(e.message),
    );
    assert.throws(() => checkBindAuth({ host: '0.0.0.0', auth: 'tailscale' }, { KEIHI_INSECURE_HEADER_AUTH: 'true' }, log), ConfigError);
    assert.deepEqual(err, []);
  });
  test('KEIHI_INSECURE_HEADER_AUTH=1 なら warn を出して通す', () => {
    const { log, err } = capture();
    checkBindAuth({ host: '0.0.0.0', auth: 'tailscale' }, { KEIHI_INSECURE_HEADER_AUTH: '1' }, log);
    assert.equal(err.length, 1);
    assert.match(err[0], /KEIHI_INSECURE_HEADER_AUTH=1/);
  });
  test('none は 0.0.0.0 でも 127.0.0.1 でも通し、warn を 1 行出す', () => {
    for (const host of ['0.0.0.0', '127.0.0.1'] as const) {
      const { log, err } = capture();
      checkBindAuth({ host, auth: 'none' }, {}, log);
      assert.equal(err.length, 1, host);
      assert.match(err[0], /web: 認証なし（\[web\] auth = "none"）で起動する。届く範囲はネットワーク側（VPN・LAN）で絞ること/);
    }
  });
  test('startWeb は listen も DB を開くこともせずに止まる', async () => {
    const { configDir, dataDir } = await dirs(TOML);
    const { log } = capture();
    assert.throws(() => startWeb([], { env: { KEIHI_CONFIG_DIR: configDir, KEIHI_DATA_DIR: dataDir, KEIHI_BIND_HOST: '0.0.0.0' }, log, port: 0 }), ConfigError);
    assert.equal(existsSync(path.join(dataDir, 'keihi.db')), false);
  });
});

describe('startWeb と停止', () => {
  test('KEIHI_MIGRATE_ON_START=1 なら listen の前に適用する。SIGTERM の処理で DB を閉じて 0 で終わる（2 回目は無視）', async () => {
    const { configDir, dataDir } = await dirs(TOML);
    const { log, out } = capture();
    const { server, db, cfg } = startWeb([], { env: { KEIHI_CONFIG_DIR: configDir, KEIHI_DATA_DIR: dataDir, KEIHI_MIGRATE_ON_START: '1' }, log, port: 0 });
    assert.equal(cfg.web.host, '127.0.0.1');
    const port = await listening(server);
    assert.equal((server.address() as AddressInfo).address, '127.0.0.1');
    assert.ok(out.some((l) => /^web: マイグレーションを適用: 0001_/.test(l)), out.join('\n'));
    assert.ok(out.includes(`web: listening on http://127.0.0.1:${port}`));
    const r = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });

    const codes: number[] = [];
    const exited = new Promise<void>((resolve) => {
      const stop = createShutdown(server, db, {
        log,
        exit: (c) => {
          codes.push(c);
          resolve();
        },
      });
      stop();
      stop();
    });
    await exited;
    assert.deepEqual(codes, [0]);
    assert.equal(out.filter((l) => l === 'web: shutting down').length, 1);
    assert.equal(server.listening, false);
    assert.throws(() => db.prepare('SELECT 1').get());
  });
  test('既定ではマイグレーションしない（/health/ready は 503 migrations）', async () => {
    const { configDir, dataDir } = await dirs(TOML);
    const { log, out } = capture();
    const { server, db } = startWeb(['--config-dir', configDir, '--data-dir', dataDir], { env: {}, log, port: 0 });
    try {
      const port = await listening(server);
      assert.ok(!out.some((l) => l.includes('マイグレーション')));
      const r = await fetch(`http://127.0.0.1:${port}/health/ready`);
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { status: 'unavailable', reason: 'migrations' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
  test('停止は worker の stop を待ってから DB を閉じる（stop が失敗しても 0 で終わる）', async () => {
    for (const failing of [false, true]) {
      const { configDir, dataDir } = await dirs(TOML);
      const { log, err } = capture();
      const { server, db } = startWeb([], { env: { KEIHI_CONFIG_DIR: configDir, KEIHI_DATA_DIR: dataDir, KEIHI_MIGRATE_ON_START: '1' }, log, port: 0 });
      await listening(server);
      const events: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const control = {
        trigger: () => {},
        stop: async () => {
          events.push('stop');
          await gate;
          // この時点ではまだ DB は開いている
          db.prepare('SELECT 1').get();
          events.push('stopped');
          if (failing) throw new Error('boom');
        },
      };
      const exited = new Promise<number>((resolve) => {
        createShutdown(server, db, { log, control, exit: (c) => resolve(c) })();
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(events, ['stop']);
      assert.equal(server.listening, false);
      release();
      assert.equal(await exited, 0);
      assert.deepEqual(events, ['stop', 'stopped']);
      assert.throws(() => db.prepare('SELECT 1').get());
      assert.equal(err.some((l) => l.includes('worker を止められない')), failing);
    }
  });
  test('spawn 方式の worker には、web が使っている設定の場所と DB を渡す（--config-dir / --data-dir で起動しても同じ）', async () => {
    const { configDir, dataDir } = await dirs(TOML);
    const { log } = capture();
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const { server, db, control } = startWeb(['--config-dir', configDir, '--data-dir', dataDir], {
      env: { KEIHI_WORKER_MODE: 'spawn', KEIHI_MIGRATE_ON_START: '1', OTHER: 'x' },
      log,
      port: 0,
      spawn: (_cmd, args, o) => {
        calls.push({ args, env: o.env });
        return { pid: 1, kill: () => true, on: () => undefined };
      },
    });
    try {
      await listening(server);
      control.trigger();
      assert.equal(calls.length, 1);
      assert.match(calls[0].args[0], /src\/worker\/main\.ts$/);
      assert.deepEqual(calls[0].args.slice(1), ['--db', path.join(dataDir, 'keihi.db')]);
      assert.deepEqual(calls[0].env, { KEIHI_WORKER_MODE: 'spawn', KEIHI_MIGRATE_ON_START: '1', OTHER: 'x', KEIHI_CONFIG_DIR: configDir, KEIHI_DATA_DIR: dataDir });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
  test('KEIHI_WEB_AUTH=none なら、ヘッダなしの /api/status が 200 で user は allowed_users の値', async () => {
    const { configDir, dataDir } = await dirs(TOML);
    const { log, err } = capture();
    const { server, db, cfg } = startWeb([], {
      env: { KEIHI_CONFIG_DIR: configDir, KEIHI_DATA_DIR: dataDir, KEIHI_MIGRATE_ON_START: '1', KEIHI_WORKER_MODE: 'none', KEIHI_WEB_AUTH: 'none' },
      log,
      port: 0,
    });
    try {
      const port = await listening(server);
      assert.equal(cfg.web.auth, 'none');
      assert.equal(err.filter((l) => l.includes('認証なし')).length, 1);
      // listen は空いているポートなので、Host は設定のポート（許可リストにある 127.0.0.1:<web.port>）で送る
      const r = await getWithHost(port, '/api/status', cfg.web.allowedHosts[0]);
      assert.equal(r.status, 200);
      assert.equal((JSON.parse(r.body) as { user: unknown }).user, 'you@example.com');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
  test('[worker] mode = "spawn" なら control を作る（補填なし・子プロセスは起動しない）。stop で片付く', async () => {
    const { configDir, dataDir } = await dirs(TOML);
    const { log, out } = capture();
    const { server, db, cfg, control } = startWeb([], {
      env: { KEIHI_CONFIG_DIR: configDir, KEIHI_DATA_DIR: dataDir, KEIHI_MIGRATE_ON_START: '1', KEIHI_WORKER_MODE: 'spawn' },
      log,
      port: 0,
    });
    try {
      await listening(server);
      assert.equal(cfg.worker.mode, 'spawn');
      assert.ok(out.includes('web: worker の起動は spawn'));
    } finally {
      await control.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
