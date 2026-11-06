// 予定の台帳の API（docs/mvp-plan-v3.md T301。src/cashflow/schedule.ts）。認証は app.ts が全ルートの前に差し込む。
//   GET  /api/scheduled_items?all=1            → 200 {items: [ScheduledItem]}（all=1 で止めた項目も含める。既定は active だけ）
//   POST /api/scheduled_items                  body {name, amount, direction, category, recurrence, anchor_date,
//        account_id?, end_date?, notify_days_before?（既定 14）, origin?（既定 manual）} → 201 ScheduledItem / 400 {error}
//   PATCH /api/scheduled_items/:id             body は上の部分（origin は変えられない）→ 200 ScheduledItem / 400 / 404
//   POST /api/scheduled_items/:id/deactivate   → 200 ScheduledItem（active = 0。既に止めてあればそのまま）/ 404
//   POST /api/scheduled_items/:id/activate     → 200 ScheduledItem（active = 1 に戻す。既に有効ならそのまま）/ 404
//   GET  /api/scheduled_items/upcoming?days=30 → 200 {from, to, items: [ScheduledItem & {due_date}]}
//        範囲は今日〜今日 + days 日で、両端を含む（今日は Asia/Tokyo の暦日）。期日順に並べる。days は 1〜UPCOMING_MAX_DAYS の整数。
// 周期の検出の候補（T302。src/cashflow/detect.ts）:
//   GET  /api/recurrence_candidates?state=open        → 200 {candidates: [RecurrenceCandidate]}（state を省くとすべて）/ 400 {error}
//   POST /api/recurrence_candidates/detect            → 200 {created, updated}（手動で検出する。今日は Asia/Tokyo の暦日）
//   POST /api/recurrence_candidates/:id/accept        body {category?（既定 other）, name?（既定 正規化摘要）}
//        → 200 {candidate, item}（台帳の項目を作って accepted にする）/ 400 {error}（open でない・値が不正）/ 404
//   POST /api/recurrence_candidates/:id/dismiss       → 200 RecurrenceCandidate（既に dismissed ならそのまま）/ 400（accepted）/ 404
// 変更はすべて監査ログに残す（actor は user、payload に Tailscale-User-Login）。
import { Hono, type Context } from 'hono';
import { todayInTokyo } from '../../calendar/businessDays.ts';
import { ScheduleError, activateItem, createItem, deactivateItem, listItems, parseBody, updateItem, upcoming, type ItemInput } from '../../cashflow/schedule.ts';
import { acceptCandidate, detectRecurrences, dismissCandidate, type AcceptOverrides } from '../../cashflow/detect.ts';
import { CANDIDATE_STATES, listRecurrenceCandidates, type CandidateState } from '../../cashflow/repo.ts';
import type { AppDeps } from '../app.ts';
import { USER_HEADER } from '../auth.ts';

export const UPCOMING_DEFAULT_DAYS = 30;
export const UPCOMING_MAX_DAYS = 1096;

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

export function cashflowRoutes(deps: Pick<AppDeps, 'db' | 'now'>): Hono {
  const r = new Hono();
  const now = () => (deps.now ?? (() => new Date()))();
  const by = (c: Context) => ({ actor: 'user', user: c.req.header(USER_HEADER) ?? null });
  const fail = (c: Context, e: unknown) => {
    if (e instanceof ScheduleError) return c.json({ error: e.code }, e.status);
    throw e;
  };

  r.get('/scheduled_items', (c) => {
    const all = c.req.query('all');
    if (all !== undefined && all !== '0' && all !== '1') return c.json({ error: 'invalid_all' }, 400);
    return c.json({ items: listItems(deps.db, { includeInactive: all === '1' }) });
  });

  r.get('/scheduled_items/upcoming', (c) => {
    const q = c.req.query('days');
    const days = q === undefined ? UPCOMING_DEFAULT_DAYS : /^\d+$/.test(q) ? Number(q) : NaN;
    if (!Number.isSafeInteger(days) || days < 1 || days > UPCOMING_MAX_DAYS) return c.json({ error: 'invalid_days' }, 400);
    return c.json(upcoming(deps.db, todayInTokyo(now()), days));
  });

  r.post('/scheduled_items', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    try {
      return c.json(createItem(deps.db, parseBody(body, 'create') as ItemInput, by(c), now()), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  r.patch('/scheduled_items/:id', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    try {
      return c.json(updateItem(deps.db, c.req.param('id'), parseBody(body, 'update'), by(c), now()));
    } catch (e) {
      return fail(c, e);
    }
  });

  r.post('/scheduled_items/:id/deactivate', (c) => {
    try {
      return c.json(deactivateItem(deps.db, c.req.param('id'), by(c), now()));
    } catch (e) {
      return fail(c, e);
    }
  });

  r.post('/scheduled_items/:id/activate', (c) => {
    try {
      return c.json(activateItem(deps.db, c.req.param('id'), by(c), now()));
    } catch (e) {
      return fail(c, e);
    }
  });

  r.get('/recurrence_candidates', (c) => {
    const state = c.req.query('state');
    if (state !== undefined && !(CANDIDATE_STATES as readonly string[]).includes(state)) return c.json({ error: 'invalid_state' }, 400);
    return c.json({ candidates: listRecurrenceCandidates(deps.db, { state: state as CandidateState | undefined }) });
  });

  r.post('/recurrence_candidates/detect', (c) => {
    const t = now();
    return c.json(detectRecurrences(deps.db, { today: todayInTokyo(t), now: t }));
  });

  r.post('/recurrence_candidates/:id/accept', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    if (Object.keys(body).some((k) => k !== 'category' && k !== 'name')) return c.json({ error: 'invalid_field' }, 400);
    try {
      // 値は createItem が確かめる（name は前後の空白を落とす、category は種類と direction=out との組み合わせ）。
      return c.json(acceptCandidate(deps.db, c.req.param('id'), by(c), body as AcceptOverrides, now()));
    } catch (e) {
      return fail(c, e);
    }
  });

  r.post('/recurrence_candidates/:id/dismiss', (c) => {
    try {
      return c.json(dismissCandidate(deps.db, c.req.param('id'), by(c), now()));
    } catch (e) {
      return fail(c, e);
    }
  });

  return r;
}
