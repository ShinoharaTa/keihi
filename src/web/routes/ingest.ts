// 取り込み API（docs/mvp-plan-v0.1.md T1-6、legal.md R1〜R5）。
//   POST /api/documents  multipart: file, kind, size_preset?, received_on?, no_ai?, force?, source?
//   → 201 {id, sha256, deadline_on, warnings[]} / 409 duplicate / 413 / 415 / 422 {reason}
// - 受信したバイト列をそのまま sha256 → 既にあれば 409（加工しない。R4）。
// - scan の R2（解像度）・R3（カラー）を満たさなければ 422。force=true なら受理し、resolution_ok / color_ok = 0、
//   paper_required = 1、paper_status = keep_required を記録する（スキャナ保存の要件を満たさないので紙原本を残す）。
//   scan の PDF は画素を判定できないので R2・R3 を満たさない扱い（force が無ければ 422）。
// - 受領日はクライアントが送る（撮影日 / 受領日）。無ければ Asia/Tokyo の受信日（R5）。未来日は 422。
// - documents 行 + audit（document.received）+ jobs（upload_receipt、extract。no_ai でも extract は積む）を 1 トランザクションで記録し、
//   コミット後に worker を起動する。
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { appendAudit } from '../../audit.ts';
import { deadline, todayInTokyo } from '../../calendar/businessDays.ts';
import { tx } from '../../db/index.ts';
import { ulid } from '../../db/ids.ts';
import { checkScanImage, SIZE_PRESETS, sniffMime } from '../../ingest/validate.ts';
import { enqueue } from '../../jobs/queue.ts';
import { putObject, sha256Hex } from '../../storage/objects.ts';
import type { AppDeps } from '../app.ts';

// multipart の境界やほかのフィールドの分の余裕。ファイル本体の上限は別に確かめる。
const MULTIPART_OVERHEAD = 64 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Reason =
  | 'kind_required'
  | 'invalid_kind'
  | 'file_required'
  | 'size_preset_required'
  | 'invalid_size_preset'
  | 'invalid_received_on'
  | 'received_on_in_future'
  | 'invalid_flag'
  | 'invalid_source'
  | 'invalid_image'
  | 'resolution_too_low'
  | 'grayscale_or_low_bit_depth'
  | 'scan_requires_image';

function flag(v: unknown): boolean | null {
  if (v === undefined || v === '') return false;
  if (v === 'true' || v === '1' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'off') return false;
  return null;
}

function validDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

