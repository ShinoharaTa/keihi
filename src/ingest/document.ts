// 証憑の取り込みの本体（POST /api/documents と、メールの添付の取り込み（src/mail/ingest.ts）が共用する）。
// 手順は src/web/routes/ingest.ts の冒頭のとおり: MIME を先頭バイトで判定 → sha256 の重複 → scan の R2・R3 → 期限 → 原本の保存
// → documents 行 + audit（document.received）+ jobs（upload_receipt、extract）を 1 トランザクションで記録する。
// - prepareDocument（非同期。検証と原本の保存）と insertDocument（同期。DB への記録）に分けてある。メールは 1 通の添付を全部
//   prepare してから、mail_messages と一緒に 1 トランザクションで insert する。ingestDocument は両方を続けて呼ぶ。
// - worker の起動はしない（呼び出し側が行う）。
import { appendAudit } from '../audit.ts';
import { deadline } from '../calendar/businessDays.ts';
import type { Config } from '../config.ts';
import { tx, type Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';
import { enqueue } from '../jobs/queue.ts';
import { putObject, sha256Hex } from '../storage/objects.ts';
import { checkScanImage, sniffMime, type AllowedMime } from './validate.ts';

export type DocumentKind = 'scan' | 'e_transaction';
export type DocumentSource = 'pwa' | 'share' | 'imap';

export type IngestInput = {
  bytes: Uint8Array;
  origName: string | null;
  kind: DocumentKind;
  // scan では必須（呼び出し側で確かめる）。
  sizePreset: string | null;
  receivedOn: string;
  receivedOnSource: 'client' | 'server';
  noAi: boolean;
  force: boolean;
  source: DocumentSource;
  sourceRef?: string | null;
  // 監査ログの actor（既定 user）。
  actor?: string;
};

export type IngestDeps = {
  db: Db;
  objectsDir: string;
  config: Pick<Config, 'calendar' | 'deadline'>;
};

export type IngestRejection =
  | { status: 409; body: { reason: 'duplicate'; id: string; sha256: string } }
  | { status: 415; body: { reason: 'unsupported_media_type' } }
  | { status: 422; body: { reason: 'invalid_image' | 'resolution_too_low' | 'grayscale_or_low_bit_depth' | 'scan_requires_image'; [k: string]: unknown } };

export type PreparedDocument = {
  input: IngestInput;
  sha256: string;
  mime: AllowedMime;
  storageKey: string;
  width: number | null;
  height: number | null;
  resolutionOk: boolean | null;
  colorOk: boolean | null;
  paperRequired: boolean;
  deadlineOn: string;
  deadlineMode: string;
  warnings: string[];
};

export type IngestOk = { ok: true; id: string; sha256: string; deadline_on: string; warnings: string[] };
export type IngestResult = IngestOk | ({ ok: false } & IngestRejection);

export const MAX_ORIG_NAME_LENGTH = 500;

// 元のファイル名の整形（POST /api/documents とメールの添付で共通）: 制御文字（NUL・CR・LF など）を除き、パス区切り（/ と \）の
// 後ろだけを残して 500 字に切る。空になれば null。
export function sanitizeFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  const noCtl = name.replace(/[\u0000-\u001f\u007f]/g, '');
  const base = noCtl.split(/[/\\]/).pop() ?? '';
  const out = base.trim().slice(0, MAX_ORIG_NAME_LENGTH);
  return out || null;
}

function findBySha(db: Db, sha256: string): string | null {
  return (db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha256) as { id: string } | undefined)?.id ?? null;
}

