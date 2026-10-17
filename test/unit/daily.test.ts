// daily ジョブと keihi-daily からの enqueue（docs/mvp-plan.md §4.4、T2-12）。fake の Provider。DB は一時ディレクトリ。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ulid } from '../../src/db/ids.ts';
import { migrate } from '../../src/db/migrate.ts';
import { getJob } from '../../src/jobs/queue.ts';
import { enqueueDaily, main as triggerMain, type SpawnLike } from '../../src/jobs/trigger.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { currentMasters } from '../../src/masters/sync.ts';
import { createFakeProvider } from '../../src/providers/fake/index.ts';
import { FreeeAuthError } from '../../src/providers/freee/auth.ts';
import { isReauthRequired } from '../../src/providers/freee/state.ts';
import { createDailyHandler, DAILY_REPORT_KEY, META_WARNINGS_KEY, type DailyDeps } from '../../src/worker/handlers/daily.ts';

const T0 = new Date('2026-10-16T18:30:00.000Z'); // JST 2026-10-17 03:30
let root: string;
let file: string;
let n = 0;
let db: Db;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-daily-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  file = path.join(root, `${n++}.db`);
  db = openDb(file);
  migrate(db);
});

function addUpload(metaDeadlineOn: string, opts: { metaState?: 'none' | 'sent'; status?: string } = {}): string {
  const id = ulid();
  const iso = T0.toISOString();
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, status, created_at)
     VALUES (?, ?, 1, 'image/jpeg', 'pwa', 'scan', ?, '2026-08-01', 'server', '2026-08-12', 'early', 'k', ?, ?)`,
  ).run(id, id.padEnd(64, '0'), iso, opts.status ?? 'needs_review', iso);
  db.prepare(
    `INSERT INTO provider_uploads (id, document_id, provider, state, remote_receipt_id, meta_state, meta_deadline_on, uploaded_at, created_at) VALUES (?, ?, 'freee', 'uploaded', '1', ?, ?, ?, ?)`,
  ).run(ulid(), id, opts.metaState ?? 'none', metaDeadlineOn, iso, iso);
  return id;
}

const setting = (key: string) => JSON.parse((db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string }).value_json);
const status = (id: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status;
const run = (deps: DailyDeps) => runUntilEmpty(db, { daily: createDailyHandler(() => deps) }, { now: () => T0 });

describe('daily', () => {
  test('トークンの更新・マスタ同期・検索項目の期限チェック・needs_attention の集計', async () => {
    const fake = createFakeProvider();
    let refreshed = 0;
    const passed = addUpload('2026-10-16');
    const today = addUpload('2026-10-17');
    const in7 = addUpload('2026-10-24');
    addUpload('2026-10-25'); // 8 日前: まだ警告しない
    addUpload('2026-10-10', { metaState: 'sent' }); // 送り済みは対象外
    const job = enqueueDaily(db, T0).id;
    const deps: DailyDeps = {
      provider: () => fake,
      refreshToken: async () => {
        refreshed++;
        return { refreshed: true, refreshTokenExpiresAt: T0.getTime() / 1000 + 90 * 86400 };
      },
    };
    assert.deepEqual(await run(deps), { done: 1, failed: 0 });
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(refreshed, 1);
    assert.equal(fake.calls.filter((c) => c.method === 'syncMasters').length, 1);
    assert.ok(currentMasters(db, 'freee', 'account').length > 0);

    assert.equal(status(passed), 'needs_attention');
    assert.equal(status(today), 'needs_review');
    assert.deepEqual(setting(META_WARNINGS_KEY), [
      { document_id: today, meta_deadline_on: '2026-10-17' },
      { document_id: in7, meta_deadline_on: '2026-10-24' },
    ]);
    const r = setting(DAILY_REPORT_KEY);
    assert.equal(r.needs_attention, 1);
    assert.equal(r.token.refreshed, true);
    assert.deepEqual(r.meta_deadline.passed, [{ document_id: passed, meta_deadline_on: '2026-10-16' }]);
    assert.deepEqual(r.errors, []);
    const reason = JSON.parse((db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'document.needs_attention'`).get() as { payload_json: string }).payload_json).reason;
    assert.equal(reason, 'meta_deadline_passed');
    assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'daily.completed'`).get());
    assert.equal(verifyAudit(db).ok, true);
  });

  test('fake ではトークンの更新を飛ばす', async () => {
    enqueueDaily(db, T0);
    assert.deepEqual(await run({ provider: () => createFakeProvider(), refreshToken: null }), { done: 1, failed: 0 });
    assert.equal(setting(DAILY_REPORT_KEY).token, 'skipped');
  });

  test('invalid_grant は再認可の帯を立て、他の段は動かしてから再試行に回す', async () => {
    const fake = createFakeProvider();
    const passed = addUpload('2026-10-01');
    const job = enqueueDaily(db, T0).id;
    const s = await run({
      provider: () => fake,
      refreshToken: async () => {
        throw new FreeeAuthError('freee token HTTP 401', { status: 401, error: 'invalid_grant' });
      },
    });
    assert.deepEqual(s, { done: 0, failed: 1 });
    assert.equal(getJob(db, job)!.state, 'queued');
    assert.equal(isReauthRequired(db), true);
    assert.equal(fake.calls.filter((c) => c.method === 'syncMasters').length, 1);
    assert.equal(status(passed), 'needs_attention');
    assert.equal(setting(DAILY_REPORT_KEY).errors[0].step, 'token');
  });
});

describe('keihi-daily の enqueue（src/jobs/trigger.ts）', () => {
  test('未実行の daily があれば積み増さない', () => {
    const a = enqueueDaily(db, T0);
    const b = enqueueDaily(db, T0);
    assert.deepEqual([a.created, b.created, b.id], [true, false, a.id]);
    db.prepare(`UPDATE jobs SET state = 'done'`).run();
    assert.equal(enqueueDaily(db, T0).created, true);
  });

  test('trigger.ts daily は daily ジョブを積んで worker を起動する', () => {
    db.close();
    const calls: [string, string[]][] = [];
    const spawn: SpawnLike = (cmd, args) => {
      calls.push([cmd, args]);
      return { unref() {}, on() {} };
    };
    const lines: string[] = [];
    assert.equal(triggerMain(['daily', '--db', file], { spawn, log: (s) => lines.push(s) }), 0);
    assert.deepEqual(calls, [['systemctl', ['--user', 'start', '--no-block', 'keihi-worker.service']]]);
    assert.equal(triggerMain(['nope'], { spawn, log: (s) => lines.push(s) }), 2);
    db = openDb(file);
    assert.deepEqual((db.prepare(`SELECT kind, state FROM jobs`).all() as { kind: string; state: string }[]).map((j) => ({ ...j })), [{ kind: 'daily', state: 'queued' }]);
  });

  test('deploy/systemd/keihi-daily.{service,timer} は trigger.ts daily を毎日起動する', async () => {
    const dir = path.resolve(import.meta.dirname, '..', '..', 'deploy', 'systemd');
    const svc = await readFile(path.join(dir, 'keihi-daily.service'), 'utf8');
    const timer = await readFile(path.join(dir, 'keihi-daily.timer'), 'utf8');
    assert.match(svc, /^Type=oneshot$/m);
    assert.match(svc, /^ExecStart=.*src\/jobs\/trigger\.ts daily$/m);
    assert.match(timer, /^OnCalendar=\*-\*-\* 03:30:00$/m);
    assert.match(timer, /^Persistent=true$/m);
  });
});
