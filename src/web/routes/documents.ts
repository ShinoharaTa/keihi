// GET /api/documents（docs/mvp-plan.md T1-12 の送信済み一覧）。新しい順に最大 50 件。
//   → 200 {items: [{id, received_on, kind, status, deadline_on, paper_required, created_at}]}
// 一覧に要らない列（ファイル名・ハッシュ・保存先）は返さない。
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';

const LIMIT = 50;

export function documentsRoutes(deps: Pick<AppDeps, 'db'>): Hono {
  const r = new Hono();
  r.get('/documents', (c) => {
    const rows = deps.db
      .prepare('SELECT id, received_on, kind, status, deadline_on, paper_required, created_at FROM documents ORDER BY id DESC LIMIT ?')
      .all(LIMIT) as { paper_required: number }[];
    return c.json({ items: rows.map((row) => ({ ...row, paper_required: row.paper_required === 1 })) });
  });
  return r;
}
