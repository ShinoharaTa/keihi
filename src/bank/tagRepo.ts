// タグとタグのルールの表への読み書き（docs/mvp-plan-v3.md T108、0005_bank.sql の txn_tags・tag_rules）。SQL はここに閉じ込める。
// 効くタグの決定と学習は src/bank/tags.ts。監査ログは呼ぶ側が同じトランザクションで残す。
import type { Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';
import type { Tag, TagSource, TxnTagRow } from './repo.ts';

export const RULE_MATCHES = ['exact', 'prefix', 'partial'] as const;
export type RuleMatch = (typeof RULE_MATCHES)[number];
export type RuleOrigin = 'learned' | 'manual';

export type TagRuleRow = {
  id: string;
  account_id: string | null;
  pattern: string;
  match: RuleMatch;
  tag: Tag;
  category: string | null;
  origin: RuleOrigin;
  hit_count: number;
  created_at: string;
  updated_at: string;
};

// タグを決めるのに要る明細の列と、口座の既定タグ。
export type TxnForTag = { id: string; account_id: string; description_norm: string; default_tag: Tag };

// ids は JSON の配列 1 つで渡す（明細が多くても SQL の引数の上限に当たらない）。
export function txnsForTag(db: Db, ids: readonly string[]): TxnForTag[] {
  return db
    .prepare(
      `SELECT t.id, t.account_id, t.description_norm, a.default_tag FROM bank_txns t JOIN money_accounts a ON a.id = t.account_id
       WHERE t.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as TxnForTag[];
}

// 明細ごとの最新版（version 最大）。
export function latestTxnTags(db: Db, ids: readonly string[]): TxnTagRow[] {
  return db
    .prepare(
      `SELECT g.* FROM txn_tags g
       JOIN (SELECT bank_txn_id, max(version) AS v FROM txn_tags WHERE bank_txn_id IN (SELECT value FROM json_each(?)) GROUP BY bank_txn_id) m
         ON m.bank_txn_id = g.bank_txn_id AND m.v = g.version`,
    )
    .all(JSON.stringify(ids)) as TxnTagRow[];
}

// 同じ口座・同じ正規化摘要の明細への上書き（human / agent）を新しい順に limit 件。追記した順（rowid）で並べる。
export function recentOverrides(
  db: Db,
  accountId: string,
  descriptionNorm: string,
  limit: number,
): { bank_txn_id: string; tag: Tag; category: string | null; source: TagSource }[] {
  return db
    .prepare(
      `SELECT g.bank_txn_id, g.tag, g.category, g.source FROM txn_tags g JOIN bank_txns t ON t.id = g.bank_txn_id
       WHERE t.account_id = ? AND t.description_norm = ? AND g.source IN ('human', 'agent')
       ORDER BY g.rowid DESC LIMIT ?`,
    )
    .all(accountId, descriptionNorm, limit) as { bank_txn_id: string; tag: Tag; category: string | null; source: TagSource }[];
}

// ---- tag_rules ----

export function listTagRules(db: Db): TagRuleRow[] {
  return db.prepare('SELECT * FROM tag_rules ORDER BY created_at, id').all() as TagRuleRow[];
}

// 口座のルールと全口座のルール。
export function tagRulesForAccounts(db: Db, accountIds: readonly string[]): TagRuleRow[] {
  return db
    .prepare('SELECT * FROM tag_rules WHERE account_id IS NULL OR account_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(accountIds)) as TagRuleRow[];
}

export function getTagRule(db: Db, id: string): TagRuleRow | null {
  return (db.prepare('SELECT * FROM tag_rules WHERE id = ?').get(id) as TagRuleRow | undefined) ?? null;
}

// 口座・パターン・照合のしかた・タグ・カテゴリが全部同じルール。
export function findSameTagRule(
  db: Db,
  r: { accountId: string | null; pattern: string; match: RuleMatch; tag: Tag; category: string | null },
): TagRuleRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM tag_rules WHERE account_id IS ? AND pattern = ? AND match = ? AND tag = ? AND category IS ? ORDER BY created_at, id LIMIT 1`,
      )
      .get(r.accountId, r.pattern, r.match, r.tag, r.category) as TagRuleRow | undefined) ?? null
  );
}

export function insertTagRule(
  db: Db,
  r: { accountId: string | null; pattern: string; match: RuleMatch; tag: Tag; category: string | null; origin: RuleOrigin; hitCount?: number; now: string },
): TagRuleRow {
  const id = ulid();
  db.prepare(
    `INSERT INTO tag_rules (id, account_id, pattern, match, tag, category, origin, hit_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, r.accountId, r.pattern, r.match, r.tag, r.category, r.origin, r.hitCount ?? 0, r.now, r.now);
  return getTagRule(db, id)!;
}

export function incrementTagRuleHit(db: Db, id: string, now: string): TagRuleRow | null {
  const r = db.prepare('UPDATE tag_rules SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?').run(now, id);
  return r.changes === 0 ? null : getTagRule(db, id);
}

export function deleteTagRule(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM tag_rules WHERE id = ?').run(id).changes > 0;
}
