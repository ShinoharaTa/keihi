// CSV の取り込み（docs/mvp-plan-v3.md T105、cashflow.md）。POST /api/accounts/:id/import（src/web/routes/bank.ts）から呼ぶ。
// 1. 口座を確かめる（無ければ 404、source が csv でなければ 400 not_csv_account）。
// 2. 文字コードを決めてヘッダでパーサーを選ぶ（無ければ 400 unknown_format）。同じ口座・同じ file_sha256 は 409 already_imported。
//    ヘッダだけ（データの行が 0）は 400 empty_file。
// 3. 原本のバイト列を objects に置く（src/storage/objects.ts。受領書と同じ。DB に書く前に置き、失敗の後に残っても上書きはしない）。
// 4. 1 トランザクションで: dedupAndInsert を dryRun で試して件数を決める → csv_imports を INSERT（追記専用で件数が NOT NULL）
//    → 本番の dedupAndInsert（source=csv、csvImportId、rawSha256 = 行の元の文字列の sha256）→ sync_status.last_csv_at。
//    skip の行（PayPay のポイント）は明細に入れず、件数だけ返す。壊れた行は行番号と理由を返し、ほかの行は入れる。
// 5. コミットの後に振替を検出する（transfers.ts。範囲は「取り込んだ明細の最小の日付 − 2 × windowDays 〜 今日」）。
//    作った組があれば監査（transfers.detected）に残す。検出が失敗しても取り込みの結果は変えない（transfers.detect_failed）。
// rows_merged は「既にあった明細に当たった行」の数（dedup の merged + touched。外部 ID が同じ行も、別の取得元の明細と組んだ行も含む）。
// rows_error は CSV として読めなかった行と、dedup の検査に落ちた行の合計。
import path from 'node:path';
import { appendAudit } from '../../audit.ts';
import { todayInTokyo } from '../../calendar/businessDays.ts';
import { tx, type Db } from '../../db/index.ts';
import { ulid } from '../../db/ids.ts';
import { putObject, sha256Hex } from '../../storage/objects.ts';
import { addDays, dedupAndInsert, type DedupInput, type DedupResult } from '../dedup.ts';
import { getAccount, updateSyncStatus } from '../repo.ts';
import { detectTransfers } from '../transfers.ts';
import { decodeCsv, detectParser, headLine, type ParseError } from './index.ts';

