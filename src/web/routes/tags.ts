// 明細のタグ・カテゴリとタグのルールの API（docs/mvp-plan-v3.md T108。src/bank/tags.ts）。
//   POST   /api/bank_txns/:id/tag   body {tag: 'business'|'private'|'unset', category?: string|null（省略は null = 未分類）}
//          → 200 {bank_txn_id, version, tag, category, learned_rule: {rule, action: 'created'|'hit'|'superseded'} | null, effective: ResolvedTag} / 400 / 404
//   POST   /api/bank_txns/bulk_tag  body {ids: string[]（1〜500 件。重複は 1 件に）, tag?, category?: string|null}（tag と category の少なくとも一方。
//          省いた側は明細ごとの今の効く値を引き継ぐ）。全部か無し。今の効く値と同じ明細は書かない。
//          → 200 {batch_id（changed が 0 なら null）, changed, unchanged, learned_rules: [{rule, action}], effective: [{id, tag, category, tag_source}]}
//          / 400 {error: invalid_json|invalid_field|invalid_ids|too_many_ids|nothing_to_set|invalid_tag|invalid_category|category_archived}
//          / 404 {error: not_found, missing: [id（最大 20 件）]}
//   POST   /api/bank_txns/bulk_tag/:batch_id/revert  最新の版がまだその一括の版の明細を一つ前の状態に戻す（後から直した明細は skipped）。
//          → 200 {batch_id, revert_batch_id, reverted, skipped, learned_rule_ids} / 404 {error: not_found}
//          / 409 {error: not_revertible（取り消しの一括）| already_reverted | nothing_to_revert（全部後から直されていて戻せない。何も書かない）}
//   GET    /api/tag_rules            → 200 {items: [TagRule]}
//   POST   /api/tag_rules            body {account_id?: string|null, pattern, match: 'exact'|'prefix'|'partial', tag, category?}
//          → 201 TagRule（origin=manual）/ 400（category が台帳に無い invalid_category・アーカイブ済み category_archived）
//   DELETE /api/tag_rules/:id        → 200 {id, deleted: true} / 404
//   GET    /api/categories           ?all=1 でアーカイブ済みも → 200 {items: [{id, label, color, sort_order, builtin, archived}], uncategorized_label}
//          並びは sort_order → id（src/bank/categories.ts。docs/cashflow.md §5）
//   POST   /api/categories           body {label, color} → 201 {item} / 400 invalid_label|invalid_color|duplicate_label / 409 too_many_categories
//   PATCH  /api/categories/:id       body {label?, color?, sort_order?} → 200 {item} / 400 invalid_field|nothing_to_update|… / 404
//   POST   /api/categories/:id/archive    → 200 {item}（済みならそのまま）/ 400 cannot_archive（other）/ 404
//   POST   /api/categories/:id/unarchive  → 200 {item} / 400 duplicate_label / 409 too_many_categories / 404
//   1 件の上書き・一括・ルールの作成で、アーカイブ済みのカテゴリは 400 category_archived。
// 書き込みは actor=user で監査に残す。
import { Hono, type Context } from 'hono';
import {
  archiveCategory,
  CategoryError,
  createCategory,
  listCategories,
  PATCH_FIELDS,
  toView,
  unarchiveCategory,
  updateCategory,
} from '../../bank/categories.ts';
import {
  BulkNotFoundError,
  bulkSetTxnTags,
  createRule,
  deleteRule,
  listRules,
  resolveTag,
  revertTagBatch,
  setTxnTag,
  TagError,
  UNCATEGORIZED_LABEL,
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

const BULK_FIELDS = new Set(['ids', 'tag', 'category']);
const CATEGORY_CREATE_FIELDS = new Set(['label', 'color']);
const CATEGORY_PATCH_FIELDS = new Set<string>(PATCH_FIELDS);

function tagError(c: Context, e: unknown) {
  if (e instanceof BulkNotFoundError) return c.json({ error: e.reason, missing: e.missing }, e.status);
  if (e instanceof TagError || e instanceof CategoryError) return c.json({ error: e.reason }, e.status);
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

  r.post('/bank_txns/bulk_tag', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    if (Object.keys(body).some((k) => !BULK_FIELDS.has(k))) return c.json({ error: 'invalid_field' }, 400);
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.every((v) => typeof v === 'string')) return c.json({ error: 'invalid_ids' }, 400);
    try {
      return c.json(
        bulkSetTxnTags(deps.db, {
          ids,
          tag: 'tag' in body ? (body.tag as Tag) : undefined,
          category: 'category' in body ? (body.category as string | null) : undefined,
          actor: 'user',
          user: c.req.header(USER_HEADER) ?? null,
          now: now(),
        }),
      );
    } catch (e) {
      return tagError(c, e);
    }
  });

  r.post('/bank_txns/bulk_tag/:batch_id/revert', (c) => {
    try {
      return c.json(revertTagBatch(deps.db, c.req.param('batch_id'), { actor: 'user', user: c.req.header(USER_HEADER) ?? null, now: now() }));
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

  r.get('/categories', (c) => {
    const all = c.req.query('all');
    if (all !== undefined && all !== '0' && all !== '1') return c.json({ error: 'invalid_all' }, 400);
    return c.json({ items: listCategories(deps.db, { all: all === '1' }).map(toView), uncategorized_label: UNCATEGORIZED_LABEL });
  });

  r.post('/categories', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    if (Object.keys(body).some((k) => !CATEGORY_CREATE_FIELDS.has(k))) return c.json({ error: 'invalid_field' }, 400);
    try {
      const row = createCategory(deps.db, { label: body.label, color: body.color, actor: 'user', user: c.req.header(USER_HEADER) ?? null, now: now() });
      return c.json({ item: toView(row) }, 201);
    } catch (e) {
      return tagError(c, e);
    }
  });

  r.patch('/categories/:id', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    if (Object.keys(body).some((k) => !CATEGORY_PATCH_FIELDS.has(k))) return c.json({ error: 'invalid_field' }, 400);
    try {
      const row = updateCategory(deps.db, c.req.param('id'), body, { actor: 'user', user: c.req.header(USER_HEADER) ?? null, now: now() });
      return c.json({ item: toView(row) });
    } catch (e) {
      return tagError(c, e);
    }
  });

  r.post('/categories/:id/archive', (c) => {
    try {
      return c.json({ item: toView(archiveCategory(deps.db, c.req.param('id'), { actor: 'user', user: c.req.header(USER_HEADER) ?? null, now: now() })) });
    } catch (e) {
      return tagError(c, e);
    }
  });

  r.post('/categories/:id/unarchive', (c) => {
    try {
      return c.json({ item: toView(unarchiveCategory(deps.db, c.req.param('id'), { actor: 'user', user: c.req.header(USER_HEADER) ?? null, now: now() })) });
    } catch (e) {
      return tagError(c, e);
    }
  });

  return r;
}
