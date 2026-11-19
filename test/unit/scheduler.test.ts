// worker の起動の制御（src/jobs/scheduler.ts、[worker] mode）。偽の spawn・偽のタイマー・偽の時計。DB は一時ディレクトリ。
// 最後の 1 本だけ、実物の短い子プロセス（node）で SIGTERM → 終了待ち / SIGKILL を確かめる。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { enqueue } from '../../src/jobs/queue.ts';
import { createWorkerControl, latestDailyAt, nextDailyAt, type ChildLike, type ControlLog, type WorkerSpawn } from '../../src/jobs/scheduler.ts';
import { TRIGGER_ARGS, type SpawnLike } from '../../src/jobs/trigger.ts';
import { DeferJob, runUntilEmpty } from '../../src/jobs/worker.ts';
import { createStopSignal } from '../../src/worker/main.ts';

const ENTRY = '/opt/keihi/src/worker/main.ts';

let root: string;
let db: Db;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-scheduler-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  db = openDb(path.join(root, `${n++}.db`));
  migrate(db);
});

// 偽の時計とタイマー。advance で時刻を進め、期限の来たタイマーを順に実行する。
function fakeClock(start: Date) {
  let t = start.getTime();
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; unrefed: boolean }>();
  return {
    now: () => new Date(t),
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      const rec = { at: t + ms, fn, unrefed: false };
      timers.set(id, rec);
      return { id, unref: () => (rec.unrefed = true) };
    },
    clearTimer: (h: unknown) => {
      timers.delete((h as { id: number }).id);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
    allUnrefed: () => [...timers.values()].every((r) => r.unrefed),
  };
}

type FakeChild = ChildLike & EventEmitter & { signals: string[]; exit(code: number | null, signal?: NodeJS.Signals | null): void };

function fakeSpawn() {
  const calls: { cmd: string; args: string[]; opts: unknown; child: FakeChild }[] = [];
  const spawn: WorkerSpawn = (cmd, args, opts) => {
    const ee = new EventEmitter() as FakeChild;
    ee.pid = 1000 + calls.length;
    ee.signals = [];
    ee.kill = (sig) => {
      ee.signals.push(sig ?? 'SIGTERM');
      return true;
    };
    ee.exit = (code, signal = null) => {
      ee.emit('exit', code, signal);
    };
    calls.push({ cmd, args, opts, child: ee });
    return ee;
  };
  return { spawn, calls, last: () => calls[calls.length - 1].child, running: () => calls.length };
}

