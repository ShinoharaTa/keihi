// 取り込み API（docs/mvp-plan-v0.1.md T1-6、legal.md R1〜R5）。
//   POST /api/documents  multipart: file, kind, size_preset?, received_on?, no_ai?, force?, source?
//   → 201 {id, sha256, deadline_on, warnings[]} / 409 duplicate / 413 / 415 / 422 {reason}
// - 受信したバイト列をそのまま sha256 → 既にあれば 409（加工しない。R4）。
// - scan の R2（解像度）・R3（カラー）を満たさなければ 422。force=true なら受理し、resolution_ok / color_ok = 0、
//   paper_required = 1、paper_status = keep_required を記録する（スキャナ保存の要件を満たさないので紙原本を残す）。
//   scan の PDF は画素を判定できないので R2・R3 を満たさない扱い（force が無ければ 422）。
// - 受領日はクライアントが送る（撮影日 / 受領日）。無ければ Asia/Tokyo の受信日（R5）。未来日は 422。
// - documents 行 + audit（document.received）+ jobs（upload_receipt、extract。no_ai でも extract は積む）を 1 トランザクションで記録し、
//   コミット後に worker を起動する。本体は src/ingest/document.ts の ingestDocument()（メールの添付の取り込みと共用）。
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { todayInTokyo } from '../../calendar/businessDays.ts';
import { ingestDocument } from '../../ingest/document.ts';
import { SIZE_PRESETS } from '../../ingest/validate.ts';
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
      const res = await ingestDocument(
        deps,
        {
          bytes, origName: file.name || null, kind, sizePreset, receivedOn, receivedOnSource,
          noAi, force, source, actor: 'user',
        },
        now,
      );
      if (!res.ok) return c.json(res.body, res.status);
      const { id, sha256, deadline_on, warnings } = res;
      // 起動に失敗しても記録は済んでいる（keihi-worker.timer が 2 分ごとに拾う）。
      try {
        deps.triggerWorker();
      } catch {
        warnings.push('worker_trigger_failed');
      }
      return c.json({ id, sha256, deadline_on, warnings }, 201);
    },
  );
  return r;
}
