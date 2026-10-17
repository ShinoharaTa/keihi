// リストア訓練（docs/mvp-plan-v0.1.md T5-3、architecture.md §3.4）。tools/backup/drill.ts から呼ぶ。四半期に 1 回。
// 1. restic check --read-data-subset=<5%>
// 2. <drill_dir>/drill-<ts> に最新の restic スナップショット（tag keihi）を全量 restore
// 3. 復元した DB スナップショット: integrity_check、manifest 照合（ファイルの sha256・documents の件数と一覧のハッシュ・
//    audit の最終 seq と hash）、監査ログの verify
// 4. 復元した objects: documents.sha256 のすべてについてファイルがあり中身の sha256 が一致するか。加えて objects/ の
//    全ファイルの sha256 を再計算し、名前と一致するか（スナップショットの後に増えた分は extra として数えるだけ）
// 5. 結果を本体の DB の audit に記録（backup.drill）。成功したら復元先を消す。失敗したら調べられるよう残す。
// 通知は Q6 が未決なので、ここでは返り値と audit だけ（標準出力は tools/backup/drill.ts）。
import { readdir, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appendAudit, verifyAudit } from '../audit.ts';
import { integrityCheck, type Db } from '../db/index.ts';
import { objectPath, verifyObject } from '../storage/objects.ts';
import { RESTIC_TAG } from './backup.ts';
import { tail, type Restic } from './restic.ts';
import type { BackupSettings } from './settings.ts';
import { describeDb, fileSha256, listSnapshots, manifestPathFor, snapshotStamp, type Manifest } from './snapshot.ts';

const HEX64 = /^[0-9a-f]{64}$/;
// audit に載せる失敗の件数の上限（全件は件数で残す）。
const MAX_LISTED = 50;

export type DrillResult = {
  ok: boolean;
  target: string | null;
  kept: boolean;
  check: 'ok' | 'failed';
  snapshot: string | null;
  documents: number;
  objectsVerified: number;
  objectsExtra: number;
  failures: string[];
  failureCount: number;
};

export type DrillOptions = {
  settings: BackupSettings;
  db: Db;
  restic: Restic;
  now?: () => Date;
};

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

async function verifyQuiet(root: string, sha256: string): Promise<'ok' | 'mismatch' | 'missing'> {
  try {
    return (await verifyObject(root, sha256)) ? 'ok' : 'mismatch';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw e;
  }
}