function memLog() {
  const lines: { level: string; msg: string }[] = [];
  const log: ControlLog = {
    info: (msg) => lines.push({ level: 'info', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
  };
  return { log, lines };
}

// 2026-11-19 00:00 UTC（JST 09:00）。直近の daily の予定は 2026-11-18T18:30Z。
const T0 = new Date('2026-11-19T00:00:00.000Z');

function make(start: Date = T0, extra: { idleIntervalMs?: number } = {}) {
  const clock = fakeClock(start);
  const sp = fakeSpawn();
  const ml = memLog();
  const control = createWorkerControl({
    mode: 'spawn',
    db,
    spawn: sp.spawn,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: ml.log,
    workerEntry: ENTRY,
    ...extra,
  });
  return { clock, sp, ml, control };
}

const dailyJobs = () => (db.prepare(`SELECT id, created_at FROM jobs WHERE kind = 'daily' ORDER BY id`).all() as { id: number; created_at: string }[]);

describe('daily の予定時刻（JST 03:30 = UTC 18:30）', () => {
  test('同じ UTC 日の 18:30 より前なら前日の 18:30、次はその日の 18:30', () => {
    const now = new Date('2026-11-19T10:00:00.000Z');
    assert.equal(latestDailyAt(now).toISOString(), '2026-11-18T18:30:00.000Z');
    assert.equal(nextDailyAt(now).toISOString(), '2026-11-19T18:30:00.000Z');
  });
  test('18:30 より後なら同じ日の 18:30、次は翌日（JST では日付をまたぐ）', () => {
    const now = new Date('2026-11-19T20:00:00.000Z'); // JST 11-20 05:00
    assert.equal(latestDailyAt(now).toISOString(), '2026-11-19T18:30:00.000Z');
    assert.equal(nextDailyAt(now).toISOString(), '2026-11-20T18:30:00.000Z');
  });
  test('ちょうど 18:30:00 なら直近はその時刻、次は翌日', () => {
    const now = new Date('2026-11-19T18:30:00.000Z');
    assert.equal(latestDailyAt(now).toISOString(), '2026-11-19T18:30:00.000Z');
    assert.equal(nextDailyAt(now).toISOString(), '2026-11-20T18:30:00.000Z');
    const before = new Date('2026-11-19T18:29:59.999Z');
    assert.equal(latestDailyAt(before).toISOString(), '2026-11-18T18:30:00.000Z');
    assert.equal(nextDailyAt(before).toISOString(), '2026-11-19T18:30:00.000Z');
  });
  test('月末・年末をまたぐ', () => {
    assert.equal(nextDailyAt(new Date('2026-12-31T19:00:00.000Z')).toISOString(), '2027-01-01T18:30:00.000Z');
    assert.equal(latestDailyAt(new Date('2026-03-01T00:00:00.000Z')).toISOString(), '2026-02-28T18:30:00.000Z');
  });
});

describe('spawn', () => {
  test('trigger で node と worker の絶対パスを起動する。動作中は二重に起動しない', async () => {
    const { sp, control } = make();
    control.trigger();
    assert.equal(sp.running(), 1);
    assert.equal(sp.calls[0].cmd, process.execPath);
    assert.deepEqual(sp.calls[0].args, [ENTRY]);
    assert.deepEqual(sp.calls[0].opts, { stdio: 'inherit' });
    control.trigger();
    control.trigger();
    assert.equal(sp.running(), 1);
    sp.last().exit(0);
    sp.last().exit(0); // pending の再起動の分
    await control.stop();
  });

  test('動作中の trigger は pending にして、終わったら直ちにもう一度起動する（1 回だけ）', async () => {
    const { sp, control } = make();
    control.trigger();
    control.trigger();
    control.trigger();
    sp.last().exit(0);
    assert.equal(sp.running(), 2);
    sp.last().exit(0);
    assert.equal(sp.running(), 2);
    await control.stop();
  });

  test('定期: 作ってから 60 秒後に起動、以後は子が終わってから 120 秒後', async () => {
    const { clock, sp, control } = make();
    clock.advance(59_999);
    assert.equal(sp.running(), 0);
    clock.advance(1);
    assert.equal(sp.running(), 1);
    // 動いている間は数えない
    clock.advance(600_000);
    assert.equal(sp.running(), 1);
    sp.last().exit(0);
    clock.advance(119_999);
    assert.equal(sp.running(), 1);
    clock.advance(1);
    assert.equal(sp.running(), 2);
    // trigger で起動した子が終わった後も 120 秒後
    sp.last().exit(0);
    clock.advance(30_000);
    control.trigger();
    assert.equal(sp.running(), 3);
    sp.last().exit(0);
    clock.advance(119_999);
    assert.equal(sp.running(), 3);
    clock.advance(1);
    assert.equal(sp.running(), 4);
    sp.last().exit(0);
    await control.stop();
  });

  test('タイマーは unref する', async () => {
    const { clock, control } = make();
    assert.ok(clock.pending() >= 2);
    assert.ok(clock.allUnrefed());
    await control.stop();
  });

  test('終了コードが 0 以外なら warn、spawn の error は error（落ちない）', async () => {
    const { sp, ml, control } = make();
    control.trigger();
    sp.last().exit(1);
    assert.equal(ml.lines.filter((l) => l.level === 'warn').length, 1);
    control.trigger();
    const c = sp.last();
    c.pid = undefined;
    c.emit('error', new Error('ENOENT'));
    assert.equal(ml.lines.filter((l) => l.level === 'error').length, 1);
    // 起動に失敗した子は終わったものとして、次の trigger で起動し直す
    control.trigger();
    assert.equal(sp.running(), 3);
    sp.last().exit(0);
    await control.stop();
  });

  test('daily: JST 03:30（UTC 18:30）に daily を積んで起動し、翌日も同じ時刻', async () => {
    // 定期の起動が混ざらないよう、終了後の間隔を長くしておく（定期は別のテスト）
    const { clock, sp, control } = make(T0, { idleIntervalMs: 30 * 24 * 60 * 60 * 1000 });
    clock.advance(60_000);
    assert.equal(sp.running(), 1);
    sp.last().exit(0);
    const until = new Date('2026-11-19T18:30:00.000Z').getTime() - clock.now().getTime();
    clock.advance(until - 1);
    assert.equal(dailyJobs().length, 0);
    assert.equal(sp.running(), 1);
    clock.advance(1);
    assert.deepEqual(dailyJobs().map((j) => j.created_at), ['2026-11-19T18:30:00.000Z']);
    assert.equal(sp.running(), 2);
    sp.last().exit(0);
    // 翌日（偽の worker は処理しないので、前日の分は済んだことにする。未実行があれば積み増さないのは enqueueDaily）
    db.prepare(`UPDATE jobs SET state = 'done' WHERE kind = 'daily'`).run();
    clock.advance(24 * 60 * 60 * 1000);
    assert.deepEqual(dailyJobs().map((j) => j.created_at), ['2026-11-19T18:30:00.000Z', '2026-11-20T18:30:00.000Z']);
    assert.equal(sp.running(), 3);
    sp.last().exit(0);
    await control.stop();
  });

  test('daily の補填: 最新の daily が直近の予定時刻より前なら、作ったときにすぐ積んで起動する', async () => {
    enqueue(db, 'daily', null, { now: new Date('2026-11-17T18:30:00.000Z') });
    db.prepare(`UPDATE jobs SET state = 'done'`).run();
    const { sp, control } = make();
    assert.deepEqual(dailyJobs().map((j) => j.created_at), ['2026-11-17T18:30:00.000Z', T0.toISOString()]);
    assert.equal(sp.running(), 1);
    sp.last().exit(0);
    await control.stop();
  });

  test('daily の補填をしない: daily のジョブが 1 件も無い DB', async () => {
    enqueue(db, 'extract', 'D1', { now: new Date('2026-01-01T00:00:00.000Z') });
    const { sp, control } = make();
    assert.equal(dailyJobs().length, 0);
    assert.equal(sp.running(), 0);
    await control.stop();
  });

  test('daily の補填をしない: 最新の daily が直近の予定時刻より後（ちょうどの時刻も含む）', async () => {
    enqueue(db, 'daily', null, { now: new Date('2026-11-18T18:30:00.000Z') });
    db.prepare(`UPDATE jobs SET state = 'done'`).run();
    const { sp, control } = make();
    assert.equal(dailyJobs().length, 1);
    assert.equal(sp.running(), 0);
    await control.stop();
  });

  test('stop: タイマーを全部止め、子に SIGTERM を送って終了を待つ', async () => {
    const { clock, sp, control } = make();
    control.trigger();
    const c = sp.last();
    let done = false;
    const p = control.stop().then(() => (done = true));
    assert.deepEqual(c.signals, ['SIGTERM']);
    await Promise.resolve();
    assert.equal(done, false);
    c.exit(0);
    await p;
    assert.equal(done, true);
    // 定期・daily のタイマーは残っていない（残るのは stop の待ちのタイマーだけ。進めても何も起動しない）
    clock.advance(10 * 24 * 60 * 60 * 1000);
    assert.equal(sp.running(), 1);
    assert.equal(dailyJobs().length, 0);
  });

  test('stop: stopTimeoutMs（既定 5 秒）を過ぎても終わらなければ SIGKILL', async () => {
    const { clock, sp, ml, control } = make();
    control.trigger();
    const c = sp.last();
    const p = control.stop();
    assert.deepEqual(c.signals, ['SIGTERM']);
    await new Promise((r) => setImmediate(r));
    clock.advance(4_999);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.signals, ['SIGTERM']);
    clock.advance(1);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL']);
    c.exit(null, 'SIGKILL');
    await p;
    assert.ok(ml.lines.some((l) => l.level === 'warn' && /SIGKILL/.test(l.msg)));
  });

  test('stop の後は trigger も pending の再起動もしない', async () => {
    const { sp, control } = make();
    control.trigger();
    control.trigger(); // pending
    const p = control.stop();
    control.trigger();
    sp.last().exit(0);
    await p;
    control.trigger();
    assert.equal(sp.running(), 1);
  });

  test('stop: SIGKILL の後も終わりを知らせて来なければ 2 秒で諦める。2 回目の stop も同じ結果を待つ', async () => {
    const { clock, sp, control } = make();
    control.trigger();
    const c = sp.last();
    let n = 0;
    const p1 = control.stop().then(() => n++);
    const p2 = control.stop().then(() => n++);
    await new Promise((r) => setImmediate(r));
    clock.advance(5_000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(n, 0);
    clock.advance(2_000);
    await Promise.all([p1, p2]);
    assert.equal(n, 2);
    assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL']);
  });

  test('workerArgs と workerEnv を子に渡す（省けば引数なし・env なし）', () => {
    const clock = fakeClock(T0);
    const sp = fakeSpawn();
    const base = { mode: 'spawn' as const, db, spawn: sp.spawn, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: memLog().log, workerEntry: '/app/src/worker/main.ts' };
    createWorkerControl({ ...base, workerArgs: ['--db', '/data/keihi.db'], workerEnv: { KEIHI_DATA_DIR: '/data' } }).trigger();
    assert.deepEqual(sp.calls[0].args, ['/app/src/worker/main.ts', '--db', '/data/keihi.db']);
    assert.deepEqual(sp.calls[0].opts, { stdio: 'inherit', env: { KEIHI_DATA_DIR: '/data' } });
    createWorkerControl(base).trigger();
    assert.deepEqual(sp.calls[1].args, ['/app/src/worker/main.ts']);
    assert.deepEqual(sp.calls[1].opts, { stdio: 'inherit' });
  });

  test('子がいないときの stop はすぐ終わる', async () => {
    const { sp, control } = make();
    await control.stop();
    control.trigger();
    assert.equal(sp.running(), 0);
  });
});

describe('none・systemd', () => {
  test('none: trigger も定期も daily も何もしない', async () => {
    enqueue(db, 'daily', null, { now: new Date('2026-01-01T00:00:00.000Z') });
    const clock = fakeClock(T0);
    const sp = fakeSpawn();
    const control = createWorkerControl({ mode: 'none', db, spawn: sp.spawn, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    control.trigger();
    assert.equal(clock.pending(), 0);
    clock.advance(2 * 24 * 60 * 60 * 1000);
    assert.equal(sp.running(), 0);
    assert.equal(dailyJobs().length, 1);
    await control.stop();
  });

  test('systemd: trigger は systemctl --user start --no-block keihi-worker.service、タイマーも補填もしない', async () => {
    enqueue(db, 'daily', null, { now: new Date('2026-01-01T00:00:00.000Z') });
    const clock = fakeClock(T0);
    const sp = fakeSpawn();
    const calls: { cmd: string; args: string[] }[] = [];
    const systemdSpawn: SpawnLike = (cmd, args) => {
      calls.push({ cmd, args });
      return { unref() {}, on: () => undefined };
    };
    const control = createWorkerControl({ mode: 'systemd', db, spawn: sp.spawn, systemdSpawn, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    assert.equal(clock.pending(), 0);
    control.trigger();
    assert.deepEqual(calls, [{ cmd: 'systemctl', args: [...TRIGGER_ARGS] }]);
    assert.equal(sp.running(), 0);
    assert.equal(dailyJobs().length, 1);
    await control.stop();
  });
});

describe('runUntilEmpty の shouldStop', () => {
  const T = new Date('2026-11-19T00:00:00.000Z');

  test('実行中のジョブは最後まで処理して complete / fail を記録してから返る', async () => {
    const a = enqueue(db, 'extract', 'A', { now: T });
    const b = enqueue(db, 'extract', 'B', { now: T });
    const c = enqueue(db, 'extract', 'C', { now: T });
    let stop = false;
    const seen: string[] = [];
    const s = await runUntilEmpty(
      db,
      {
        extract: async (job) => {
          seen.push(job.ref_id!);
          if (job.ref_id === 'A') return;
          stop = true; // B の途中で信号が来た
          throw new Error('boom');
        },
      },
      { now: () => T, shouldStop: () => stop },
    );
    assert.deepEqual(seen, ['A', 'B']);
    assert.deepEqual(s, { done: 1, failed: 1 });
    const state = (id: number) => (db.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(id) as { state: string; attempts: number });
    assert.deepEqual({ ...state(a) }, { state: 'done', attempts: 0 });
    assert.deepEqual({ ...state(b) }, { state: 'queued', attempts: 1 });
    assert.deepEqual({ ...state(c) }, { state: 'queued', attempts: 0 });
  });

  test('延期（DeferJob）のジョブの後にも見る', async () => {
    enqueue(db, 'extract', 'A', { now: T });
    enqueue(db, 'extract', 'B', { now: T });
    let stop = false;
    const seen: string[] = [];
    await runUntilEmpty(
      db,
      {
        extract: async (job) => {
          seen.push(job.ref_id!);
          stop = true;
          throw new DeferJob(new Date(T.getTime() + 60_000), 'wait');
        },
      },
      { now: () => T, shouldStop: () => stop },
    );
    assert.deepEqual(seen, ['A']);
  });

  test('linger の待ちの後にも見る（待ちの間に積まれたジョブを取らずに返る）', async () => {
    let stop = false;
    let claimed = 0;
    const s = await runUntilEmpty(
      db,
      { extract: async () => void claimed++ },
      {
        now: () => T,
        lingerMs: 1000,
        sleep: async () => {
          enqueue(db, 'extract', 'late', { now: T });
          stop = true;
        },
        shouldStop: () => stop,
      },
    );
    assert.equal(claimed, 0);
    assert.deepEqual(s, { done: 0, failed: 0 });
  });

  test('始める前に止まっていれば何も取らない。指定しなければ今までどおり', async () => {
    enqueue(db, 'extract', 'A', { now: T });
    assert.deepEqual(await runUntilEmpty(db, { extract: async () => {} }, { now: () => T, shouldStop: () => true }), { done: 0, failed: 0 });
    assert.deepEqual(await runUntilEmpty(db, { extract: async () => {} }, { now: () => T }), { done: 1, failed: 0 });
  });
});

describe('worker の信号（createStopSignal）', () => {
  test('SIGTERM / SIGINT で shouldStop が true になり、linger の待ちを切り上げる。dispose で外す', async () => {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      const proc = new EventEmitter();
      const s = createStopSignal(proc as unknown as NodeJS.Process);
      assert.equal(s.shouldStop(), false);
      const t0 = Date.now();
      const p = s.sleep(10_000);
      proc.emit(sig);
      await p;
      assert.ok(Date.now() - t0 < 1000);
      assert.equal(s.shouldStop(), true);
      await s.sleep(10_000); // 止まった後の待ちはすぐ返る
      s.dispose();
      assert.equal(proc.listenerCount('SIGTERM') + proc.listenerCount('SIGINT'), 0);
    }
  });
});

describe('spawn（実物の子プロセス）', () => {
  // 偽の worker。ready を出してから待ち続ける。graceful は SIGTERM で少し後に終了コード 0、stubborn は SIGTERM を無視する。
  async function realControl(script: string, stopTimeoutMs: number) {
    const entry = path.join(root, `child-${n++}.mjs`);
    await writeFile(entry, script);
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    const exits: (number | null)[] = [];
    const spawn: WorkerSpawn = (cmd, args) => {
      const c = nodeSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      c.stdout.on('data', (b: Buffer) => {
        if (b.toString().includes('ready')) ready();
      });
      c.on('exit', (code) => exits.push(code));
      return c;
    };
    const control = createWorkerControl({ mode: 'spawn', db, spawn, workerEntry: entry, bootDelayMs: 60_000, stopTimeoutMs, log: memLog().log });
    control.trigger();
    await isReady;
    return { control, exits };
  }

  test('stop は SIGTERM を送って終了を待つ', async () => {
    const { control, exits } = await realControl(
      `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); setInterval(() => {}, 1000); console.log('ready');`,
      5_000,
    );
    const t0 = Date.now();
    await control.stop();
    assert.deepEqual(exits, [0]);
    assert.ok(Date.now() - t0 >= 90);
  });

  test('stopTimeoutMs を過ぎたら SIGKILL', async () => {
    const { control, exits } = await realControl(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');`, 200);
    const t0 = Date.now();
    await control.stop();
    assert.deepEqual(exits, [null]);
    const ms = Date.now() - t0;
    assert.ok(ms >= 190 && ms < 3000, `${ms}ms`);
  });
});