export function ingestRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  const now = deps.now ?? (() => new Date());
  const maxBytes = deps.config.ingest.maxBytes;

  r.post(
    '/documents',
    bodyLimit({ maxSize: maxBytes + MULTIPART_OVERHEAD, onError: (c) => c.json({ reason: 'too_large', max_bytes: maxBytes }, 413) }),
    async (c) => {
      const bad = (reason: Reason, extra: Record<string, unknown> = {}) => c.json({ reason, ...extra }, 422);
      let body: Record<string, string | File>;
      try {
        body = (await c.req.parseBody()) as Record<string, string | File>;
      } catch {
        return bad('file_required');
      }
      const file = body.file;
      if (!(file instanceof File)) return bad('file_required');
      if (file.size > maxBytes) return c.json({ reason: 'too_large', max_bytes: maxBytes }, 413);

      // R1: 種類は必ず選ばせる。
      const kind = body.kind;
      if (kind === undefined || kind === '') return bad('kind_required');
      if (kind !== 'scan' && kind !== 'e_transaction') return bad('invalid_kind');

      const noAi = flag(body.no_ai);
      const force = flag(body.force);
      if (noAi === null || force === null) return bad('invalid_flag');
      const source = body.source === undefined || body.source === '' ? 'pwa' : body.source;
      if (source !== 'pwa' && source !== 'share') return bad('invalid_source');

      const sizePreset = typeof body.size_preset === 'string' && body.size_preset !== '' ? body.size_preset : null;
      if (sizePreset !== null && !SIZE_PRESETS[sizePreset]) return bad('invalid_size_preset');
      if (kind === 'scan' && sizePreset === null) return bad('size_preset_required');

      // R5: 受領日。
      const today = todayInTokyo(now());
      let receivedOn = today;
      let receivedOnSource: 'client' | 'server' = 'server';
      if (body.received_on !== undefined && body.received_on !== '') {
        if (typeof body.received_on !== 'string' || !validDate(body.received_on)) return bad('invalid_received_on');
        if (body.received_on > today) return bad('received_on_in_future');
        receivedOn = body.received_on;
        receivedOnSource = 'client';
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = sniffMime(bytes);
      if (!mime) return c.json({ reason: 'unsupported_media_type' }, 415);

      const sha256 = sha256Hex(bytes);
      const dup = deps.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha256) as { id: string } | undefined;
      if (dup) return c.json({ reason: 'duplicate', id: dup.id, sha256 }, 409);

      // R2・R3（scan のみ）。
      let width: number | null = null;
      let height: number | null = null;
      let resolutionOk: boolean | null = null;
      let colorOk: boolean | null = null;
      const warnings: string[] = [];
      if (kind === 'scan') {
        if (mime === 'application/pdf') {
          if (!force) return bad('scan_requires_image');
          resolutionOk = false;
          colorOk = false;
          warnings.push('scan_requires_image');
        } else {
          let chk;
          try {
            chk = await checkScanImage(bytes, sizePreset!);
          } catch {
            return bad('invalid_image');
          }
          width = chk.width;
          height = chk.height;
          resolutionOk = chk.resolutionOk;
          colorOk = chk.colorOk;
          if (!resolutionOk && !force) return bad('resolution_too_low', { width, height, required: chk.required });
          if (!colorOk && !force) return bad('grayscale_or_low_bit_depth');
          if (!resolutionOk) warnings.push('resolution_too_low');
          if (!colorOk) warnings.push('grayscale_or_low_bit_depth');
        }
      }
      const paperRequired = resolutionOk === false || colorOk === false;
      if (paperRequired) warnings.push('paper_required');

      const dl = deadline(receivedOn, deps.config.calendar.deadlineMode, {
        yearEndHolidays: deps.config.calendar.yearEndHolidays,
        countFrom: deps.config.deadline.countFrom,
      });
      warnings.push(...dl.warnings);

      const stored = await putObject(deps.objectsDir, bytes);
      const at = now();
      const iso = at.toISOString();
      const id = ulid(at.getTime());
      const b = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
      try {
        tx(deps.db, () => {
          deps.db
            .prepare(
              `INSERT INTO documents (id, sha256, bytes, mime, orig_name, source, kind, size_preset, width_px, height_px,
                resolution_ok, color_ok, paper_required, received_at, received_on, received_on_source, deadline_on, deadline_mode,
                storage_key, no_ai, status, paper_status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
            )
            .run(
              id, sha256, bytes.length, mime, file.name || null, source, kind, sizePreset, width, height,
              b(resolutionOk), b(colorOk), paperRequired ? 1 : 0, iso, receivedOn, receivedOnSource, dl.deadlineOn, dl.mode,
              stored.key, noAi ? 1 : 0, paperRequired ? 'keep_required' : 'unknown', iso,
            );
          appendAudit(
            deps.db,
            {
              actor: 'user',
              action: 'document.received',
              entity: 'document',
              entityId: id,
              payload: {
                sha256, bytes: bytes.length, mime, kind, size_preset: sizePreset, source,
                received_on: receivedOn, received_on_source: receivedOnSource, deadline_on: dl.deadlineOn, deadline_mode: dl.mode,
                resolution_ok: resolutionOk, color_ok: colorOk, paper_required: paperRequired, forced: force, no_ai: noAi,
              },
            },
            at,
          );
          enqueue(deps.db, 'upload_receipt', id, { now: at });
          // no_ai でも積む（抽出ハンドラが Gemini を呼ばずに needs_review にする）。
          enqueue(deps.db, 'extract', id, { now: at });
        });
      } catch (e) {
        if (e instanceof Error && /UNIQUE constraint failed: documents\.sha256/.test(e.message)) {
          const d = deps.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha256) as { id: string };
          return c.json({ reason: 'duplicate', id: d.id, sha256 }, 409);
        }
        throw e;
      }
      // 起動に失敗しても記録は済んでいる（keihi-worker.timer が 2 分ごとに拾う）。
      try {
        deps.triggerWorker();
      } catch {
        warnings.push('worker_trigger_failed');
      }
      return c.json({ id, sha256, deadline_on: dl.deadlineOn, warnings }, 201);
    },
  );
  return r;
}
