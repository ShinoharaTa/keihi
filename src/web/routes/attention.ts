// 要対応 API（docs/mvp-plan.md T4-5）と紙原本の廃棄（T4-6）。文書（document_id）単位（src/review/attention.ts）。
//   GET  /api/attention               → 200 {total, items: [Attention], groups: [{reason, items: [Attention]}]}
//        needs_attention の文書のうち、人がまだ dismiss していないもの。古い順。Attention は
//        {document_id, status, received_on, deadline_on, source, reason, kind, document_reason, deal_reason, deal_id, attention_at, detail, dismissed, actions}
//   POST /api/documents/:id/attention/resolve   body {action?: 'retry' | 'dismiss'（既定 retry）, note?: string（500 字まで）}
//        → 200 {document_id, action, reason, status, job, resolved_at} / 400 / 404 / 409 {error, hint?}（要対応でない・dismiss 済み・自動で直せない理由の retry・
//          freee に取引がある送信の要対応の retry）
//        retry は理由に応じたジョブを積み直して状態を戻す。dismiss は対応済みの記録だけ（状態は needs_attention のまま）。
//   POST /api/attention/:id/resolve   （互換。:id は deals.id）deals 行の document_id で上と同じ処理。応答に id（deals.id）も入れる。
//   POST /api/documents/:id/paper     body {status: 'discarded'} → 200 {id, paper_status: 'discarded'} / 404 / 409 {paper_status, reasons}
//        廃棄可（discard_ok）のときだけ「廃棄済」にできる（監査ログ）。
import { Hono, type Context } from 'hono';
import { markPaperDiscarded } from '../../deals/paper.ts';
import { ATTENTION_ACTIONS, AttentionError, listAttention, resolveAttention, type Attention, type AttentionAction } from '../../review/attention.ts';
import type { AppDeps } from '../app.ts';
import { USER_HEADER } from '../auth.ts';

const NOTE_MAX = 500;

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

export function attentionRoutes(deps: Pick<AppDeps, 'db' | 'now' | 'triggerWorker'>): Hono {
  const r = new Hono();
  const now = () => (deps.now ?? (() => new Date()))();

  r.get('/attention', (c) => {
    const items = listAttention(deps.db);
    const groups = new Map<string, Attention[]>();
    for (const it of items) {
      if (!groups.has(it.reason)) groups.set(it.reason, []);
      groups.get(it.reason)!.push(it);
    }
    return c.json({ total: items.length, items, groups: [...groups].map(([reason, xs]) => ({ reason, items: xs })) });
  });

  const resolve = async (c: Context, documentId: string, extra: Record<string, unknown> = {}) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const note = body.note ?? null;
    if (note !== null && (typeof note !== 'string' || note.length > NOTE_MAX)) return c.json({ error: 'invalid_note' }, 400);
    const action = body.action ?? 'retry';
    if (!(ATTENTION_ACTIONS as readonly unknown[]).includes(action)) return c.json({ error: 'invalid_action' }, 400);
    try {
      const res = resolveAttention(deps.db, documentId, { action: action as AttentionAction, note: note as string | null, user: c.req.header(USER_HEADER) ?? null, now: now() });
      if (res.action === 'retry') deps.triggerWorker();
      return c.json({ ...extra, ...res });
    } catch (e) {
      if (e instanceof AttentionError) return c.json(e.hint ? { error: e.reason, hint: e.hint } : { error: e.reason }, e.status);
      throw e;
    }
  };

  r.post('/documents/:id/attention/resolve', (c) => resolve(c, c.req.param('id')));

  r.post('/attention/:id/resolve', (c) => {
    const id = c.req.param('id');
    const deal = deps.db.prepare('SELECT document_id FROM deals WHERE id = ?').get(id) as { document_id: string } | undefined;
    if (!deal) return c.json({ error: 'not_found' }, 404);
    return resolve(c, deal.document_id, { id });
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