// 検証して原本を保存する。弾くときは保存しない。
export async function prepareDocument(deps: IngestDeps, input: IngestInput): Promise<{ ok: true; prepared: PreparedDocument } | ({ ok: false } & IngestRejection)> {
  const { bytes, kind, force } = input;
  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, status: 415, body: { reason: 'unsupported_media_type' } };

  const sha256 = sha256Hex(bytes);
  const dup = findBySha(deps.db, sha256);
  if (dup) return { ok: false, status: 409, body: { reason: 'duplicate', id: dup, sha256 } };

  // R2・R3（scan のみ）。
  let width: number | null = null;
  let height: number | null = null;
  let resolutionOk: boolean | null = null;
  let colorOk: boolean | null = null;
  const warnings: string[] = [];
  if (kind === 'scan') {
    if (mime === 'application/pdf') {
      if (!force) return { ok: false, status: 422, body: { reason: 'scan_requires_image' } };
      resolutionOk = false;
      colorOk = false;
      warnings.push('scan_requires_image');
    } else {
      let chk;
      try {
        chk = await checkScanImage(bytes, input.sizePreset!);
      } catch {
        return { ok: false, status: 422, body: { reason: 'invalid_image' } };
      }
      width = chk.width;
      height = chk.height;
      resolutionOk = chk.resolutionOk;
      colorOk = chk.colorOk;
      if (!resolutionOk && !force) return { ok: false, status: 422, body: { reason: 'resolution_too_low', width, height, required: chk.required } };
      if (!colorOk && !force) return { ok: false, status: 422, body: { reason: 'grayscale_or_low_bit_depth' } };
      if (!resolutionOk) warnings.push('resolution_too_low');
      if (!colorOk) warnings.push('grayscale_or_low_bit_depth');
    }
  }
  const paperRequired = resolutionOk === false || colorOk === false;
  if (paperRequired) warnings.push('paper_required');

  const dl = deadline(input.receivedOn, deps.config.calendar.deadlineMode, {
    yearEndHolidays: deps.config.calendar.yearEndHolidays,
    countFrom: deps.config.deadline.countFrom,
  });
  warnings.push(...dl.warnings);

  const stored = await putObject(deps.objectsDir, bytes);
  return {
    ok: true,
    prepared: {
      input, sha256, mime, storageKey: stored.key, width, height, resolutionOk, colorOk, paperRequired,
      deadlineOn: dl.deadlineOn, deadlineMode: dl.mode, warnings,
    },
  };
}

// documents 行・監査・ジョブを記録する（呼び出し側のトランザクションがあればその中で）。
// 同じ sha256 が先に入っていれば何も書かずに 409 を返す。
export function insertDocument(db: Db, p: PreparedDocument, at: Date): IngestOk | ({ ok: false } & Extract<IngestRejection, { status: 409 }>) {
  const { input } = p;
  const iso = at.toISOString();
  const id = ulid(at.getTime());
  const b = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
  const dup409 = () => ({ ok: false as const, status: 409 as const, body: { reason: 'duplicate' as const, id: findBySha(db, p.sha256)!, sha256: p.sha256 } });
  try {
    return tx(db, () => {
      if (findBySha(db, p.sha256)) return dup409();
      db.prepare(
        `INSERT INTO documents (id, sha256, bytes, mime, orig_name, source, source_ref, kind, size_preset, width_px, height_px,
          resolution_ok, color_ok, paper_required, received_at, received_on, received_on_source, deadline_on, deadline_mode,
          storage_key, no_ai, status, paper_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
      ).run(
        id, p.sha256, input.bytes.length, p.mime, sanitizeFileName(input.origName), input.source, input.sourceRef ?? null, input.kind, input.sizePreset,
        p.width, p.height, b(p.resolutionOk), b(p.colorOk), p.paperRequired ? 1 : 0, iso, input.receivedOn, input.receivedOnSource,
        p.deadlineOn, p.deadlineMode, p.storageKey, input.noAi ? 1 : 0, p.paperRequired ? 'keep_required' : 'unknown', iso,
      );
      appendAudit(
        db,
        {
          actor: input.actor ?? 'user',
          action: 'document.received',
          entity: 'document',
          entityId: id,
          payload: {
            sha256: p.sha256, bytes: input.bytes.length, mime: p.mime, kind: input.kind, size_preset: input.sizePreset, source: input.source,
            received_on: input.receivedOn, received_on_source: input.receivedOnSource, deadline_on: p.deadlineOn, deadline_mode: p.deadlineMode,
            resolution_ok: p.resolutionOk, color_ok: p.colorOk, paper_required: p.paperRequired, forced: input.force, no_ai: input.noAi,
          },
        },
        at,
      );
      enqueue(db, 'upload_receipt', id, { now: at });
      // no_ai でも積む（抽出ハンドラが Gemini を呼ばずに needs_review にする）。
      enqueue(db, 'extract', id, { now: at });
      return { ok: true as const, id, sha256: p.sha256, deadline_on: p.deadlineOn, warnings: p.warnings };
    });
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: documents\.sha256/.test(e.message)) return dup409();
    throw e;
  }
}

export async function ingestDocument(deps: IngestDeps, input: IngestInput, now: () => Date): Promise<IngestResult> {
  const r = await prepareDocument(deps, input);
  if (!r.ok) return r;
  return insertDocument(deps.db, r.prepared, now());
}
