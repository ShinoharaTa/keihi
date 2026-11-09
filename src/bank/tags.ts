// 明細の事業/私用タグとカテゴリ（docs/mvp-plan-v3.md T108・V5・V10、requirements-v2.md B3）。
// 効くタグの順: 明細の上書き（txn_tags の最新版）> keihi のルール（tag_rules）> 口座の既定（money_accounts.default_tag）> unset。
//   上書きとみなす版は source が human / agent のものだけ。source=rule の版は上書きにしない（ルールの結果の記録で、人の判断ではない）。
//   ルールの順: 口座のルール > 全口座のルール → exact > prefix > partial → hit_count の多い方 → 新しい方（created_at 降順, id 降順）。
// 人（または agent）が上書きしたら版を追記する。同じ口座・同じ正規化摘要の別々の明細 3 件で、最新の上書きが人の同じ上書き
// （tag と category）なら tag_rules を学習する（origin=learned、match=exact）。agent の上書き・同じ明細の繰り返し・unset は数えない。
// 同じ口座・同じパターンの学習ルールが既にあれば、同じタグなら hit_count を +1、違うタグなら置き換える（2 件目は作らない）。
// 監査ログには摘要（パターン）を入れない（銀行の摘要には個人名が入りうる）。
// ルールのパターンは取引先辞書の正規化（src/vendors/normalize.ts）を通し、明細の description_norm と比べる。
// 一括の上書き（bulkSetTxnTags）は全部か無し。今の効く値と同じ明細は書かず、書いた明細は (口座, 摘要) の組ごとに学習を 1 回だけ試す。
// 一括の取り消し（revertTagBatch）は、最新の版がまだその一括の版の明細だけを一つ前の状態に戻す（上書きが無かったなら cleared の版）。
//   最新の上書きが cleared = 1 の明細は上書き無しとして扱う（tagRepo.ts の latestOverrides・recentHumanOverrides）。学習は取り消さない。
import { createHash } from 'node:crypto';
import { appendAudit } from '../audit.ts';
import { tx, type Db } from '../db/index.ts';
import { normalizeVendor } from '../vendors/normalize.ts';
import { ulid } from '../db/ids.ts';
import { appendTxnTag, getAccount, getBankTxn, latestTxnTag, TAGS, type Tag, type TxnTagRow } from './repo.ts';
import {
  deleteTagRule,
  findLearnedTagRule,
  getTagBatchRevert,
  getTagRule,
  incrementTagRuleHit,
  insertTagBatchRevert,
  insertTagRule,
  isTagRevertBatch,
  latestOverrides,
  learnedRuleIdsForBatch,
  listTagRules,
  previousOverride,
  recentHumanOverrides,
  replaceTagRule,
  RULE_MATCHES,
  tagRulesForAccounts,
  txnsForTag,
  txnTagsInBatch,
  type RuleMatch,
  type TagRuleRow,
} from './tagRepo.ts';

