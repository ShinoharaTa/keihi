// 明細のカテゴリの台帳（bank_categories。0014。docs/cashflow.md §5、requirements-v2.md V10）。
// 固定 13 種（builtin。tags.ts の CATEGORIES が種の定義）+ ユーザー定義（id = c_ + ULID）。削除はしない（archived_at を付けるだけ）。
// - label は前後の空白を落として 1〜LABEL_MAX 字。アーカイブしていないものの中で重複不可（400 duplicate_label）。color は 0〜11（400 invalid_color）。
// - アーカイブしていないカテゴリは MAX_ACTIVE 件まで（作成・戻すで超えるなら 409 too_many_categories）。
// - builtin も label・color・sort_order は変えられる。other だけアーカイブ不可（400 cannot_archive）。
// - アーカイブ済みは新しく付けられない（isAssignableCategory。tags.ts の上書き・一括・ルールの作成で 400 category_archived）。
//   既存の明細・ルールの値としては有効のまま（isCategory。集計・一覧・絞り込み・表示のラベル）。
// - 並びは sort_order → id。新しく作るものは今の最大 + SORT_STEP（アーカイブ済みも含めた最大）。
// 変更は全部監査に残す: bank_category.created / updated（payload.changes に変わった列の from/to）/ archived / unarchived。
import { appendAudit } from '../audit.ts';
import { tx, type Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';

export const LABEL_MAX = 20;
export const COLOR_COUNT = 12;
export const MAX_ACTIVE = 40;
export const SORT_STEP = 10;
// アーカイブできない（未分類の受け皿として残す）。
export const UNARCHIVABLE = 'other';
export const USER_CATEGORY_PREFIX = 'c_';

export type CategoryRow = {
  id: string;
  label: string;
  color: number;
  sort_order: number;
  builtin: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};
// API の形（GET /api/categories の items）。
export type CategoryView = { id: string; label: string; color: number; sort_order: number; builtin: boolean; archived: boolean };

export class CategoryError extends Error {
  readonly status: 400 | 404 | 409;
  readonly reason: string;
  constructor(status: 400 | 404 | 409, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

export function toView(r: CategoryRow): CategoryView {
  return { id: r.id, label: r.label, color: r.color, sort_order: r.sort_order, builtin: r.builtin === 1, archived: r.archived_at !== null };
}

// sort_order → id の順。all = false ならアーカイブ済みを除く。
export function listCategories(db: Db, opts: { all?: boolean } = {}): CategoryRow[] {
  const where = opts.all ? '' : 'WHERE archived_at IS NULL';
  return db.prepare(`SELECT * FROM bank_categories ${where} ORDER BY sort_order, id`).all() as CategoryRow[];
}

export function getCategory(db: Db, id: string): CategoryRow | null {
  return (db.prepare('SELECT * FROM bank_categories WHERE id = ?').get(id) as CategoryRow | undefined) ?? null;
}

// 台帳にある（アーカイブ済みも含む）。明細・ルールの値、一覧の絞り込みで使う。
export function isCategory(db: Db, v: unknown): v is string {
  return typeof v === 'string' && getCategory(db, v) !== null;
}

// 新しく付けられる（台帳にあり、アーカイブしていない）。
export function isAssignableCategory(db: Db, v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const c = getCategory(db, v);
  return c !== null && c.archived_at === null;
}

// 並べる順（sort_order → id）の番号。集計の by_category の並びに使う。
export function categoryOrder(db: Db): Map<string, number> {
  return new Map(listCategories(db, { all: true }).map((c, i) => [c.id, i]));
}

function checkLabel(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  const n = [...t].length;
  if (n < 1 || n > LABEL_MAX) throw new CategoryError(400, 'invalid_label');
  return t;
}

function checkColor(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) >= COLOR_COUNT) throw new CategoryError(400, 'invalid_color');
  return v as number;
}

function checkSortOrder(v: unknown): number {
  if (!Number.isSafeInteger(v)) throw new CategoryError(400, 'invalid_sort_order');
  return v as number;
}

// アーカイブしていないものに同じ label があるか（exceptId は自分）。
function labelTaken(db: Db, label: string, exceptId: string | null): boolean {
  const r = db.prepare('SELECT 1 FROM bank_categories WHERE archived_at IS NULL AND label = ? AND id IS NOT ? LIMIT 1').get(label, exceptId);
  return r !== undefined;
}

function activeCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM bank_categories WHERE archived_at IS NULL').get() as { n: number }).n;
}

type By = { actor: string; user?: string | null; now?: Date };