export class CsvImportError extends Error {
  readonly status: 400 | 404 | 409;
  readonly reason: string;
  readonly extra: Record<string, unknown>;
  constructor(status: 400 | 404 | 409, reason: string, extra: Record<string, unknown> = {}) {
    super(reason);
    this.name = 'CsvImportError';
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

export type CsvImportResult = {
  csv_import_id: string;
  parser: string;
  rows_total: number;
  rows_new: number;
  rows_merged: number;
  rows_skipped_points: number;
  rows_error: number;
  errors: ParseError[];
  date_range: { from: string; to: string } | null;
  transfers: { from: string; to: string; created: number } | { error: string } | null;
};

export type CsvImportRow = {
  id: string;
  account_id: string;
  parser_id: string;
  file_sha256: string;
  storage_key: string;
  rows_total: number;
  rows_new: number;
  rows_merged: number;
  rows_error: number;
  actor: string;
  imported_at: string;
};

function findImport(db: Db, accountId: string, sha256: string): string | null {
  const r = db.prepare('SELECT id FROM csv_imports WHERE account_id = ? AND file_sha256 = ?').get(accountId, sha256) as { id: string } | undefined;
  return r?.id ?? null;
}

// 取り込みの履歴（新しい順）。ファイル名は csv_imports に列が無いので監査（csv.imported）から引く。
export function listCsvImports(db: Db, accountId: string): (CsvImportRow & { file_name: string | null })[] {
  const rows = db.prepare('SELECT * FROM csv_imports WHERE account_id = ? ORDER BY imported_at DESC, rowid DESC').all(accountId) as CsvImportRow[];
  const nameOf = db.prepare(`SELECT payload_json FROM audit_log WHERE action = 'csv.imported' AND entity = 'csv_import' AND entity_id = ? ORDER BY seq DESC LIMIT 1`);
  return rows.map((r) => {
    const a = nameOf.get(r.id) as { payload_json: string } | undefined;
    let fileName: string | null = null;
    if (a) {
      const p = JSON.parse(a.payload_json) as { file_name?: unknown };
      if (typeof p.file_name === 'string') fileName = p.file_name;
    }
    return { ...r, file_name: fileName };
  });
}

export const FILE_NAME_MAX = 255;

// 監査に入れるファイル名。パスの部分（/ と \\）を外し、制御文字を除いて 255 文字で切る。空なら null。
export function safeFileName(name: string | null): string | null {
  if (name == null) return null;
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const cut = Array.from(base).slice(0, FILE_NAME_MAX).join('');
  return cut === '' ? null : cut;
}

const reasonCount = (r: DedupResult) => ({ new: r.new.length, merged: r.merged.length + r.touched.length, errors: r.errors.length });

export async function importCsv(
  db: Db,
  input: {
    accountId: string;
    bytes: Uint8Array;
    fileName: string | null;
    objectsDir: string;
    user: string | null;
    dedupDateWindowDays: number;
    transferWindowDays: number;
    now: Date;
  },
): Promise<CsvImportResult> {
  const account = getAccount(db, input.accountId);
  if (!account) throw new CsvImportError(404, 'not_found');
  if (account.source !== 'csv') throw new CsvImportError(400, 'not_csv_account');
  const { text } = decodeCsv(input.bytes);
  const parser = detectParser(headLine(text));
  if (!parser) throw new CsvImportError(400, 'unknown_format');
  const sha256 = sha256Hex(input.bytes);
  const dup = findImport(db, account.id, sha256);
  if (dup) throw new CsvImportError(409, 'already_imported', { csv_import_id: dup });

  const parsed = parser.parse(text);
  if (parsed.rows.length + parsed.errors.length === 0) throw new CsvImportError(400, 'empty_file');
  const stored = await putObject(input.objectsDir, input.bytes);
  const at = input.now;
  const iso = at.toISOString();

  const rows = parsed.rows.filter((r) => !r.skip);
  const skippedPoints = parsed.rows.filter((r) => r.skip === 'points').length;
  const rowsTotal = parsed.rows.length + parsed.errors.length;
  const base = (csvImportId: string | null): DedupInput[] =>
    rows.map((r) => ({
      accountId: account.id,
      source: 'csv',
      externalId: r.externalId,
      txnDate: r.txnDate,
      amount: r.amount,
      side: r.side,
      description: r.description,
      csvImportId,
      rawSha256: r.raw === undefined ? null : sha256Hex(new TextEncoder().encode(r.raw)),
    }));
  const dedupOpts = { dateWindowDays: input.dedupDateWindowDays, now: iso };

  let id: string;
  let res: DedupResult;
  try {
    ({ id, res } = tx(db, () => {
      const again = findImport(db, account.id, sha256);
      if (again) throw new CsvImportError(409, 'already_imported', { csv_import_id: again });
      const dry = reasonCount(dedupAndInsert(db, base(null), { ...dedupOpts, dryRun: true }));
      const id = ulid(at.getTime());
      db.prepare(
        `INSERT INTO csv_imports (id, account_id, parser_id, file_sha256, storage_key, rows_total, rows_new, rows_merged, rows_error, actor, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?)`,
      ).run(id, account.id, parser.id, sha256, stored.key, rowsTotal, dry.new, dry.merged, parsed.errors.length + dry.errors, iso);
      const res = dedupAndInsert(db, base(id), dedupOpts);
      const got = reasonCount(res);
      // dryRun と本番は同じ結果になるはず。違えば csv_imports の件数が嘘になるので全体を戻す。
      if (got.new !== dry.new || got.merged !== dry.merged || got.errors !== dry.errors) throw new Error('csv import: dryRun と本番の件数が違う');
      updateSyncStatus(db, account.id, { lastCsvAt: iso });
      appendAudit(
        db,
        {
          actor: 'user',
          action: 'csv.imported',
          entity: 'csv_import',
          entityId: id,
          payload: {
            account_id: account.id, parser: parser.id, file_sha256: sha256, file_name: safeFileName(input.fileName), bytes: input.bytes.length,
            rows_total: rowsTotal, rows_new: got.new, rows_merged: got.merged, rows_skipped_points: skippedPoints, rows_error: parsed.errors.length + got.errors,
            user: input.user,
          },
        },
        at,
      );
      return { id, res };
    }));
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: csv_imports\./.test(e.message)) {
      throw new CsvImportError(409, 'already_imported', { csv_import_id: findImport(db, account.id, sha256) });
    }
    throw e;
  }

  const errors: ParseError[] = [...parsed.errors, ...res.errors.map((e) => ({ line: rows[e.index]!.line, reason: e.reason }))].sort((a, b) => a.line - b.line);
  const dates = rows.map((r) => r.txnDate).sort();
  const dateRange = dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null;
  return {
    csv_import_id: id,
    parser: parser.id,
    rows_total: rowsTotal,
    rows_new: res.new.length,
    rows_merged: res.merged.length + res.touched.length,
    rows_skipped_points: skippedPoints,
    rows_error: errors.length,
    errors,
    date_range: dateRange,
    transfers: dateRange ? detectAfterImport(db, dateRange.from, input.transferWindowDays, at) : null,
  };
}

// 取り込んだ明細を含む範囲で振替を検出する。投げない（失敗は { error } で返す。src/worker/handlers/syncBank.ts と同じ）。
function detectAfterImport(db: Db, minDate: string, windowDays: number, now: Date): { from: string; to: string; created: number } | { error: string } {
  const from = addDays(minDate, -2 * windowDays);
  const to = todayInTokyo(now);
  try {
    const created = detectTransfers(db, { windowDays, now, from, to });
    if (created.length > 0) {
      const kinds: Record<string, number> = {};
      for (const l of created) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
      appendAudit(db, { actor: 'user', action: 'transfers.detected', entity: 'transfer_link', payload: { from, to, created: created.length, kinds } }, now);
    }
    return { from, to, created: created.length };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    try {
      appendAudit(db, { actor: 'user', action: 'transfers.detect_failed', entity: 'transfer_link', payload: { error } }, now);
    } catch {
      // 監査も書けないときは結果で返すだけ（取り込みの結果は変えない）
    }
    return { error };
  }
}
