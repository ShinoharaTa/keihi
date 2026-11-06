// worker の配線（docs/mvp-plan.md T1-11・T1-15）。設定から Provider を組み立てて HANDLERS に渡す。一時ディレクトリだけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { ulid } from '../../src/db/ids.ts';
import { migrate } from '../../src/db/migrate.ts';
import { enqueue, getJob } from '../../src/jobs/queue.ts';
import { putObject } from '../../src/storage/objects.ts';
import { buildProvider, createRuntime, runWith } from '../../src/worker/main.ts';

const T0 = new Date('2026-10-16T03:00:00.000Z');
let root: string;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-wiring-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function cfgWith(toml: string, env = '') {
  const d = path.join(root, String(n++));
  await mkdir(d);
  await writeFile(path.join(d, 'config.toml'), toml);
  await writeFile(path.join(d, 'secrets.env'), env);
  await chmod(path.join(d, 'secrets.env'), 0o600);
  return loadConfig({ configDir: d, dataDir: path.join(d, 'data') });
}

describe('buildProvider', () => {
  test('kind = "fake" は fake（freee の設定は要らない）', async () => {
    const cfg = await cfgWith('[provider]\nkind = "fake"\n');
    const db = openDb(':memory:');
    migrate(db);
    const p = buildProvider(cfg, db);
    assert.ok('calls' in p); // fake だけが呼び出し記録を持つ
    db.close();
  });

  test('kind = "freee" は target の事業所 ID とシークレットが無ければ ConfigError', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const noSecrets = await cfgWith('[freee]\npoc_company_id = 1\n');
    assert.throws(() => buildProvider(noSecrets, db), ConfigError);
    const cfg = await cfgWith('[freee]\npoc_company_id = 1\ntarget = "prod"\n', 'FREEE_CLIENT_ID=a\nFREEE_CLIENT_SECRET=b\n');
    assert.throws(() => buildProvider(cfg, db), /prod_company_id/);
    const ok = await cfgWith('[freee]\npoc_company_id = 1\n', 'FREEE_CLIENT_ID=a\nFREEE_CLIENT_SECRET=b\n');
    assert.ok(!('calls' in buildProvider(ok, db)));
    db.close();
  });
});

test('runWith: upload_receipt に設定の Provider（fake）が渡る', async () => {
  const cfg = await cfgWith('[provider]\nkind = "fake"\n');
  const db = openDb(':memory:');
  migrate(db);
  const bytes = Buffer.from('%PDF-1.4 test');
  const stored = await putObject(cfg.objectsDir, bytes);
  const id = ulid(T0.getTime());
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, created_at)
     VALUES (?, ?, ?, 'application/pdf', 'pwa', 'e_transaction', ?, '2026-10-16', 'server', '2026-10-26', 'early', ?, ?)`,
  ).run(id, stored.sha256, bytes.length, T0.toISOString(), stored.key, T0.toISOString());
  const job = enqueue(db, 'upload_receipt', id, { now: T0 });
  const rt = createRuntime(cfg, db);
  assert.deepEqual(await runWith(rt, { now: () => T0 }), { done: 1, failed: 0 });
  assert.equal(getJob(db, job)!.state, 'done');
  assert.equal((db.prepare('SELECT state FROM provider_uploads').get() as { state: string }).state, 'uploaded');
  db.close();
});
