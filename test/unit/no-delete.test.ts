// 削除の経路が無いこと（docs/mvp-plan-v3.md T005、docs/ops/retention.md §1）。keihi は保存の対象を消さない。
// src/ 配下の .ts に、保存対象の表への DELETE 文が無いことを確かめる。マイグレーション（*.sql）のトリガー定義は対象外。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', '..', 'src');
const TABLES = ['documents', 'reviews', 'deals', 'audit_log', 'extractions', 'classifications', 'ai_turns'];
const DELETE_RE = new RegExp(`DELETE\\s+FROM\\s+["\`]?(${TABLES.join('|')})\\b`, 'i');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(dir, f));
}

describe('削除の経路が無い', () => {
  test('正規表現が DELETE 文に当たる（自己確認）', () => {
    assert.match('DELETE FROM documents WHERE id = ?', DELETE_RE);
    assert.match('delete  from\n  audit_log', DELETE_RE);
    assert.doesNotMatch('DELETE FROM walletable_aliases WHERE provider = ?', DELETE_RE);
    assert.doesNotMatch('DELETE FROM documents_fts', DELETE_RE);
  });
  test('src/**/*.ts に保存対象の表への DELETE が無い', () => {
    const files = tsFiles(SRC);
    assert.ok(files.length > 0);
    const hits = files.filter((f) => DELETE_RE.test(readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));
    assert.deepEqual(hits, []);
  });
});