// カテゴリ（V10。固定 13 種 + 未分類 = null）。DB に CHECK は無いので、ここで検証する。
export const CATEGORIES = ['food', 'daily', 'transport', 'telecom', 'housing', 'utilities', 'insurance', 'tax', 'car', 'leisure', 'medical', 'savings', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<Category, string> = {
  food: '食費',
  daily: '日用品',
  transport: '交通',
  telecom: '通信',
  housing: '住居',
  utilities: '水道光熱',
  insurance: '保険',
  tax: '税金',
  car: '車',
  leisure: '娯楽',
  medical: '医療',
  savings: '積立',
  other: 'その他',
};
export const UNCATEGORIZED_LABEL = '未分類';

// 同じ上書きがこの回数続いたらルールを作る。
export const LEARN_THRESHOLD = 3;

export function isTag(v: unknown): v is Tag {
  return (TAGS as readonly unknown[]).includes(v);
}
export function isCategory(v: unknown): v is Category {
  return (CATEGORIES as readonly unknown[]).includes(v);
}
export function isRuleMatch(v: unknown): v is RuleMatch {
  return (RULE_MATCHES as readonly unknown[]).includes(v);
}

export class TagError extends Error {
  readonly status: 400 | 404 | 409;
  readonly reason: string;
  constructor(status: 400 | 404 | 409, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function checkTagAndCategory(tag: unknown, category: unknown): void {
  if (!isTag(tag)) throw new TagError(400, 'invalid_tag');
  if (category !== null && !isCategory(category)) throw new TagError(400, 'invalid_category');
}

export type TagDecisionSource = 'override' | 'rule' | 'account' | 'none';
export type ResolvedTag = { tag: Tag; category: string | null; source: TagDecisionSource; ruleId?: string };

export function ruleMatches(rule: Pick<TagRuleRow, 'pattern' | 'match'>, descriptionNorm: string): boolean {
  switch (rule.match) {
    case 'exact':
      return descriptionNorm === rule.pattern;
    case 'prefix':
      return descriptionNorm.startsWith(rule.pattern);
    case 'partial':
      return descriptionNorm.includes(rule.pattern);
  }
}

const MATCH_RANK: Record<RuleMatch, number> = { exact: 0, prefix: 1, partial: 2 };

// 口座のルール > 全口座のルール → exact > prefix > partial → hit_count の多い方 → 新しい方（created_at 降順, id 降順）。
export function compareRules(a: TagRuleRow, b: TagRuleRow): number {
  const sa = a.account_id === null ? 1 : 0;
  const sb = b.account_id === null ? 1 : 0;
  if (sa !== sb) return sa - sb;
  if (a.match !== b.match) return MATCH_RANK[a.match] - MATCH_RANK[b.match];
  if (a.hit_count !== b.hit_count) return b.hit_count - a.hit_count;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// 明細ごとの効くタグ。無い明細は結果に入らない。クエリは件数によらず 3 本。
export function resolveTagsBulk(db: Db, txnIds: readonly string[]): Map<string, ResolvedTag> {
  const out = new Map<string, ResolvedTag>();
  if (txnIds.length === 0) return out;
  const txns = txnsForTag(db, txnIds);
  const overrides = new Map(latestOverrides(db, txnIds).map((r) => [r.bank_txn_id, r]));
  const rules = tagRulesForAccounts(db, [...new Set(txns.map((t) => t.account_id))]).sort(compareRules);
  for (const t of txns) {
    const o = overrides.get(t.id);
    if (o) {
      out.set(t.id, { tag: o.tag, category: o.category, source: 'override' });
      continue;
    }
    const rule = rules.find((r) => (r.account_id === null || r.account_id === t.account_id) && ruleMatches(r, t.description_norm));
    if (rule) {
      out.set(t.id, { tag: rule.tag, category: rule.category, source: 'rule', ruleId: rule.id });
      continue;
    }
    if (t.default_tag !== 'unset') out.set(t.id, { tag: t.default_tag, category: null, source: 'account' });
    else out.set(t.id, { tag: 'unset', category: null, source: 'none' });
  }
  return out;
}

export function resolveTag(db: Db, txnId: string): ResolvedTag | null {
  return resolveTagsBulk(db, [txnId]).get(txnId) ?? null;
}

export type SetTxnTagInput = {
  txnId: string;
  tag: Tag;
  category?: string | null;
  actor: string;
  source: 'human' | 'agent';
  user?: string | null;
  now?: Date;
};

export type LearnedRule = { rule: TagRuleRow; action: 'created' | 'hit' | 'superseded' };
export type SetTxnTagResult = { version: TxnTagRow; learned: LearnedRule | null };

// 上書きの版を追記し、監査に残す。人の上書きなら学習を試す。
export function setTxnTag(db: Db, input: SetTxnTagInput): SetTxnTagResult {
  const category = input.category ?? null;
  checkTagAndCategory(input.tag, category);
  const now = input.now ?? new Date();
  return tx(db, () => {
    const txn = getBankTxn(db, input.txnId);
    if (!txn) throw new TagError(404, 'not_found');
    const version = appendTagVersion(db, { txnId: txn.id, tag: input.tag, category, source: input.source, actor: input.actor, user: input.user ?? null, now });
    const learned = input.source === 'human' ? learn(db, txn.account_id, txn.description_norm, input.tag, category, input.actor, now) : null;
    return { version, learned };
  });
}

// 版を追記し、監査 bank_txn.tag_set に残す。batchId は payload の batch_id に、extra（revert_of・cleared）はそのまま payload に足す。
function appendTagVersion(
  db: Db,
  v: {
    txnId: string;
    tag: Tag;
    category: string | null;
    source: 'human' | 'agent';
    actor: string;
    user: string | null;
    now: Date;
    batchId?: string;
    cleared?: boolean;
    extra?: Record<string, unknown>;
  },
): TxnTagRow {
  const prev = latestTxnTag(db, v.txnId);
  const version = appendTxnTag(db, {
    bankTxnId: v.txnId,
    tag: v.tag,
    category: v.category,
    source: v.source,
    actor: v.actor,
    decidedAt: v.now.toISOString(),
    batchId: v.batchId ?? null,
    cleared: v.cleared,
  });
  appendAudit(
    db,
    {
      actor: v.actor,
      action: 'bank_txn.tag_set',
      entity: 'bank_txn',
      entityId: v.txnId,
      payload: {
        version: version.version,
        tag: version.tag,
        category: version.category,
        source: v.source,
        from: prev ? { version: prev.version, tag: prev.tag, category: prev.category } : null,
        user: v.user,
        ...(v.batchId !== undefined ? { batch_id: v.batchId } : {}),
        ...v.extra,
      },
    },
    v.now,
  );
  return version;
}

// batchId は一括の上書きで学習したとき。tag_rule.* の監査の payload に batch_id として足す。
function learn(
  db: Db,
  accountId: string,
  descriptionNorm: string,
  tag: Tag,
  category: string | null,
  actor: string,
  now: Date,
  batchId?: string,
): LearnedRule | null {
  if (descriptionNorm === '' || tag === 'unset') return null;
  const recent = recentHumanOverrides(db, accountId, descriptionNorm, LEARN_THRESHOLD);
  if (recent.length < LEARN_THRESHOLD || !recent.every((r) => r.tag === tag && r.category === category)) return null;
  const at = now.toISOString();
  const b = batchId !== undefined ? { batch_id: batchId } : {};
  const cur = findLearnedTagRule(db, accountId, descriptionNorm);
  if (cur && cur.tag === tag && cur.category === category) {
    const rule = incrementTagRuleHit(db, cur.id, at)!;
    appendAudit(db, { actor, action: 'tag_rule.hit', entity: 'tag_rule', entityId: rule.id, payload: { ...ruleAuditPayload(rule), hit_count: rule.hit_count, ...b } }, now);
    return { rule, action: 'hit' };
  }
  if (cur) {
    const rule = replaceTagRule(db, cur.id, { tag, category, now: at })!;
    appendAudit(
      db,
      { actor, action: 'tag_rule.superseded', entity: 'tag_rule', entityId: rule.id, payload: { ...ruleAuditPayload(rule), from: { tag: cur.tag, category: cur.category }, ...b } },
      now,
    );
    return { rule, action: 'superseded' };
  }
  const rule = insertTagRule(db, { accountId, pattern: descriptionNorm, match: 'exact', tag, category, origin: 'learned', now: at });
  appendAudit(db, { actor, action: 'tag_rule.learned', entity: 'tag_rule', entityId: rule.id, payload: { ...ruleAuditPayload(rule), ...b } }, now);
  return { rule, action: 'created' };
}

// ---- 一括の上書きと取り消し ----

// 一括で指定できる明細の数の上限（重複を除いた後）。
export const BULK_MAX = 500;
// 404 の missing に入れる ID の数の上限。
const MISSING_MAX = 20;

export type BulkSetTxnTagsInput = {
  ids: readonly string[];
  // 省いた側（undefined）は明細ごとの今の効く値を引き継ぐ。category の null は未分類。
  tag?: Tag;
  category?: string | null;
  actor: string;
  user?: string | null;
  now?: Date;
};
export type EffectiveTag = { id: string; tag: Tag; category: string | null; tag_source: TagDecisionSource };
export type BulkSetTxnTagsResult = { batch_id: string | null; changed: number; unchanged: number; learned_rules: LearnedRule[]; effective: EffectiveTag[] };

// 見つからない明細があった（404）。missing は最大 MISSING_MAX 件。
export class BulkNotFoundError extends TagError {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(404, 'not_found');
    this.missing = missing;
  }
}

// ids は呼ぶ側で文字列の配列であることを確かめておく。重複は 1 件にまとめる。検証は書く前に全部（全部か無し）。
export function bulkSetTxnTags(db: Db, input: BulkSetTxnTagsInput): BulkSetTxnTagsResult {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) throw new TagError(400, 'invalid_ids');
  if (ids.length > BULK_MAX) throw new TagError(400, 'too_many_ids');
  if (input.tag === undefined && input.category === undefined) throw new TagError(400, 'nothing_to_set');
  if (input.tag !== undefined && !isTag(input.tag)) throw new TagError(400, 'invalid_tag');
  if (input.category !== undefined && input.category !== null && !isCategory(input.category)) throw new TagError(400, 'invalid_category');
  const now = input.now ?? new Date();
  const user = input.user ?? null;
  return tx(db, () => {
    const txns = new Map(txnsForTag(db, ids).map((t) => [t.id, t]));
    const missing = ids.filter((id) => !txns.has(id));
    if (missing.length) throw new BulkNotFoundError(missing.slice(0, MISSING_MAX));
    const current = resolveTagsBulk(db, ids);
    const batchId = ulid();
    const written: { accountId: string; descriptionNorm: string; tag: Tag; category: string | null }[] = [];
    for (const id of ids) {
      const cur = current.get(id)!;
      const tag = input.tag ?? cur.tag;
      const category = input.category !== undefined ? input.category : cur.category;
      if (tag === cur.tag && category === cur.category) continue;
      appendTagVersion(db, { txnId: id, tag, category, source: 'human', actor: input.actor, user, now, batchId });
      const t = txns.get(id)!;
      written.push({ accountId: t.account_id, descriptionNorm: t.description_norm, tag, category });
    }
    const changed = written.length;
    const learned: LearnedRule[] = [];
    if (changed > 0) {
      // (口座, 摘要) の組ごとに 1 回だけ。組の中で値が違っても、learn が最新 3 件で判定する（組の最後に書いた値で試す）。
      const groups = new Map<string, (typeof written)[number]>();
      for (const w of written) groups.set(JSON.stringify([w.accountId, w.descriptionNorm]), w);
      for (const g of groups.values()) {
        const l = learn(db, g.accountId, g.descriptionNorm, g.tag, g.category, input.actor, now, batchId);
        if (l) learned.push(l);
      }
      const set: Record<string, unknown> = {};
      if (input.tag !== undefined) set.tag = input.tag;
      if (input.category !== undefined) set.category = input.category;
      appendAudit(
        db,
        {
          actor: input.actor,
          action: 'bank_txn.bulk_tag_set',
          entity: 'bank_txn_batch',
          entityId: batchId,
          payload: { count: ids.length, changed, unchanged: ids.length - changed, set, user },
        },
        now,
      );
    }
    const after = resolveTagsBulk(db, ids);
    return {
      batch_id: changed > 0 ? batchId : null,
      changed,
      unchanged: ids.length - changed,
      learned_rules: learned,
      effective: ids.map((id) => {
        const e = after.get(id)!;
        return { id, tag: e.tag, category: e.category, tag_source: e.source };
      }),
    };
  });
}

export type RevertTagBatchResult = { batch_id: string; revert_batch_id: string; reverted: number; skipped: number; learned_rule_ids: string[] };

// 一括で書いた明細のうち、最新の版がまだその一括の版のものを一つ前の状態に戻す。後から別の版が足された明細は skipped。
// 一つ前に上書き（human / agent、cleared でない）があればその tag・category・source の版（agent の値を人の上書きとして学習に数えない）、
// 無ければ「上書きを外す」版（cleared = 1、source = human。cleared の版は学習の材料にならない）。
// 戻せる明細が 1 件も無い（全部 skipped）なら 409 nothing_to_revert で、何も書かない。
// 学習は取り消さない（その一括で作られたルールのうち今もあるものの ID を返す）。
export function revertTagBatch(db: Db, batchId: string, by: { actor: string; user?: string | null; now?: Date }): RevertTagBatchResult {
  const now = by.now ?? new Date();
  const user = by.user ?? null;
  return tx(db, () => {
    if (isTagRevertBatch(db, batchId)) throw new TagError(409, 'not_revertible');
    const rows = txnTagsInBatch(db, batchId);
    if (rows.length === 0) throw new TagError(404, 'not_found');
    if (getTagBatchRevert(db, batchId)) throw new TagError(409, 'already_reverted');
    const revertBatchId = ulid();
    let reverted = 0;
    for (const row of rows) {
      if (latestTxnTag(db, row.bank_txn_id)!.version !== row.version) continue;
      const prev = previousOverride(db, row.bank_txn_id, row.version);
      const base = { txnId: row.bank_txn_id, actor: by.actor, user, now, batchId: revertBatchId };
      if (prev && prev.cleared === 0) {
        // previousOverride は source が human / agent の版だけを返す。
        const source = prev.source as 'human' | 'agent';
        appendTagVersion(db, { ...base, source, tag: prev.tag, category: prev.category, extra: { revert_of: batchId } });
      } else appendTagVersion(db, { ...base, source: 'human', tag: 'unset', category: null, cleared: true, extra: { revert_of: batchId, cleared: true } });
      reverted++;
    }
    if (reverted === 0) throw new TagError(409, 'nothing_to_revert');
    const skipped = rows.length - reverted;
    insertTagBatchRevert(db, { batchId, revertBatchId, now: now.toISOString() });
    appendAudit(
      db,
      {
        actor: by.actor,
        action: 'bank_txn.bulk_tag_reverted',
        entity: 'bank_txn_batch',
        entityId: batchId,
        payload: { batch_id: batchId, revert_batch_id: revertBatchId, reverted, skipped, user },
      },
      now,
    );
    return { batch_id: batchId, revert_batch_id: revertBatchId, reverted, skipped, learned_rule_ids: learnedRuleIdsForBatch(db, batchId) };
  });
}

// 監査に残すルールの中身。パターン（摘要）は入れない。
function ruleAuditPayload(r: TagRuleRow): Record<string, unknown> {
  return { account_id: r.account_id, match: r.match, tag: r.tag, category: r.category, origin: r.origin };
}

// 消したルールのパターンの代わりに残す、sha256 の先頭 16 桁。
export function patternDigest(pattern: string): string {
  return createHash('sha256').update(pattern).digest('hex').slice(0, 16);
}

// ---- ルールの手動管理 ----

export function listRules(db: Db): TagRuleRow[] {
  return listTagRules(db);
}

export type CreateRuleInput = {
  accountId?: string | null;
  pattern: string;
  match: RuleMatch;
  tag: Tag;
  category?: string | null;
  actor: string;
  user?: string | null;
  now?: Date;
};

// 手で作るルール（origin=manual）。パターンは明細の description_norm と同じ正規化を通す。
export function createRule(db: Db, input: CreateRuleInput): TagRuleRow {
  const category = input.category ?? null;
  checkTagAndCategory(input.tag, category);
  if (!isRuleMatch(input.match)) throw new TagError(400, 'invalid_match');
  if (typeof input.pattern !== 'string') throw new TagError(400, 'invalid_pattern');
  const pattern = normalizeVendor(input.pattern);
  if (pattern === '') throw new TagError(400, 'invalid_pattern');
  const accountId = input.accountId ?? null;
  const now = input.now ?? new Date();
  return tx(db, () => {
    if (accountId !== null && !getAccount(db, accountId)) throw new TagError(400, 'unknown_account');
    const rule = insertTagRule(db, { accountId, pattern, match: input.match, tag: input.tag, category, origin: 'manual', now: now.toISOString() });
    appendAudit(db, { actor: input.actor, action: 'tag_rule.created', entity: 'tag_rule', entityId: rule.id, payload: { ...ruleAuditPayload(rule), user: input.user ?? null } }, now);
    return rule;
  });
}

// 消したルールの中身は監査に残す（パターンは sha256 の先頭 16 桁だけ）。無ければ false。
export function deleteRule(db: Db, id: string, by: { actor: string; user?: string | null; now?: Date }): boolean {
  const now = by.now ?? new Date();
  return tx(db, () => {
    const rule = getTagRule(db, id);
    if (!rule) return false;
    deleteTagRule(db, id);
    appendAudit(db, { actor: by.actor, action: 'tag_rule.deleted', entity: 'tag_rule', entityId: id, payload: { ...ruleAuditPayload(rule), pattern_sha256_16: patternDigest(rule.pattern), user: by.user ?? null } }, now);
    return true;
  });
}
