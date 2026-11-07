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
import { enqueue, getJob } from '../../src/jobs/queue.ts';
import { enqueueDaily, main as triggerMain, type SpawnLike } from '../../src/jobs/trigger.ts';
import { runUntilEmpty } from '../../src/jobs/worker.ts';
import { currentMasters } from '../../src/masters/sync.ts';
import { createFakeProvider } from '../../src/providers/fake/index.ts';
import { FreeeAuthError } from '../../src/providers/freee/auth.ts';
import { isReauthRequired, setReauthRequired } from '../../src/providers/freee/state.ts';
import { saveAll } from '../../src/cashflow/tax/sync.ts';
import { createDailyHandler, DAILY_REPORT_KEY, META_WARNINGS_KEY, REMOTE_VERIFY_LAST_KEY, type DailyDeps } from '../../src/worker/handlers/daily.ts';

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

// 最新の確定（reviews）は既定で approve。decision: null なら確定なし。
function addUpload(metaDeadlineOn: string, opts: { metaState?: 'none' | 'sent'; status?: string; decision?: string | null } = {}): string {
  const id = ulid();
  const iso = T0.toISOString();
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, status, created_at)
     VALUES (?, ?, 1, 'image/jpeg', 'pwa', 'scan', ?, '2026-08-01', 'server', '2026-08-12', 'early', 'k', ?, ?)`,
  ).run(id, id.padEnd(64, '0'), iso, opts.status ?? 'needs_review', iso);
  db.prepare(
    `INSERT INTO provider_uploads (id, document_id, provider, state, remote_receipt_id, meta_state, meta_deadline_on, uploaded_at, created_at) VALUES (?, ?, 'freee', 'uploaded', '1', ?, ?, ?, ?)`,
  ).run(ulid(), id, opts.metaState ?? 'none', metaDeadlineOn, iso, iso);
  const decision = opts.decision === undefined ? 'approve' : opts.decision;
  if (decision !== null) {
    db.prepare(`INSERT INTO reviews (id, document_id, version, txn_date, amount, vendor, decision, decided_at) VALUES (?, ?, 1, '2026-08-01', 1100, 'x', ?, ?)`).run(ulid(), id, decision, iso);
  }
  return id;
}

const setting = (key: string) => JSON.parse((db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string }).value_json);
const status = (id: string) => (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status;
// daily が積む reconcile_deals は何もしないハンドラで流す（照合そのものは reconcile.test.ts）。
const run = (deps: DailyDeps, now: Date = T0) =>
  runUntilEmpty(db, { daily: createDailyHandler(() => deps), reconcile_deals: async () => {}, sync_bank: async () => {} }, { now: () => now });
const jobsOf = (kind: string) => db.prepare('SELECT id, state FROM jobs WHERE kind = ? ORDER BY id').all(kind) as { id: number; state: string }[];

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
    assert.deepEqual(await run(deps), { done: 3, failed: 0 }); // daily + reconcile_deals + sync_bank
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
    assert.deepEqual(await run({ provider: () => createFakeProvider(), refreshToken: null }), { done: 3, failed: 0 });
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
    assert.deepEqual(s, { done: 2, failed: 1 }); // reconcile_deals・sync_bank は完了、daily は再試行
    assert.equal(getJob(db, job)!.state, 'queued');
    assert.equal(isReauthRequired(db), true);
    assert.equal(fake.calls.filter((c) => c.method === 'syncMasters').length, 1);
    assert.equal(status(passed), 'needs_attention');
    assert.equal(setting(DAILY_REPORT_KEY).errors[0].step, 'token');
  });
});

describe('daily: 対象の絞り込み・部分失敗・再認可', () => {
  test('検索項目の期限チェックは最新の確定が approve のものだけ（reject / duplicate / personal・未確定・approve の後の reject は対象外）', async () => {
    const ok = addUpload('2026-10-01');
    const others = ['reject', 'duplicate', 'personal', null].map((d) => addUpload('2026-10-01', { decision: d }));
    const later = addUpload('2026-10-01');
    db.prepare(`INSERT INTO reviews (id, document_id, version, txn_date, amount, vendor, decision, decided_at) VALUES (?, ?, 2, NULL, NULL, NULL, 'reject', ?)`).run(ulid(), later, T0.toISOString());
    enqueueDaily(db, T0);
    await run({ provider: () => createFakeProvider(), refreshToken: null });
    assert.equal(status(ok), 'needs_attention');
    for (const id of [...others, later]) assert.equal(status(id), 'needs_review', id);
    assert.deepEqual(setting(DAILY_REPORT_KEY).meta_deadline.passed, [{ document_id: ok, meta_deadline_on: '2026-10-01' }]);
  });

  test('部分失敗: 失敗した段だけを再試行し、同じ日に成功済みの段は飛ばす。reconcile_deals も積み増さない', async () => {
    const fake = createFakeProvider();
    let refreshed = 0;
    let mastersFail = true;
    const provider = () => {
      if (mastersFail) throw new Error('masters down');
      return fake;
    };
    const deps: DailyDeps = {
      provider,
      refreshToken: async () => {
        refreshed++;
        return { refreshed: false, refreshTokenExpiresAt: T0.getTime() / 1000 + 90 * 86400 };
      },
    };
    const job = enqueueDaily(db, T0).id;
    assert.deepEqual(await run(deps), { done: 2, failed: 1 });
    let r = setting(DAILY_REPORT_KEY);
    assert.deepEqual(r.errors.map((e: { step: string }) => e.step), ['masters']);
    assert.deepEqual(r.skipped_steps, []);
    assert.equal(getJob(db, job)!.state, 'queued');
    assert.equal(setting('daily_last_step_token'), '2026-10-17');
    assert.equal(jobsOf('reconcile_deals').length, 1);

    // 再試行（1 分後）: masters だけ動き、他は飛ばす。
    mastersFail = false;
    const t1 = new Date(T0.getTime() + 60_000);
    assert.deepEqual(await run(deps, t1), { done: 1, failed: 0 });
    assert.equal(getJob(db, job)!.state, 'done');
    assert.equal(refreshed, 1);
    assert.equal(fake.calls.filter((c) => c.method === 'syncMasters').length, 1);
    assert.equal(jobsOf('reconcile_deals').length, 1);
    r = setting(DAILY_REPORT_KEY);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.skipped_steps, ['token', 'reauth_wake', 'meta_deadline', 'reconcile', 'sync_bank', 'detect_recurrences', 'tax_recalc', 'paper_status', 'remote_verify']);

    // 翌日は全部動く。
    const t2 = new Date(T0.getTime() + 86_400_000);
    enqueueDaily(db, t2);
    await run(deps, t2);
    assert.equal(refreshed, 2);
    assert.deepEqual(setting(DAILY_REPORT_KEY).skipped_steps, []);
  });

  test('再認可の後は再認可待ちの upload_receipt を即時に起こす（再認可前は起こさない）', async () => {
    const later = new Date(T0.getTime() + 30 * 3_600_000).toISOString();
    db.prepare(`INSERT INTO jobs (kind, ref_id, state, attempts, max_attempts, run_after, last_error, created_at, updated_at) VALUES ('upload_receipt', 'D1', 'queued', 0, 6, ?, ?, ?, ?)`).run(
      later,
      `reauth_pending since=${T0.toISOString()}: auth_invalid_grant: x`,
      T0.toISOString(),
      T0.toISOString(),
    );
    const up = () => (db.prepare(`SELECT run_after FROM jobs WHERE kind = 'upload_receipt'`).get() as { run_after: string }).run_after;
    setReauthRequired(db, true, T0);
    enqueueDaily(db, T0);
    await runUntilEmpty(db, { daily: createDailyHandler(() => ({ provider: () => createFakeProvider(), refreshToken: null })), reconcile_deals: async () => {}, sync_bank: async () => {} }, { now: () => T0 });
    assert.equal(up(), later);
    assert.equal(setting(DAILY_REPORT_KEY).reauth_woken, 0);

    setReauthRequired(db, false, T0);
    const t2 = new Date(T0.getTime() + 86_400_000);
    enqueueDaily(db, t2);
    let woken = false;
    await runUntilEmpty(
      db,
      { daily: createDailyHandler(() => ({ provider: () => createFakeProvider(), refreshToken: null })), reconcile_deals: async () => {}, sync_bank: async () => {}, upload_receipt: async () => void (woken = true) },
      { now: () => t2 },
    );
    assert.equal(setting(DAILY_REPORT_KEY).reauth_woken, 1);
    assert.equal(woken, true);
  });
});

describe('daily: 照合・紙原本・証憑の照合', () => {
  test('reconcile_deals を積む（未実行のものがあれば積み増さない）', async () => {
    enqueueDaily(db, T0);
    await run({ provider: () => createFakeProvider(), refreshToken: null });
    assert.equal(jobsOf('reconcile_deals').length, 1);
    assert.equal(setting(DAILY_REPORT_KEY).reconcile.created, true);
    const next = new Date(T0.getTime() + 86_400_000);
    const queued = enqueue(db, 'reconcile_deals', null, { now: T0, runAfter: new Date(T0.getTime() + 2 * 86_400_000) });
    enqueueDaily(db, next);
    await run({ provider: () => createFakeProvider(), refreshToken: null }, next);
    assert.equal(jobsOf('reconcile_deals').length, 2);
    assert.deepEqual(setting(DAILY_REPORT_KEY).reconcile, { job_id: queued, created: false });
  });

  test('sync_bank を積み（未実行のものがあれば積み増さない）、マスタ同期で口座を作る', async () => {
    enqueueDaily(db, T0);
    await run({ provider: () => createFakeProvider(), refreshToken: null, providerKind: 'fake' });
    assert.equal(jobsOf('sync_bank').length, 1);
    assert.equal(setting(DAILY_REPORT_KEY).sync_bank.created, true);
    const accounts = db.prepare('SELECT provider, kind, source, freee_walletable_id, name FROM money_accounts').all().map((r) => ({ ...r }));
    assert.deepEqual(accounts, [{ provider: 'fake', kind: 'card', source: 'freee', freee_walletable_id: 'credit_card:1', name: 'テストカード' }]);
    const next = new Date(T0.getTime() + 86_400_000);
    const queued = enqueue(db, 'sync_bank', null, { now: T0, runAfter: new Date(T0.getTime() + 2 * 86_400_000) });
    enqueueDaily(db, next);
    await run({ provider: () => createFakeProvider(), refreshToken: null, providerKind: 'fake' }, next);
    assert.equal(jobsOf('sync_bank').length, 2);
    assert.deepEqual(setting(DAILY_REPORT_KEY).sync_bank, { job_id: queued, created: false });
    assert.equal((db.prepare('SELECT count(*) n FROM money_accounts').get() as { n: number }).n, 1);
  });

  test('sync_bank を積んだ後に周期の検出を動かし、件数を report に残す', async () => {
    enqueueDaily(db, T0);
    assert.deepEqual(await run({ provider: () => createFakeProvider(), refreshToken: null, providerKind: 'fake' }), { done: 3, failed: 0 });
    const r = setting(DAILY_REPORT_KEY);
    assert.deepEqual(r.detect_recurrences, { created: 0, updated: 0 });
    assert.deepEqual(r.errors, []);
    const audit = JSON.parse((db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'daily.completed'`).get() as { payload_json: string }).payload_json);
    assert.deepEqual(audit.detect_recurrences, { created: 0, updated: 0 });
  });

  test('周期の検出が失敗しても daily は失敗にせず、report に error を残す', async () => {
    db.exec('DROP TABLE bank_txns'); // 検出が明細を読むところで落とす
    const job = enqueueDaily(db, T0).id;
    assert.deepEqual(await run({ provider: () => createFakeProvider(), refreshToken: null, providerKind: 'fake' }), { done: 3, failed: 0 });
    assert.equal(getJob(db, job)!.state, 'done');
    const r = setting(DAILY_REPORT_KEY);
    assert.match(r.detect_recurrences.error, /bank_txns/);
    assert.deepEqual(r.errors, []);
  });

  test('紙原本のステータスを更新する', async () => {
    const doc = addUpload('2026-10-30'); // 期限 2026-08-12 は過ぎ、同等確認なし → keep_required
    enqueueDaily(db, T0);
    await run({ provider: () => createFakeProvider(), refreshToken: null });
    assert.equal((db.prepare('SELECT paper_status FROM documents WHERE id = ?').get(doc) as { paper_status: string }).paper_status, 'keep_required');
    assert.equal(setting(DAILY_REPORT_KEY).paper_status_changed, 1);
  });

  test('税の見積もりの再計算は毎月 1 日（JST）だけ。プロファイルが無ければ skipped', async () => {
    const deps: DailyDeps = { provider: () => createFakeProvider(), refreshToken: null };
    const nov1 = new Date('2026-10-31T18:30:00.000Z'); // JST 2026-11-01 03:30
    const nov2 = new Date('2026-11-01T18:30:00.000Z'); // JST 2026-11-02 03:30
    const runs = () => db.prepare('SELECT id, actor FROM tax_estimate_runs ORDER BY created_at, rowid').all() as { id: string; actor: string }[];
    const daily = async (t: Date) => {
      db.prepare(`UPDATE jobs SET state = 'done' WHERE kind = 'daily'`).run();
      enqueueDaily(db, t);
      await run(deps, t);
      return setting(DAILY_REPORT_KEY).tax_recalc;
    };

    // プロファイルが無ければ 1 日でも飛ばす。
    assert.equal(await daily(nov1), 'skipped');
    assert.equal(runs().length, 0);

    saveAll(db, { profile: { pension_mode: 'monthly' }, years: [{ year: 2025, kind: 'actual', business_income: 3_000_000 }] }, { by: { actor: 'user' }, today: '2026-10-17', now: T0 });
    assert.equal(runs().length, 1);
    db.prepare(`DELETE FROM settings WHERE key = 'daily_last_step_tax_recalc'`).run(); // 同じ日の 2 回目として飛ばさないように
    const r = await daily(nov1);
    const all = runs();
    assert.equal(all.length, 2);
    assert.deepEqual({ ...all[1] }, { id: r.run_id, actor: 'system' });
    assert.deepEqual(Object.keys(r).sort(), ['created', 'deactivated', 'run_id', 'updated']);
    // 2026-10-17 の期間（〜2030-01-17）から 2026-11-01 の期間（〜2030-02-01）に伸びる: 2030-01-31 の住民税 第 4 期が増える。
    assert.ok(r.created > 0);

    // 同じ日の 2 回目は飛ばす。2 日は not_due。
    await daily(nov1);
    assert.ok(setting(DAILY_REPORT_KEY).skipped_steps.includes('tax_recalc'));
    assert.equal(await daily(nov2), 'not_due');
    assert.equal(runs().length, 2);
    assert.ok(verifyAudit(db).ok);
  });

  test('証憑の照合は 30 日以上空いたときだけ。remoteVerify が無ければ飛ばす', async () => {
    const fake = createFakeProvider();
    let downloads = 0;
    const deps: DailyDeps = {
      provider: () => fake,
      refreshToken: null,
      remoteVerify: {
        provider: () => ({
          downloadReceipt: async () => {
            downloads++;
            return { bytes: Buffer.from('x'), mime: 'image/jpeg' };
          },
        }),
        objectsDir: path.join(root, 'objects'),
        mode: 'download_only',
      },
    };
    addUpload('2026-10-30');
    enqueueDaily(db, T0);
    await run(deps);
    assert.equal(downloads, 1);
    assert.equal(setting(DAILY_REPORT_KEY).remote_verify.checked, 1);
    assert.equal(setting(REMOTE_VERIFY_LAST_KEY), T0.toISOString());

    const day = (d: number) => new Date(T0.getTime() + d * 86_400_000);
    for (const [d, expect] of [[29, 1], [30, 2]] as const) {
      db.prepare(`UPDATE jobs SET state = 'done' WHERE kind = 'daily'`).run();
      enqueueDaily(db, day(d));
      await run(deps, day(d));
      assert.equal(downloads, expect, `day ${d}`);
    }

    db.prepare(`UPDATE jobs SET state = 'done' WHERE kind = 'daily'`).run();
    enqueueDaily(db, day(90));
    await run({ provider: () => fake, refreshToken: null }, day(90));
    assert.equal(setting(DAILY_REPORT_KEY).remote_verify, 'skipped');
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
    assert.match(timer, /^OnCalendar=\*-\*-\* 03:30:00 Asia\/Tokyo$/m);
    assert.match(timer, /^Persistent=true$/m);
  });
});
