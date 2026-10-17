// バックアップとリストア訓練（docs/mvp-plan-v0.1.md T5-0・T5-2・T5-3）。restic は呼ばない。
// 偽物の restic（実行時に一時ディレクトリへ書くスクリプト）が引数と環境を記録し、backup はファイルを偽のリポジトリへ
// コピー、restore はそこから戻す。設定・DB・原本はすべて一時ディレクトリ。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAudit } from '../../src/audit.ts';
import { assertSafeTargets, EXCLUDES, isCheckDue, runBackup } from '../../src/backup/backup.ts';
import { runDrill } from '../../src/backup/drill.ts';
import { ALLOWED_SUBCOMMANDS, createRestic, parseBackupSummary } from '../../src/backup/restic.ts';
import { findRestic, loadBackupSettings, type BackupSettings } from '../../src/backup/settings.ts';
import { ConfigError } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { objectPath, putObject } from '../../src/storage/objects.ts';
import { main as runMain } from '../../tools/backup/run.ts';
import { main as drillMain } from '../../tools/backup/drill.ts';

const T0 = new Date('2026-10-17T18:30:00.000Z');
const DAY = 86_400_000;

let root: string;
let n = 0;
let base: string;
let configDir: string;
let dataDir: string;
let repo: string;
let logFile: string;
let ctlFile: string;
let fakeBin: string;
let db: Db;

type LogLine = { sub: string; args: string[]; env: { password: string | null; repository: string | null; keys: string[] } };

function fakeScript(): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const LOG = ${JSON.stringify(logFile)}, REPO = ${JSON.stringify(repo)}, CTL = ${JSON.stringify(ctlFile)};
const [sub, ...args] = process.argv.slice(2);
fs.appendFileSync(LOG, JSON.stringify({ sub, args, env: { password: process.env.RESTIC_PASSWORD ?? null, repository: process.env.RESTIC_REPOSITORY ?? null, keys: Object.keys(process.env).sort() } }) + '\\n');
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(CTL, 'utf8')); } catch {}
if ((ctl.fail || []).includes(sub)) { process.stderr.write('fake: ' + sub + ' failed\\n'); process.exit(3); }
const snaps = () => fs.existsSync(REPO) ? fs.readdirSync(REPO).filter((x) => /^snap-\\d+$/.test(x)).sort((a, b) => +a.slice(5) - +b.slice(5)) : [];
if (sub === 'backup') {
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' || args[i] === '--exclude') { i++; continue; }
    if (args[i].startsWith('--')) continue;
    targets.push(args[i]);
  }
  const id = 'snap-' + (snaps().length + 1);
  for (const t of targets) fs.cpSync(t, path.join(REPO, id, t), { recursive: true });
  console.log(JSON.stringify({ message_type: 'status', percent_done: 1 }));
  console.log(JSON.stringify({ message_type: 'summary', snapshot_id: id }));
} else if (sub === 'restore') {
  const t = args[args.indexOf('--target') + 1];
  const s = snaps().at(-1);
  if (!s) { process.stderr.write('no snapshot\\n'); process.exit(1); }
  fs.cpSync(path.join(REPO, s), t, { recursive: true });
}
`;
}

async function log(): Promise<LogLine[]> {
  try {
    return (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogLine);
  } catch {
    return [];
  }
}

async function setFail(subs: string[]): Promise<void> {
  await writeFile(ctlFile, JSON.stringify({ fail: subs }));
}

const env = () => ({ RESTIC_BIN: fakeBin, PATH: '/usr/bin:/bin', HOME: base, GEMINI_API_KEY: 'parent-gemini' });

function settings(): BackupSettings {
  return loadBackupSettings({ configDir, dataDir });
}

function audits(action: string) {
  return (db.prepare('SELECT payload_json FROM audit_log WHERE action = ? ORDER BY seq').all(action) as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json) as Record<string, unknown>);
}

async function addDoc(bytes: Buffer, id: string): Promise<string> {
  const s = await putObject(path.join(dataDir, 'objects'), bytes);
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, source, kind, received_at, received_on, received_on_source, deadline_on, deadline_mode, storage_key, created_at)
     VALUES (?, ?, ?, 'image/jpeg', 'pwa', 'scan', ?, '2026-10-17', 'server', '2026-10-27', 'early', ?, ?)`,
  ).run(id, s.sha256, bytes.length, T0.toISOString(), s.key, T0.toISOString());
  return s.sha256;
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-backup-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  base = path.join(root, String(n++));
  configDir = path.join(base, 'config');
  dataDir = path.join(base, 'data');
  repo = path.join(base, 'repo');
  logFile = path.join(base, 'restic.log');
  ctlFile = path.join(base, 'ctl.json');
  fakeBin = path.join(base, 'fake-restic');
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.toml'), `[gemini]\nmodel = "x"\n\n[backup]\nkeep_snapshots = 2\n`);
  await writeFile(path.join(configDir, 'secrets.env'), `RESTIC_PASSWORD=pw-123\nRESTIC_REPOSITORY=${path.join(base, 'restic-repo')}\nB2_ACCOUNT_KEY=b2key\nGEMINI_API_KEY=gem\nFREEE_CLIENT_SECRET=fs\n`, { mode: 0o600 });
  await writeFile(path.join(dataDir, 'freee-token.json'), '{"access_token":"t"}', { mode: 0o600 });
  await writeFile(fakeBin, fakeScript(), { mode: 0o755 });
  db = openDb(path.join(dataDir, 'keihi.db'));
  migrate(db);
});

