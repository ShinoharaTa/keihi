// M4（T4-*）のテスト用の共通部品。DB・文書・確定版・証憑のアップロードを用意する。
// 0003_review.sql（T2-8）がまだ無い worktree では、T2-8 が足す reviews の列だけを持つ仮の 0003 を挟んで適用する。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../../src/db/index.ts';
import { listMigrations, migrate, MIGRATIONS_DIR, type Migration } from '../../src/db/migrate.ts';

const STUB_0003 = `
ALTER TABLE reviews ADD COLUMN proration_pct INTEGER NOT NULL DEFAULT 100;
ALTER TABLE reviews ADD COLUMN tax_by_rate_json TEXT;
ALTER TABLE reviews ADD COLUMN invoice_reg_no TEXT;
ALTER TABLE reviews ADD COLUMN qualified_invoice INTEGER;
`;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function migrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR).sort().filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f));
  if (files.some((f) => f.startsWith('0003_'))) return listMigrations();
  // 0003 が無い間だけ: 0001, 0002, 仮の 0003, 0004… の順に配列を組む（listMigrations は連番でないと投げる）。
  const out: Migration[] = [];
  for (const name of files) {
    const version = Number(name.slice(0, 4));
    if (version === 4) out.push({ version: 3, name: '0003_review_stub.sql', sql: STUB_0003, sha256: sha(STUB_0003) });
    const sql = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    out.push({ version, name, sql, sha256: sha(sql) });
  }
  return out;
}

export function openTestDb(file: string): Db {
  const db = openDb(file);
  migrate(db, migrations());
  return db;
}

export const T0 = new Date('2026-10-16T03:00:00.000Z'); // JST 2026-10-16(金) 12:00

let seq = 0;
export function addDocument(
  db: Db,
  opts: { id?: string; receivedOn?: string; deadlineOn?: string; kind?: 'scan' | 'e_transaction'; resolutionOk?: 0 | 1 | null; paperRequired?: 0 | 1; integrityCheckedAt?: string | null } = {},
): string {
  seq++;
  const id = opts.id ?? `01JDOC${String(seq).padStart(20, '0')}`;
  db.prepare(
    `INSERT INTO documents (id, sha256, bytes, mime, orig_name, source, kind, resolution_ok, paper_required, received_at, received_on, received_on_source,
       deadline_on, deadline_mode, storage_key, integrity_checked_at, created_at)
     VALUES (?, ?, 10, 'image/jpeg', 'a.jpg', 'pwa', ?, ?, ?, ?, ?, 'server', ?, 'early', ?, ?, ?)`,
  ).run(
    id,
    createHash('sha256').update(id).digest('hex'),
    opts.kind ?? 'scan',
    opts.resolutionOk === undefined ? 1 : opts.resolutionOk,
    opts.paperRequired ?? 0,
    T0.toISOString(),
    opts.receivedOn ?? '2026-10-16',
    opts.deadlineOn ?? '2026-10-27',
    `k/${id}`,
    opts.integrityCheckedAt ?? null,
    T0.toISOString(),
  );
  return id;
}

export type ReviewOpts = {
  version?: number;
  txnDate?: string;
  amount?: number;
  vendor?: string | null;
  accountId?: string;
  taxId?: string | null;
  creditAccount?: string;
  decision?: 'approve' | 'personal' | 'duplicate' | 'reject';
  prorationPct?: number;
  taxByRate?: { category: string; amount_incl_tax: number; tax: number }[] | null;
  qualifiedInvoice?: 0 | 1 | null;
};

export function addReview(db: Db, documentId: string, o: ReviewOpts = {}): string {
  const version = o.version ?? 1;
  const id = `R-${documentId}-${version}`;
  db.prepare(
    `INSERT INTO reviews (id, document_id, version, txn_date, amount, vendor, account_id, tax_id, credit_account, decision, decided_at,
       proration_pct, tax_by_rate_json, qualified_invoice)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    documentId,
    version,
    o.txnDate ?? '2026-10-15',
    o.amount ?? 1100,
    o.vendor === undefined ? 'テスト商店' : o.vendor,
    o.accountId ?? '101',
    o.taxId === undefined ? '1' : o.taxId,
    o.creditAccount ?? 'cash',
    o.decision ?? 'approve',
    T0.toISOString(),
    o.prorationPct ?? 100,
    o.taxByRate ? JSON.stringify(o.taxByRate) : null,
    o.qualifiedInvoice === undefined ? 1 : o.qualifiedInvoice,
  );
  return id;
}

// provider_uploads に「アップロード済み」を入れる（upload_receipt ジョブの結果の代わり）。
export function markUploaded(db: Db, documentId: string, remoteReceiptId: number, uploadedAt: string = T0.toISOString()): void {
  db.prepare(
    `INSERT INTO provider_uploads (id, document_id, provider, state, remote_receipt_id, uploaded_at, created_at)
     VALUES (?, ?, 'freee', 'uploaded', ?, ?, ?)
     ON CONFLICT (document_id, provider) DO UPDATE SET state = 'uploaded', remote_receipt_id = excluded.remote_receipt_id, uploaded_at = excluded.uploaded_at`,
  ).run(`U-${documentId}`, documentId, String(remoteReceiptId), uploadedAt, T0.toISOString());
}
