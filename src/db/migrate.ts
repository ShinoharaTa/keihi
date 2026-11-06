// マイグレーション（docs/mvp-plan-v0.1.md T1-3）。src/db/migrations/NNNN_*.sql を番号順に 1 つずつトランザクションで適用する。
// 適用済みは schema_migrations に sha256 と一緒に記録し、適用済みのファイルが書き換えられていたら止める。
//
//   node src/db/migrate.ts                  # config の data_dir/keihi.db（ディレクトリは作らない）
//   node src/db/migrate.ts --db /path/to.db
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { integrityCheck, openDb, tx, type Db } from './index.ts';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export type Migration = { version: number; name: string; sql: string; sha256: string };

export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const name of readdirSync(dir).sort()) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!m) continue;
    const sql = readFileSync(path.join(dir, name), 'utf8');
    out.push({ version: Number(m[1]), name, sql, sha256: createHash('sha256').update(sql).digest('hex') });
  }
  for (const [i, m] of out.entries()) {
    if (m.version !== i + 1) throw new Error(`マイグレーションの番号が連番でない: ${m.name}`);
  }
  return out;
}

// 未適用のものを適用し、適用した名前を返す。
export function migrate(db: Db, migrations: Migration[] = listMigrations()): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Map(
    (db.prepare('SELECT version, name, sha256 FROM schema_migrations').all() as { version: number; name: string; sha256: string }[]).map((r) => [r.version, r]),
  );
  const done: string[] = [];
  for (const m of migrations) {
    const a = applied.get(m.version);
    if (a) {
      if (a.sha256 !== m.sha256) throw new Error(`適用済みのマイグレーション ${a.name} が書き換えられている`);
      continue;
    }
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)').run(m.version, m.name, m.sha256, new Date().toISOString());
    });
    done.push(m.name);
  }
  const problems = integrityCheck(db);
  if (problems.length) throw new Error(`integrity_check が ok でない: ${problems.slice(0, 5).join(' / ')}`);
  return done;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { db: { type: 'string' } } });
  let file = values.db;
  if (!file) {
    const { loadConfig } = await import('../config.ts');
    file = loadConfig().dbPath;
  }
  const db = openDb(file);
  try {
    const done = migrate(db);
    console.log(done.length ? `適用: ${done.join(', ')}` : '適用するマイグレーションは無い');
    console.log('integrity_check: ok');
  } finally {
    db.close();
  }
}