describe('settings', () => {
  test('[backup] の既定値。他のセクションは無視し、restic に渡すのは決めた名前のシークレットだけ', async () => {
    const s = settings();
    assert.equal(s.keepSnapshots, 2);
    assert.equal(s.checkIntervalDays, 7);
    assert.equal(s.readDataSubset, '5%');
    assert.equal(s.remoteVerifyMode, 'download_only');
    assert.equal(s.drillDir, path.join(dataDir, 'drill'));
    assert.equal(s.snapshotsDir, path.join(dataDir, 'snapshots'));
    assert.deepEqual(s.resticEnv, { RESTIC_PASSWORD: 'pw-123', RESTIC_REPOSITORY: path.join(base, 'restic-repo'), B2_ACCOUNT_KEY: 'b2key' });
  });

  test('config の repository が secrets.env より優先。知らないキー・不正な値はエラー', async () => {
    await writeFile(path.join(configDir, 'config.toml'), `[backup]\nrepository = "b2:keihi-bucket:keihi"\nremote_verify_mode = "sha256"\n`);
    const s = settings();
    assert.equal(s.repository, 'b2:keihi-bucket:keihi');
    assert.equal(s.resticEnv.RESTIC_REPOSITORY, 'b2:keihi-bucket:keihi');
    assert.equal(s.remoteVerifyMode, 'sha256');
    for (const bad of ['keep = 1', 'remote_verify_mode = "full"', 'keep_snapshots = 0', 'read_data_subset = "5"', 'drill_dir = "rel"']) {
      await writeFile(path.join(configDir, 'config.toml'), `[backup]\n${bad}\n`);
      assert.throws(() => settings(), ConfigError, bad);
    }
  });

  test('secrets.env が 0600 でなければ拒否（値はメッセージに出さない）', async () => {
    await chmod(path.join(configDir, 'secrets.env'), 0o644);
    assert.throws(() => settings(), (e: Error) => e instanceof ConfigError && /0600/.test(e.message) && !e.message.includes('pw-123'));
  });

  test('findRestic: RESTIC_BIN → ~/.local/bin → PATH。無ければ null', async () => {
    assert.equal(findRestic({ RESTIC_BIN: fakeBin }), fakeBin);
    assert.equal(findRestic({ RESTIC_BIN: path.join(base, 'nope') }), null);
    assert.equal(findRestic({ HOME: base, PATH: path.join(base, 'empty') }), null);
    await mkdir(path.join(base, '.local', 'bin'), { recursive: true });
    await writeFile(path.join(base, '.local', 'bin', 'restic'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(findRestic({ HOME: base, PATH: '' }), path.join(base, '.local', 'bin', 'restic'));
  });
});

describe('restic ラッパ', () => {
  test('許可していないサブコマンドは起動しない。子の環境は最小限 + restic 用のシークレットだけ', async () => {
    const r = createRestic(fakeBin, { RESTIC_PASSWORD: 'p' }, env());
    await assert.rejects(r.run('forget' as never, []), /呼ばない/);
    await assert.rejects(r.run('prune' as never, []), /呼ばない/);
    assert.deepEqual([...ALLOWED_SUBCOMMANDS].sort(), ['backup', 'check', 'restore', 'snapshots', 'version']);
    assert.equal((await r.run('version', [])).code, 0);
    const [l] = await log();
    assert.equal(l.sub, 'version');
    assert.equal(l.env.password, 'p');
    assert.ok(!l.env.keys.includes('GEMINI_API_KEY'));
    assert.ok(!l.env.keys.includes('RESTIC_BIN'));
  });

  test('parseBackupSummary', () => {
    assert.deepEqual(parseBackupSummary('{"message_type":"status"}\n{"message_type":"summary","snapshot_id":"abc"}\n'), { snapshotId: 'abc' });
    assert.deepEqual(parseBackupSummary('garbage\n{"message_type":"summ'), { snapshotId: null });
  });
});

describe('runBackup（T5-2）', () => {
  test('スナップショット → restic backup（最新のスナップショット・manifest・objects/、トークンとシークレットを除外）→ 初回は check', async () => {
    await addDoc(Buffer.from('receipt-1'), 'doc-1');
    const s = settings();
    const r = await runBackup({ settings: s, db, restic: createRestic(fakeBin, s.resticEnv, env()), now: () => T0 });
    assert.equal(r.ok, true, r.error ?? '');
    assert.equal(r.snapshot, 'keihi-20261017T183000Z.db');
    assert.equal(r.resticSnapshotId, 'snap-1');
    assert.equal(r.check, 'ok');
    const calls = await log();
    assert.deepEqual(calls.map((c) => c.sub), ['backup', 'check']);
    const args = calls[0].args;
    for (const e of EXCLUDES) assert.ok(args.join(' ').includes(`--exclude ${e}`), e);
    assert.ok(args.includes('freee-token.json'));
    assert.ok(args.includes('secrets.env'));
    const targets = args.slice(args.lastIndexOf(EXCLUDES.at(-1)!) + 1);
    assert.deepEqual(targets, [
      path.join(dataDir, 'snapshots', 'keihi-20261017T183000Z.db'),
      path.join(dataDir, 'snapshots', 'keihi-20261017T183000Z.manifest.json'),
      path.join(dataDir, 'objects'),
    ]);
    assert.ok(!targets.some((t) => t === dataDir || t.includes('freee-token') || t.startsWith(configDir)));
    assert.equal(calls[0].env.password, 'pw-123');
    assert.ok(!calls[0].env.keys.includes('GEMINI_API_KEY') && !calls[0].env.keys.includes('FREEE_CLIENT_SECRET'));
    // 偽のリポジトリにトークンが入っていない
    const copied = await readdir(path.join(repo, 'snap-1', dataDir));
    assert.deepEqual(copied.sort(), ['objects', 'snapshots']);
    const [a] = audits('backup.run');
    assert.equal(a.ok, true);
    assert.equal(a.check, 'ok');
    assert.equal(a.restic_snapshot_id, 'snap-1');
    assert.equal(verifyAudit(db).ok, true);
  });

  test('check は前回の成功から 7 日以上経ったときだけ。ローカルのスナップショットは keep_snapshots 個', async () => {
    const s = settings();
    const restic = createRestic(fakeBin, s.resticEnv, env());
    const subs: string[][] = [];
    for (let d = 0; d < 9; d++) {
      const before = (await log()).length;
      const r = await runBackup({ settings: s, db, restic, now: () => new Date(T0.getTime() + d * DAY) });
      assert.equal(r.ok, true, r.error ?? '');
      subs.push((await log()).slice(before).map((c) => c.sub));
    }
    assert.deepEqual(subs.map((x) => x.includes('check')), [true, false, false, false, false, false, false, true, false]);
    const snaps = (await readdir(path.join(dataDir, 'snapshots'))).filter((f) => f.endsWith('.db'));
    assert.equal(snaps.length, 2);
    assert.equal(isCheckDue(db, new Date(T0.getTime() + 8 * DAY), 7), false);
    assert.equal(isCheckDue(db, new Date(T0.getTime() + 14 * DAY), 7), true);
    // --check / --no-check で強制
    await runBackup({ settings: s, db, restic, now: () => new Date(T0.getTime() + 9 * DAY), check: true });
    assert.equal((await log()).at(-1)!.sub, 'check');
    await runBackup({ settings: s, db, restic, now: () => new Date(T0.getTime() + 30 * DAY), check: false });
    assert.equal((await log()).at(-1)!.sub, 'backup');
  });

  test('restic backup が失敗したら ok=false で audit に残し、ローカルのスナップショットは消さない', async () => {
    const s = settings();
    const restic = createRestic(fakeBin, s.resticEnv, env());
    for (let d = 0; d < 2; d++) await runBackup({ settings: s, db, restic, now: () => new Date(T0.getTime() + d * DAY) });
    await setFail(['backup']);
    const r = await runBackup({ settings: s, db, restic, now: () => new Date(T0.getTime() + 2 * DAY) });
    assert.equal(r.ok, false);
    assert.match(r.error!, /restic backup が失敗（終了コード 3）: fake: backup failed/);
    assert.equal((await readdir(path.join(dataDir, 'snapshots'))).filter((f) => f.endsWith('.db')).length, 3);
    const last = audits('backup.run').at(-1)!;
    assert.equal(last.ok, false);
    assert.match(String(last.error), /restic backup/);
  });

  test('restic check の失敗も失敗。check の失敗は「前回の成功」に数えない', async () => {
    const s = settings();
    const restic = createRestic(fakeBin, s.resticEnv, env());
    await setFail(['check']);
    const r = await runBackup({ settings: s, db, restic, now: () => T0 });
    assert.equal(r.ok, false);
    assert.equal(r.check, 'failed');
    await setFail([]);
    const before = (await log()).length;
    await runBackup({ settings: s, db, restic, now: () => new Date(T0.getTime() + DAY) });
    assert.ok((await log()).slice(before).some((c) => c.sub === 'check'));
  });

  test('パスワードか保存先が無ければ restic を呼ばずに失敗', async () => {
    await writeFile(path.join(configDir, 'secrets.env'), `RESTIC_REPOSITORY=/x\n`, { mode: 0o600 });
    const s = settings();
    const r = await runBackup({ settings: s, db, restic: createRestic(fakeBin, s.resticEnv, env()), now: () => T0 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /RESTIC_PASSWORD/);
    await writeFile(path.join(configDir, 'secrets.env'), `RESTIC_PASSWORD=p\n`, { mode: 0o600 });
    const s2 = settings();
    const r2 = await runBackup({ settings: s2, db, restic: createRestic(fakeBin, s2.resticEnv, env()), now: () => T0 });
    assert.match(r2.error!, /保存先が無い/);
    assert.deepEqual(await log(), []);
  });

  test('assertSafeTargets: トークン・設定ディレクトリに重なる対象は拒否', () => {
    const s = settings();
    assert.throws(() => assertSafeTargets([dataDir], s), /freee-token/);
    assert.throws(() => assertSafeTargets([path.join(configDir, 'x')], s), /config/);
    assertSafeTargets([path.join(dataDir, 'objects')], s);
  });

  test('prune・forget を呼ぶコードが無い（grep）', async () => {
    const files = ['src/backup/backup.ts', 'src/backup/drill.ts', 'src/backup/restic.ts', 'src/backup/snapshot.ts', 'src/backup/settings.ts', 'tools/backup/run.ts', 'tools/backup/drill.ts', 'tools/backup/common.ts'];
    for (const f of files) {
      const src = await readFile(path.join(import.meta.dirname, '..', '..', f), 'utf8');
      assert.doesNotMatch(src, /['"`](?:prune|forget)['"`]/, f);
      assert.doesNotMatch(src, /--prune|forget --/, f);
    }
  });
});

describe('tools/backup/run.ts', () => {
  test('restic が無ければ分かるメッセージで終了コード 2、audit に残す', async () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(' '));
    try {
      const code = await runMain(['--config-dir', configDir, '--data-dir', dataDir], { RESTIC_BIN: path.join(base, 'missing'), PATH: '', HOME: base });
      assert.equal(code, 2);
    } finally {
      console.error = orig;
    }
    assert.match(errs.join('\n'), /restic が見つからない.*docs\/ops\/backup\.md/);
    assert.equal(audits('backup.run').at(-1)!.ok, false);
  });

  test('成功で 0、失敗で 1。DB が無ければ作らずに 2', async () => {
    const quiet = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
    try {
      assert.equal(await runMain(['--config-dir', configDir, '--data-dir', dataDir, '--no-check'], env()), 0);
      await setFail(['backup']);
      assert.equal(await runMain(['--config-dir', configDir, '--data-dir', dataDir], env()), 1);
      const empty = path.join(base, 'empty-data');
      assert.equal(await runMain(['--config-dir', configDir, '--data-dir', empty], env()), 2);
      await assert.rejects(stat(path.join(empty, 'keihi.db')));
      assert.equal(await runMain(['--check', '--no-check', '--data-dir', dataDir], env()), 2);
    } finally {
      console.log = quiet.log;
      console.error = quiet.error;
    }
  });
});

describe('runDrill（T5-3）', () => {
  async function backupOnce(at: Date) {
    const s = settings();
    const r = await runBackup({ settings: s, db, restic: createRestic(fakeBin, s.resticEnv, env()), now: () => at, check: false });
    assert.equal(r.ok, true, r.error ?? '');
  }

  test('正常系: check --read-data-subset=5% → 最新を restore → 照合すべて ok、audit に記録、復元先を消す', async () => {
    await addDoc(Buffer.from('receipt-1'), 'doc-1');
    await addDoc(Buffer.from('receipt-2'), 'doc-2');
    await backupOnce(T0);
    await addDoc(Buffer.from('receipt-3'), 'doc-3'); // 2 回目の backup のスナップショットに入る
    await backupOnce(new Date(T0.getTime() + DAY));
    const s = settings();
    const before = (await log()).length;
    const r = await runDrill({ settings: s, db, restic: createRestic(fakeBin, s.resticEnv, env()), now: () => new Date(T0.getTime() + 2 * DAY) });
    assert.deepEqual(r.failures, []);
    assert.equal(r.ok, true);
    assert.equal(r.check, 'ok');
    assert.equal(r.snapshot, 'keihi-20261018T183000Z.db');
    assert.equal(r.documents, 3);
    assert.equal(r.objectsVerified, 3);
    assert.equal(r.objectsExtra, 0);
    const calls = (await log()).slice(before);
    assert.deepEqual(calls.map((c) => [c.sub, ...c.args.filter((a) => a !== r.target)]), [
      ['check', '--read-data-subset=5%'],
      ['restore', 'latest', '--tag', 'keihi', '--target'],
    ]);
    await assert.rejects(stat(r.target!));
    const [a] = audits('backup.drill');
    assert.equal(a.ok, true);
    assert.equal(a.documents, 3);
    assert.equal(verifyAudit(db).ok, true);
  });

  test('復元した原本を 1 件壊すと fail を報告して終了コード 1、復元先を残す', async () => {
    const sha = await addDoc(Buffer.from('receipt-1'), 'doc-1');
    await addDoc(Buffer.from('receipt-2'), 'doc-2');
    await backupOnce(T0);
    const broken = objectPath(path.join(repo, 'snap-1', dataDir, 'objects'), sha);
    await chmod(broken, 0o644);
    await writeFile(broken, 'tampered');
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(' '));
    let code;
    try {
      code = await drillMain(['--config-dir', configDir, '--data-dir', dataDir], env());
    } finally {
      console.error = orig;
    }
    assert.equal(code, 1);
    assert.match(errs.join('\n'), new RegExp(`原本の sha256 が一致しない: ${sha}`));
    const a = audits('backup.drill').at(-1)!;
    assert.equal(a.ok, false);
    assert.equal(a.failure_count, 1);
    assert.ok(typeof a.kept_target === 'string');
    await stat(a.kept_target as string);
  });

  test('restic check の失敗・DB スナップショットの改変も fail', async () => {
    await addDoc(Buffer.from('receipt-1'), 'doc-1');
    await backupOnce(T0);
    const snapDir = path.join(repo, 'snap-1', dataDir, 'snapshots');
    const manifest = (await readdir(snapDir)).find((f) => f.endsWith('.manifest.json'))!;
    const m = JSON.parse(await readFile(path.join(snapDir, manifest), 'utf8'));
    m.documents.count = 99;
    await writeFile(path.join(snapDir, manifest), JSON.stringify(m));
    await setFail(['check']);
    const s = settings();
    const r = await runDrill({ settings: s, db, restic: createRestic(fakeBin, s.resticEnv, env()), now: () => new Date(T0.getTime() + DAY) });
    assert.equal(r.ok, false);
    assert.equal(r.check, 'failed');
    assert.ok(r.failures.some((f) => /restic check --read-data-subset=5% が失敗/.test(f)));
    assert.ok(r.failures.some((f) => /documents の件数が manifest と違う/.test(f)));
  });

  test('restore が失敗したら fail（復元先は残す）', async () => {
    const s = settings();
    const r = await runDrill({ settings: s, db, restic: createRestic(fakeBin, s.resticEnv, env()), now: () => T0 });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /restic restore が失敗/.test(f)));
    assert.equal(r.kept, true);
  });
});
