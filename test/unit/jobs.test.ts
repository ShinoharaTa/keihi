// ジョブキューとワンショット worker（docs/mvp-plan-v0.1.md T1-8）。一時ディレクトリの DB だけを使う。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { BACKOFF_MINUTES, MAX_ATTEMPTS, claim, enqueue, getJob } from '../../src/jobs/queue.ts';
import { TRIGGER_ARGS, triggerWorker, type SpawnLike } from '../../src/jobs/trigger.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { JOBS_ON_APPROVE } from '../../src/review/confirm.ts';
import { HANDLERS } from '../../src/worker/main.ts';

const MAIN_TS = fileURLToPath(new URL('../../src/worker/main.ts', import.meta.url));
const T0 = new Date('2026-10-17T00:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

let root: string;
let file: string;
let db: Db;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-jobs-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  file = path.join(root, `j${n++}.db`);
  db = openDb(file);
  migrate(db);
});

describe('queue', () => {
  test('run_after が来たものだけを古い順に取る', () => {
    const a = enqueue(db, 'extract', 'D1', { now: T0, runAfter: at(10) });
    const b = enqueue(db, 'upload_receipt', 'D1', { now: T0 });
    assert.equal(claim(db, T0)?.id, b);
    assert.equal(claim(db, T0), null);
    assert.equal(claim(db, at(10))?.id, a);
    db.close();
  });

  test('失敗のたびに 1 → 5 → 30 → 120 → 120 分のバックオフ、6 回目で failed', async () => {
    const id = enqueue(db, 'upload_receipt', 'D1', { now: T0 });
    const expected = [...BACKOFF_MINUTES, 120];
    let t = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const s = await runUntilEmpty(db, { upload_receipt: async () => { throw new Error('5xx'); } }, { now: () => at(t) });
      assert.deepEqual(s, { done: 0, failed: 1 });
      const j = getJob(db, id)!;
      assert.equal(j.attempts, i + 1);
      if (i + 1 < MAX_ATTEMPTS) {
        assert.equal(j.state, 'queued');
        assert.equal(j.run_after, at(t + expected[i]).toISOString(), `attempt ${i + 1}`);
        // 待ち時間の途中では取らない
        assert.equal(claim(db, at(t + expected[i] - 0.5)), null);
        t += expected[i];
      } else {
        assert.equal(j.state, 'failed');
        assert.equal(j.last_error, '5xx');
      }
    }
    assert.equal(claim(db, at(100000)), null);
    db.close();
  });

  test('locked_at が 15 分より古い running は取り直す（attempts に数える）', () => {
    const id = enqueue(db, 'extract', 'D1', { now: T0 });
    assert.equal(claim(db, T0)?.id, id);
    assert.equal(claim(db, at(14)), null);
    // 15 分を過ぎたら失敗として 1 分のバックオフ → その後取り直せる
    assert.equal(claim(db, at(16)), null);
    const j = getJob(db, id)!;
    assert.equal(j.state, 'queued');
    assert.equal(j.attempts, 1);
    assert.match(j.last_error!, /lock expired/);
    assert.equal(claim(db, at(17))?.id, id);
    db.close();
  });
});

describe('worker', () => {
  test('成功で done、知らない種類は失敗、キューが空になったら返る', async () => {
    const ok = enqueue(db, 'extract', 'D1', { now: T0 });
    db.prepare(`INSERT INTO jobs (kind, ref_id, run_after, created_at, updated_at) VALUES ('nope', NULL, ?, ?, ?)`).run(T0.toISOString(), T0.toISOString(), T0.toISOString());
    const s = await runUntilEmpty(db, { extract: async () => {} }, { now: () => T0 });
    assert.deepEqual(s, { done: 1, failed: 1 });
    assert.equal(getJob(db, ok)!.state, 'done');
    db.close();
  });

  test('実行環境なしで HANDLERS を動かしても完了にしない（失敗として再試行に回す）', async () => {
    const a = enqueue(db, 'upload_receipt', 'D1', { now: T0 });
    const b = enqueue(db, 'extract', 'D1', { now: T0 });
    assert.deepEqual(await runUntilEmpty(db, HANDLERS, { now: () => T0 }), { done: 0, failed: 2 });
    assert.match(getJob(db, a)!.last_error!, /実行環境が未設定/);
    assert.equal(getJob(db, b)!.state, 'queued');
    db.close();
  });

  test('空になったら lingerMs だけ待ってもう一度 claim する（待つ間に積まれたものも処理する）', async () => {
    const ran: string[] = [];
    const sleeps: number[] = [];
    enqueue(db, 'extract', 'D1', { now: T0 });
    let late = true;
    const s = await runUntilEmpty(
      db,
      { extract: async (j) => void ran.push(j.ref_id!) },
      {
        now: () => T0,
        lingerMs: 1500,
        sleep: async (ms) => {
          sleeps.push(ms);
          // 1 回目の猶予の間にだけ積む（start --no-block が畳まれたケース）。
          if (late) enqueue(db, 'extract', 'D2', { now: T0 });
          late = false;
        },
      },
    );
    assert.deepEqual(ran, ['D1', 'D2']);
    assert.deepEqual(s, { done: 2, failed: 0 });
    // D2 の後にもう一度だけ待って、何も無いので返る。
    assert.deepEqual(sleeps, [1500, 1500]);
    db.close();
  });

  test('lingerMs = 0（既定）なら待たずに返る', async () => {
    let slept = 0;
    assert.deepEqual(await runUntilEmpty(db, {}, { now: () => T0, sleep: async () => void slept++ }), { done: 0, failed: 0 });
    assert.equal(slept, 0);
    db.close();
  });

  test('HANDLERS は確定 API と日次が積むジョブを全部持つ', () => {
    for (const k of [...JOBS_ON_APPROVE, 'daily', 'reconcile_deals']) assert.equal(typeof HANDLERS[k], 'function', k);
  });

  test('src/worker/main.ts は処理後に exit code 0 で終了する', async () => {
    enqueue(db, 'extract', 'D1');
    db.close();
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [MAIN_TS, '--db', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /worker: done=0 failed=1/);
  });
});

test('trigger は systemctl --user start --no-block keihi-worker.service を呼ぶ', () => {
  db.close();
  const calls: [string, string[]][] = [];
  const fake: SpawnLike = (cmd, args) => {
    calls.push([cmd, args]);
    return { unref() {}, on() {} };
  };
  triggerWorker(fake);
  assert.deepEqual(calls, [['systemctl', ['--user', 'start', '--no-block', 'keihi-worker.service']]]);
  assert.deepEqual([...TRIGGER_ARGS], calls[0][1]);
});

test('deploy/systemd/keihi-worker.timer は起動後と終了 2 分後に worker を起動する', async () => {
  db.close();
  const dir = path.resolve(import.meta.dirname, '..', '..', 'deploy', 'systemd');
  const timer = await readFile(path.join(dir, 'keihi-worker.timer'), 'utf8');
  assert.match(timer, /^\[Timer\]$/m);
  assert.match(timer, /^OnBootSec=1min$/m);
  assert.match(timer, /^OnUnitInactiveSec=2min$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  // Unit= を書かない（同名の keihi-worker.service を起動する）。
  assert.doesNotMatch(timer, /^Unit=/m);
  for (const line of timer.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    assert.match(line, /^(\[[A-Za-z]+\]|[A-Za-z]+=.+)$/, line);
  }
});
