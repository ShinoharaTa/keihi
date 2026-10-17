// 対応表のエクスポート（docs/mvp-plan.md T4-7、R13）。
//   GET /api/export/mapping.csv[?year=2026] → 200 text/csv（列は src/deals/export.ts の MAPPING_COLUMNS）/ 400（year が不正）
import { Hono } from 'hono';
import { mappingCsv } from '../../deals/export.ts';
import type { AppDeps } from '../app.ts';

export const EXPORT_PROVIDER = 'freee';

export function exportRoutes(deps: Pick<AppDeps, 'db' | 'now'>): Hono {
  const r = new Hono();
  r.get('/export/mapping.csv', (c) => {
    const y = c.req.query('year');
    if (y !== undefined && !/^\d{4}$/.test(y)) return c.json({ error: 'invalid_year' }, 400);
    const now = (deps.now ?? (() => new Date()))();
    const csv = mappingCsv(deps.db, { provider: EXPORT_PROVIDER, year: y === undefined ? undefined : Number(y), now });
    const name = y === undefined ? 'keihi-mapping.csv' : `keihi-mapping-${y}.csv`;
    return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
  });
  return r;
}
