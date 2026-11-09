// タグとタグのルールの表への読み書き（docs/mvp-plan-v3.md T108、0005_bank.sql の txn_tags・tag_rules）。SQL はここに閉じ込める。
// 効くタグの決定と学習は src/bank/tags.ts。監査ログは呼ぶ側が同じトランザクションで残す。
import type { Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';
import type { Tag, TxnTagRow } from './repo.ts';

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

// 明細ごとの上書きの最新版。上書きとみなすのは source が human / agent の版だけ（rule の版は上書きにしない）。
// 最新の上書きが cleared = 1（上書きを外す版）の明細は上書き無しとして結果に入れない。
export function latestOverrides(db: Db, ids: readonly string[]): TxnTagRow[] {
  return db
    .prepare(
      `SELECT g.* FROM txn_tags g
       JOIN (SELECT bank_txn_id, max(version) AS v FROM txn_tags
             WHERE bank_txn_id IN (SELECT value FROM json_each(?)) AND source IN ('human', 'agent') GROUP BY bank_txn_id) m
         ON m.bank_txn_id = g.bank_txn_id AND m.v = g.version
       WHERE g.cleared = 0`,
    )
    .all(JSON.stringify(ids)) as TxnTagRow[];
}

// 同じ口座・同じ正規化摘要の明細のうち、上書きの最新版が human のものを、その版を追記した順（rowid）の新しい順に limit 件。
// 1 明細 1 件。最新の上書きが agent の明細・cleared = 1（上書きを外す版）の明細は入れない。
export function recentHumanOverrides(
  db: Db,
  accountId: string,
  descriptionNorm: string,
  limit: number,
): { bank_txn_id: string; tag: Tag; category: string | null }[] {
  return db
    .prepare(
      `SELECT g.bank_txn_id, g.tag, g.category FROM txn_tags g JOIN bank_txns t ON t.id = g.bank_txn_id
       WHERE t.account_id = ? AND t.description_norm = ? AND g.source = 'human' AND g.cleared = 0
         AND g.version = (SELECT max(version) FROM txn_tags x WHERE x.bank_txn_id = g.bank_txn_id AND x.source IN ('human', 'agent'))
       ORDER BY g.rowid DESC LIMIT ?`,
    )
    .all(accountId, descriptionNorm, limit) as { bank_txn_id: string; tag: Tag; category: string | null }[];
}

// ---- 一括の上書きと取り消し（0013_txn_tags_batch） ----

// 一括（batch_id）で書いた版。1 明細 1 版。
export function txnTagsInBatch(db: Db, batchId: string): TxnTagRow[] {
  return db.prepare('SELECT * FROM txn_tags WHERE batch_id = ? ORDER BY rowid').all(batchId) as TxnTagRow[];
}

// version より前の上書き（source が human / agent）の最新版。無ければ null。
export function previousOverride(db: Db, bankTxnId: string, version: number): TxnTagRow | null {
  return (
    (db
      .prepare(`SELECT * FROM txn_tags WHERE bank_txn_id = ? AND version < ? AND source IN ('human', 'agent') ORDER BY version DESC LIMIT 1`)
      .get(bankTxnId, version) as TxnTagRow | undefined) ?? null
  );
}

export type TagBatchRevertRow = { batch_id: string; revert_batch_id: string; created_at: string };

// 一括の取り消しの行。batch_id が取り消された側、revert_batch_id が取り消しで書いた側。
export function getTagBatchRevert(db: Db, batchId: string): TagBatchRevertRow | null {
  return (db.prepare('SELECT * FROM txn_tag_batch_reverts WHERE batch_id = ?').get(batchId) as TagBatchRevertRow | undefined) ?? null;
}

export function isTagRevertBatch(db: Db, batchId: string): boolean {
  return db.prepare('SELECT 1 FROM txn_tag_batch_reverts WHERE revert_batch_id = ?').get(batchId) !== undefined;
}

export function insertTagBatchRevert(db: Db, r: { batchId: string; revertBatchId: string; now: string }): void {
  db.prepare('INSERT INTO txn_tag_batch_reverts (batch_id, revert_batch_id, created_at) VALUES (?, ?, ?)').run(r.batchId, r.revertBatchId, r.now);
}

// 一括の学習で作ったルール（監査 tag_rule.learned の payload.batch_id）のうち、今もあるものの ID。
export function learnedRuleIdsForBatch(db: Db, batchId: string): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT a.entity_id AS id FROM audit_log a JOIN tag_rules r ON r.id = a.entity_id
         WHERE a.action = 'tag_rule.learned' AND json_extract(a.payload_json, '$.batch_id') = ? ORDER BY a.entity_id`,
      )
      .all(batchId) as { id: string }[]
  ).map((r) => r.id);
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

// 学習で作ったルールのうち、同じ口座・同じパターンの exact のもの（タグ・カテゴリは問わない）。
export function findLearnedTagRule(db: Db, accountId: string, pattern: string): TagRuleRow | null {
  return (
    (db
      .prepare(`SELECT * FROM tag_rules WHERE origin = 'learned' AND match = 'exact' AND account_id IS ? AND pattern = ? ORDER BY created_at, id LIMIT 1`)
      .get(accountId, pattern) as TagRuleRow | undefined) ?? null
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

// 学習したルールのタグ・カテゴリを置き換える。hit_count は 0 に戻す。
export function replaceTagRule(db: Db, id: string, r: { tag: Tag; category: string | null; now: string }): TagRuleRow | null {
  const res = db.prepare('UPDATE tag_rules SET tag = ?, category = ?, hit_count = 0, updated_at = ? WHERE id = ?').run(r.tag, r.category, r.now, id);
  return res.changes === 0 ? null : getTagRule(db, id);
}

export function deleteTagRule(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM tag_rules WHERE id = ?').run(id).changes > 0;
}