export function createCategory(db: Db, input: { label: unknown; color: unknown } & By): CategoryRow {
  const label = checkLabel(input.label);
  const color = checkColor(input.color);
  const now = input.now ?? new Date();
  const at = now.toISOString();
  return tx(db, () => {
    if (labelTaken(db, label, null)) throw new CategoryError(400, 'duplicate_label');
    if (activeCount(db) >= MAX_ACTIVE) throw new CategoryError(409, 'too_many_categories');
    const max = (db.prepare('SELECT MAX(sort_order) AS m FROM bank_categories').get() as { m: number | null }).m ?? 0;
    const id = USER_CATEGORY_PREFIX + ulid(now.getTime());
    const sortOrder = max + SORT_STEP;
    db.prepare('INSERT INTO bank_categories (id, label, color, sort_order, builtin, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)').run(
      id,
      label,
      color,
      sortOrder,
      at,
      at,
    );
    appendAudit(
      db,
      { actor: input.actor, action: 'bank_category.created', entity: 'bank_category', entityId: id, payload: { label, color, sort_order: sortOrder, user: input.user ?? null } },
      now,
    );
    return getCategory(db, id)!;
  });
}

export const PATCH_FIELDS = ['label', 'color', 'sort_order'] as const;
export type CategoryPatch = { label?: unknown; color?: unknown; sort_order?: unknown };

// 変わった列だけ書き、監査の payload.changes に from/to。何も変わらなければ書かない（監査も無し）。
export function updateCategory(db: Db, id: string, patch: CategoryPatch, by: By): CategoryRow {
  const next: Partial<Pick<CategoryRow, 'label' | 'color' | 'sort_order'>> = {};
  if (patch.label !== undefined) next.label = checkLabel(patch.label);
  if (patch.color !== undefined) next.color = checkColor(patch.color);
  if (patch.sort_order !== undefined) next.sort_order = checkSortOrder(patch.sort_order);
  if (Object.keys(next).length === 0) throw new CategoryError(400, 'nothing_to_update');
  const now = by.now ?? new Date();
  return tx(db, () => {
    const cur = getCategory(db, id);
    if (!cur) throw new CategoryError(404, 'not_found');
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of PATCH_FIELDS) if (next[k] !== undefined && next[k] !== cur[k]) changes[k] = { from: cur[k], to: next[k] };
    if (Object.keys(changes).length === 0) return cur;
    if (changes.label && cur.archived_at === null && labelTaken(db, next.label!, id)) throw new CategoryError(400, 'duplicate_label');
    const row = { ...cur, ...next };
    db.prepare('UPDATE bank_categories SET label = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(row.label, row.color, row.sort_order, now.toISOString(), id);
    appendAudit(db, { actor: by.actor, action: 'bank_category.updated', entity: 'bank_category', entityId: id, payload: { changes, user: by.user ?? null } }, now);
    return getCategory(db, id)!;
  });
}

// 既にアーカイブ済みなら何も書かずにそのまま返す。
export function archiveCategory(db: Db, id: string, by: By): CategoryRow {
  const now = by.now ?? new Date();
  return tx(db, () => {
    const cur = getCategory(db, id);
    if (!cur) throw new CategoryError(404, 'not_found');
    if (cur.id === UNARCHIVABLE) throw new CategoryError(400, 'cannot_archive');
    if (cur.archived_at !== null) return cur;
    const at = now.toISOString();
    db.prepare('UPDATE bank_categories SET archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
    appendAudit(db, { actor: by.actor, action: 'bank_category.archived', entity: 'bank_category', entityId: id, payload: { label: cur.label, user: by.user ?? null } }, now);
    return getCategory(db, id)!;
  });
}

// 戻す。アーカイブしていなければ何も書かずにそのまま返す。戻すと MAX_ACTIVE を超える・同じ label がアーカイブしていないものにあるなら断る。
export function unarchiveCategory(db: Db, id: string, by: By): CategoryRow {
  const now = by.now ?? new Date();
  return tx(db, () => {
    const cur = getCategory(db, id);
    if (!cur) throw new CategoryError(404, 'not_found');
    if (cur.archived_at === null) return cur;
    if (activeCount(db) >= MAX_ACTIVE) throw new CategoryError(409, 'too_many_categories');
    if (labelTaken(db, cur.label, id)) throw new CategoryError(400, 'duplicate_label');
    db.prepare('UPDATE bank_categories SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now.toISOString(), id);
    appendAudit(db, { actor: by.actor, action: 'bank_category.unarchived', entity: 'bank_category', entityId: id, payload: { label: cur.label, user: by.user ?? null } }, now);
    return getCategory(db, id)!;
  });
}
