// 確認カードと確定（docs/mvp-plan.md T2-7・T2-8、mvp-plan-v0.1.md T2-7・T2-8）。認証の後に置く。
//   GET  /api/documents/:id/card       → 200 {card_id, surface, dataModel}（src/review/card.ts）/ 404
//   GET  /api/documents/:id/thumbnail  → 200 image/jpeg（長辺 640px、メタデータなし）/ 404（文書なし・PDF）
//   POST /api/documents/:id/approve | reject | mark_private | mark_duplicate
//        body {card_id, expected_version, values?}（values は変えた項目だけでよい。U8）
//        → 200 {review_id, version, decision, status, changed, warnings, jobs, learned}
//        → 400 本文の不正 / 404 / 409 版の食い違い・古いカード / 422 値の不正・必須の欠け（R10）
import { Hono } from 'hono';
import { thumbnail } from '../../ai/gemini/derive.ts';
import { openCard } from '../../review/card.ts';
import { decide, ReviewError, type Decision } from '../../review/confirm.ts';
import { readObject } from '../../storage/objects.ts';
import type { AppDeps } from '../app.ts';
import { USER_HEADER } from '../auth.ts';

export const THUMB_MAX_EDGE = 640;
const ACTIONS: Record<string, Decision> = { approve: 'approve', reject: 'reject', mark_private: 'personal', mark_duplicate: 'duplicate' };

export function reviewRoutes(deps: Pick<AppDeps, 'db' | 'objectsDir' | 'config' | 'now'>): Hono {
  const r = new Hono();
  const now = () => (deps.now ? deps.now() : new Date());
  const calendar = () => ({ yearEndHolidays: deps.config.calendar.yearEndHolidays });

  r.get('/documents/:id/card', (c) => {
    const res = openCard(deps.db, c.req.param('id'), { now: now(), calendar: calendar() });
    if (!res) return c.json({ reason: 'not_found' }, 404);
    return c.json({ card_id: res.cardId, surface: res.card.surface, dataModel: res.card.dataModel });
  });

  r.get('/documents/:id/thumbnail', async (c) => {
    const doc = deps.db.prepare('SELECT sha256, mime FROM documents WHERE id = ?').get(c.req.param('id')) as { sha256: string; mime: string } | undefined;
    if (!doc) return c.json({ reason: 'not_found' }, 404);
    if (doc.mime === 'application/pdf') return c.json({ reason: 'no_thumbnail' }, 404);
    let out;
    try {
      out = await thumbnail(await readObject(deps.objectsDir, doc.sha256), THUMB_MAX_EDGE);
    } catch {
      return c.json({ reason: 'thumbnail_failed' }, 500);
    }
    if (out.mime !== 'image/jpeg') return c.json({ reason: 'no_thumbnail' }, 404);
    return c.body(new Uint8Array(out.bytes), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  for (const [action, decision] of Object.entries(ACTIONS)) {
    r.post(`/documents/:id/${action}`, async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ reason: 'invalid_json' }, 400);
      }
      try {
        const res = decide(deps.db, { documentId: c.req.param('id'), decision, body, user: c.req.header(USER_HEADER) ?? null, now: now() });
        return c.json(res);
      } catch (e) {
        if (e instanceof ReviewError) return c.json({ reason: e.reason, ...e.detail }, e.status);
        throw e;
      }
    });
  }
  return r;
}
