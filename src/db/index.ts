// SQLite の接続（docs/mvp-plan-v0.1.md T1-3、D1: node:sqlite）。web と worker が同じファイルを WAL で共有する。
// 親ディレクトリは作らない（無ければ開けずにエラー）。
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') {
    const row = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
    if (row.journal_mode !== 'wal') {
      db.close();
      throw new Error(`${file} を WAL にできない（journal_mode=${row.journal_mode}）`);
    }
  }
  // 原本の記録と監査ログを失わない側に倒す（WAL の既定 NORMAL より遅いが、件数は少ない）。
  db.exec('PRAGMA synchronous = FULL');
  return db;
}

// PRAGMA integrity_check。問題が無ければ空配列。
export function integrityCheck(db: Db): string[] {
  const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
  const msgs = rows.map((r) => r.integrity_check);
  return msgs.length === 1 && msgs[0] === 'ok' ? [] : msgs;
}

// fn を 1 つのトランザクションで実行する（BEGIN IMMEDIATE で書き込みロックを先に取る）。
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}