export async function runDrill(opts: DrillOptions): Promise<DrillResult> {
  const { settings, db, restic } = opts;
  const now = opts.now ?? (() => new Date());
  const started = now();
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  const res: DrillResult = {
    ok: false,
    target: null,
    kept: false,
    check: 'failed',
    snapshot: null,
    documents: 0,
    objectsVerified: 0,
    objectsExtra: 0,
    failures: [],
    failureCount: 0,
  };
  try {
    if (!settings.repository) throw new Error('restic の保存先が無い（config.toml の [backup] repository か secrets.env の RESTIC_REPOSITORY）');
    if (!settings.resticEnv.RESTIC_PASSWORD) throw new Error(`${settings.secretsPath} に RESTIC_PASSWORD が無い`);

    const c = await restic.run('check', [`--read-data-subset=${settings.readDataSubset}`]);
    res.check = c.code === 0 ? 'ok' : 'failed';
    if (c.code !== 0) fail(`restic check --read-data-subset=${settings.readDataSubset} が失敗（終了コード ${c.code}）: ${tail(c.stderr)}`);

    const target = path.join(settings.drillDir, `drill-${snapshotStamp(started)}`);
    await mkdir(settings.drillDir, { recursive: true, mode: 0o700 });
    await mkdir(target, { mode: 0o700 }); // 既にあれば EEXIST（前回の残りと混ぜない）
    res.target = target;
    const r = await restic.run('restore', ['latest', '--tag', RESTIC_TAG, '--target', target]);
    if (r.code !== 0) throw new Error(`restic restore が失敗（終了コード ${r.code}）: ${tail(r.stderr)}`);

    // restic は絶対パスのまま復元する（<target>/<data_dir>/...）。
    const restored = path.join(target, settings.dataDir);
    const snapDbPath = (await listSnapshots(path.join(restored, 'snapshots')))[0];
    if (!snapDbPath) throw new Error(`復元先に DB のスナップショットが無い（${path.join(restored, 'snapshots')}）`);
    res.snapshot = path.basename(snapDbPath);

    let manifest: Manifest | null = null;
    try {
      manifest = JSON.parse(await readFile(manifestPathFor(snapDbPath), 'utf8')) as Manifest;
    } catch (e) {
      fail(`manifest を読めない: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (manifest && manifest.db_sha256 !== (await fileSha256(snapDbPath))) fail('DB スナップショットの sha256 が manifest と一致しない');

    const snap = new DatabaseSync(snapDbPath, { readOnly: true });
    let shas: string[];
    try {
      const ic = integrityCheck(snap);
      if (ic.length) fail(`DB の integrity_check: ${ic.slice(0, 5).join(' / ')}`);
      const av = verifyAudit(snap);
      if (!av.ok) fail(`監査ログの verify が seq ${av.seq} で失敗: ${av.reason}`);
      const desc = describeDb(snap);
      if (manifest) {
        if (desc.documents.count !== manifest.documents.count) fail(`documents の件数が manifest と違う（${desc.documents.count} / ${manifest.documents.count}）`);
        if (desc.documents.sha256_list_hash !== manifest.documents.sha256_list_hash) fail('documents の sha256 一覧のハッシュが manifest と違う');
        if (desc.audit.last_seq !== manifest.audit.last_seq || desc.audit.last_hash !== manifest.audit.last_hash) fail('audit の最終 seq / hash が manifest と違う');
      }
      shas = (snap.prepare('SELECT sha256 FROM documents ORDER BY sha256').all() as { sha256: string }[]).map((x) => x.sha256);
    } finally {
      snap.close();
    }
    res.documents = shas.length;

    const objectsRoot = path.join(restored, 'objects');
    const known = new Set(shas);
    for (const sha of shas) {
      const v = await verifyQuiet(objectsRoot, sha);
      if (v === 'missing') fail(`原本が復元されていない: ${sha}`);
      else if (v === 'mismatch') fail(`原本の sha256 が一致しない: ${sha}`);
    }
    for await (const f of walkFiles(objectsRoot)) {
      const name = path.basename(f);
      if (!HEX64.test(name) || objectPath(objectsRoot, name) !== f) {
        fail(`objects に想定外のファイル: ${path.relative(objectsRoot, f)}`);
        continue;
      }
      if ((await fileSha256(f)) !== name) {
        if (!known.has(name)) fail(`原本の sha256 が一致しない: ${name}`); // known は上で数えた
        continue;
      }
      res.objectsVerified++;
      if (!known.has(name)) res.objectsExtra++;
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  res.failureCount = failures.length;
  res.failures = failures.slice(0, MAX_LISTED);
  res.ok = failures.length === 0;
  if (res.target) {
    if (res.ok) await rm(res.target, { recursive: true, force: true });
    else res.kept = true;
  }
  appendAudit(
    db,
    {
      actor: 'backup',
      action: 'backup.drill',
      entity: 'backup',
      entityId: res.snapshot,
      payload: {
        ok: res.ok,
        check: res.check,
        read_data_subset: settings.readDataSubset,
        snapshot: res.snapshot,
        documents: res.documents,
        objects_verified: res.objectsVerified,
        objects_extra: res.objectsExtra,
        failure_count: res.failureCount,
        failures: res.failures,
        kept_target: res.kept ? res.target : null,
        started_at: started.toISOString(),
      },
    },
    now(),
  );
  return res;
}
