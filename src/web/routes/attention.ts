// 要対応 API（docs/mvp-plan.md T4-5）と紙原本の廃棄（T4-6）。PWA 側は別担当。
//   GET  /api/attention               → 200 {total, groups: [{reason, items: [{id, document_id, state, reason, detail, attention_at, remote_deal_id, last_error}]}]}
//        対象は送信（deals）の needs_attention で、人がまだ対応済みにしていないもの。理由ごとに、古い順。
//   POST /api/attention/:id/resolve   body {note?: string（500 字まで）} → 200 {id, resolved_at} / 404 / 409（要対応でない・対応済み）
//        人が freee 側などで対応したことを記録する（監査ログ）。状態は needs_attention のまま（照合でも上書きしない）。
//   POST /api/documents/:id/paper     body {status: 'discarded'} → 200 {id, paper_status: 'discarded'} / 404 / 409 {paper_status, reasons}
//        廃棄可（discard_ok）のときだけ「廃棄済」にできる（監査ログ）。
import { Hono } from 'hono';
import { appendAudit } from '../../audit.ts';
import { tx } from '../../db/index.ts';
import { markPaperDiscarded } from '../../deals/paper.ts';
import type { AppDeps } from '../app.ts';
import { USER_HEADER } from '../auth.ts';

const NOTE_MAX = 500;

type Row = {
  id: string;
  document_id: string;
  state: string;
  attention_reason: string | null;
  attention_detail_json: string | null;
  attention_at: string | null;
  attention_resolved_at: string | null;
  remote_deal_id: string | null;
  last_error: string | null;
};

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text === '') return {};
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function attentionRoutes(deps: Pick<AppDeps, 'db' | 'now'>): Hono {
  const r = new Hono();
  const now = () => (deps.now ?? (() => new Date()))();

  r.get('/attention', (c) => {
    const rows = deps.db
      .prepare(
        `SELECT id, document_id, state, attention_reason, attention_detail_json, attention_at, attention_resolved_at, remote_deal_id, last_error
         FROM deals WHERE state = 'needs_attention' AND attention_resolved_at IS NULL ORDER BY attention_at, id`,
      )
      .all() as Row[];
    const groups = new Map<string, unknown[]>();
    for (const row of rows) {
      const reason = row.attention_reason ?? 'unknown';
      if (!groups.has(reason)) groups.set(reason, []);
      groups.get(reason)!.push({
        id: row.id,
        document_id: row.document_id,
        state: row.state,
        reason,
        detail: row.attention_detail_json ? JSON.parse(row.attention_detail_json) : {},
        attention_at: row.attention_at,
        remote_deal_id: row.remote_deal_id,
        last_error: row.last_error,
      });
    }
    return c.json({ total: rows.length, groups: [...groups].map(([reason, items]) => ({ reason, items })) });
  });

  r.post('/attention/:id/resolve', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const note = body.note ?? null;
    if (note !== null && (typeof note !== 'string' || note.length > NOTE_MAX)) return c.json({ error: 'invalid_note' }, 400);
    const id = c.req.param('id');
    const at = now();
    const res = tx(deps.db, () => {
      const row = deps.db.prepare('SELECT id, document_id, state, attention_reason, attention_resolved_at FROM deals WHERE id = ?').get(id) as Row | undefined;
      if (!row) return 404 as const;
      if (row.state !== 'needs_attention' || row.attention_resolved_at !== null) return 409 as const;
      deps.db.prepare('UPDATE deals SET attention_resolved_at = ?, updated_at = ? WHERE id = ?').run(at.toISOString(), at.toISOString(), id);
      appendAudit(
        deps.db,
        { actor: 'user', action: 'deal.attention_resolved', entity: 'deal', entityId: id, payload: { document_id: row.document_id, reason: row.attention_reason, note, user: c.req.header(USER_HEADER) ?? null } },
        at,
      );
      return 200 as const;
    });
    if (res === 404) return c.json({ error: 'not_found' }, 404);
    if (res === 409) return c.json({ error: 'not_needs_attention' }, 409);
    return c.json({ id, resolved_at: at.toISOString() });
  });

  r.post('/documents/:id/paper', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body || body.status !== 'discarded') return c.json({ error: 'invalid_status' }, 400);
    const id = c.req.param('id');
    const res = markPaperDiscarded(deps.db, id, { actor: 'user', user: c.req.header(USER_HEADER) ?? null }, now());
    if (res.ok) return c.json({ id, paper_status: 'discarded' });
    if (res.status === null) return c.json({ error: 'not_found' }, 404);
    return c.json({ error: 'not_discard_ok', paper_status: res.status, reasons: res.reasons }, 409);
  });

  return r;
}
