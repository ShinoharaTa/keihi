// 明細のタグ・カテゴリとタグのルールの API（docs/mvp-plan-v3.md T108。src/bank/tags.ts）。
//   POST   /api/bank_txns/:id/tag   body {tag: 'business'|'private'|'unset', category?: string|null（省略は null = 未分類）}
//          → 200 {bank_txn_id, version, tag, category, learned_rule: {rule, created} | null, effective: ResolvedTag} / 400 / 404
//   GET    /api/tag_rules            → 200 {items: [TagRule]}
//   POST   /api/tag_rules            body {account_id?: string|null, pattern, match: 'exact'|'prefix'|'partial', tag, category?}
//          → 201 TagRule（origin=manual）/ 400
//   DELETE /api/tag_rules/:id        → 200 {id, deleted: true} / 404
//   GET    /api/categories           → 200 {items: [{id, label}], uncategorized_label}
// 書き込みは actor=user で監査に残す。
import { Hono, type Context } from 'hono';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  createRule,
  deleteRule,
  listRules,
  resolveTag,
  setTxnTag,
  TagError,
  UNCATEGORIZED_LABEL,
  type Category,
} from '../../bank/tags.ts';
import type { RuleMatch } from '../../bank/tagRepo.ts';
import type { Tag } from '../../bank/repo.ts';
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

function tagError(c: Context, e: unknown) {
  if (e instanceof TagError) return c.json({ error: e.reason }, e.status);
  throw e;
}

export function tagRoutes(deps: Pick<AppDeps, 'db' | 'now'>): Hono {
  const r = new Hono();
  const now = () => (deps.now ?? (() => new Date()))();

  r.post('/bank_txns/:id/tag', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const id = c.req.param('id');
    try {
      const res = setTxnTag(deps.db, {
        txnId: id,
        tag: body.tag as Tag,
        category: (body.category ?? null) as string | null,
        actor: 'user',
        source: 'human',
        user: c.req.header(USER_HEADER) ?? null,
        now: now(),
      });
      return c.json({
        bank_txn_id: id,
        version: res.version.version,
        tag: res.version.tag,
        category: res.version.category,
        learned_rule: res.learned,
        effective: resolveTag(deps.db, id),
      });
    } catch (e) {
      return tagError(c, e);
    }
  });

  r.get('/tag_rules', (c) => c.json({ items: listRules(deps.db) }));

  r.post('/tag_rules', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const accountId = body.account_id ?? null;
    if (accountId !== null && typeof accountId !== 'string') return c.json({ error: 'invalid_account_id' }, 400);
    try {
      const rule = createRule(deps.db, {
        accountId,
        pattern: body.pattern as string,
        match: body.match as RuleMatch,
        tag: body.tag as Tag,
        category: (body.category ?? null) as string | null,
        actor: 'user',
        user: c.req.header(USER_HEADER) ?? null,
        now: now(),
      });
      return c.json(rule, 201);
    } catch (e) {
      return tagError(c, e);
    }
  });

  r.delete('/tag_rules/:id', (c) => {
    const id = c.req.param('id');
    const ok = deleteRule(deps.db, id, { actor: 'user', user: c.req.header(USER_HEADER) ?? null, now: now() });
    return ok ? c.json({ id, deleted: true }) : c.json({ error: 'not_found' }, 404);
  });

  r.get('/categories', (c) =>
    c.json({ items: CATEGORIES.map((id: Category) => ({ id, label: CATEGORY_LABELS[id] })), uncategorized_label: UNCATEGORIZED_LABEL }),
  );

  return r;
}
