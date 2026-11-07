// 税金・保険料の見積もりの API（docs/cashflow.md §14.4、src/cashflow/tax/sync.ts）。認証は app.ts が全ルートの前に差し込む。
//   GET  /api/tax/profile          → 200 {profile（無ければ null）, years: [TaxYear], presets: [{id, label}], missing: [string]}
//   PUT  /api/tax/profile          body はプロファイルの列（知らないキーは 400。無いキーは今の値、プロファイルが無ければ既定値）
//        → 200 {profile, run: RunSummary}（同じトランザクションで再計算する）/ 400 {error}
//   PUT  /api/tax/years/:year      body {kind（新しい年は必須）, revenue?, expenses?, business_income?, social_insurance_paid?,
//        income_tax_final?, consumption_tax_final?, prepaid_income_tax?} → 200 {year, run: RunSummary} / 400 {error}
//   PUT  /api/tax                  body {profile?: プロファイルの部分更新, years?: [{year, ...年の部分更新}]}（どちらも無ければ 400 empty_body）
//        → 200 {profile, years: [TaxYear]（全年）, run: RunSummary}。1 トランザクションで profile → years を保存し、再計算は最後に 1 回
//   POST /api/tax/recalculate      → 200 RunSummary {run_id, created, updated, deactivated, skipped_pinned[], warnings[]}
//   GET  /api/tax/estimates        → 200 最新の再計算の結果 {run_id, created_at, window, items（内訳の行つき）, breakdown, skipped_pinned, warnings}
//        （まだ無ければ run_id: null・items: []）
// 変更はすべて監査ログに残す（actor は user、payload に Tailscale-User-Login。台帳への書き込みは actor = system）。今日は Asia/Tokyo の暦日。
import { Hono, type Context } from 'hono';
import { todayInTokyo } from '../../calendar/businessDays.ts';
import { ScheduleError } from '../../cashflow/schedule.ts';
import { getTaxProfile, listTaxYears } from '../../cashflow/tax/repo.ts';
import {
  TaxError,
  latestEstimates,
  missingInputs,
  parseYear,
  presets,
  profileView,
  recalculate,
  saveAll,
  saveProfile,
  saveYear,
} from '../../cashflow/tax/sync.ts';
import type { AppDeps } from '../app.ts';
import { USER_HEADER } from '../auth.ts';

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

export type TaxRouteDeps = Pick<AppDeps, 'db' | 'now'>;

export function taxRoutes(deps: TaxRouteDeps): Hono {
  const r = new Hono();
  const now = () => (deps.now ?? (() => new Date()))();
  const by = (c: Context) => ({ actor: 'user', user: c.req.header(USER_HEADER) ?? null });
  const fail = (c: Context, e: unknown) => {
    if (e instanceof TaxError || e instanceof ScheduleError) return c.json({ error: e.code }, e.status);
    throw e;
  };

  r.get('/tax/profile', (c) => {
    const p = getTaxProfile(deps.db);
    return c.json({ profile: p && profileView(p), years: listTaxYears(deps.db), presets: presets(), missing: missingInputs(deps.db, todayInTokyo(now())) });
  });

  r.put('/tax/profile', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const t = now();
    try {
      const out = saveProfile(deps.db, body, { by: by(c), today: todayInTokyo(t), now: t });
      return c.json({ profile: profileView(out.profile), run: out.run });
    } catch (e) {
      return fail(c, e);
    }
  });

  r.put('/tax', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const t = now();
    try {
      const out = saveAll(deps.db, body, { by: by(c), today: todayInTokyo(t), now: t });
      return c.json({ profile: out.profile && profileView(out.profile), years: out.years, run: out.run });
    } catch (e) {
      return fail(c, e);
    }
  });

  r.put('/tax/years/:year', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const t = now();
    try {
      return c.json(saveYear(deps.db, parseYear(c.req.param('year')), body, { by: by(c), today: todayInTokyo(t), now: t }));
    } catch (e) {
      return fail(c, e);
    }
  });

  r.post('/tax/recalculate', (c) => {
    const t = now();
    const u = by(c);
    return c.json(recalculate(deps.db, { today: todayInTokyo(t), now: t, actor: u.actor, user: u.user }));
  });

  r.get('/tax/estimates', (c) => {
    return c.json(latestEstimates(deps.db) ?? { run_id: null, created_at: null, items: [], breakdown: [], skipped_pinned: [], warnings: [] });
  });

  return r;
}
