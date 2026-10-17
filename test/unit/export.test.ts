// 対応表のエクスポート（docs/mvp-plan.md T4-7、R13）。CSV の書き方と、年での絞り込み。API は test/api/attention.test.ts。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { csvField, mappingRows, MAPPING_COLUMNS } from '../../src/deals/export.ts';
import { addDocument, openTestDb, T0 } from './deals-helpers.ts';

describe('csvField', () => {
  test('null は空、区切り・引用符・改行は二重引用符、数式になる先頭は \' を付ける', () => {
    assert.equal(csvField(null), '');
    assert.equal(csvField(12), '12');
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('a"b'), '"a""b"');
    assert.equal(csvField('a\nb'), '"a\nb"');
    assert.equal(csvField('=1+1'), "'=1+1");
    assert.equal(csvField('-3'), "'-3");
  });
});

describe('mappingRows', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'keihi-export-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('列の順と、受領日の年での絞り込み（件数は documents と一致）', () => {
    const db = openTestDb(path.join(root, 'a.db'));
    addDocument(db, { receivedOn: '2026-01-01' });
    addDocument(db, { receivedOn: '2026-12-31' });
    addDocument(db, { receivedOn: '2027-01-01', deadlineOn: '2027-01-12' });
    const all = mappingRows(db, { provider: 'freee', now: T0 });
    assert.equal(all.length, 3);
    assert.deepEqual(Object.keys(all[0]), [...MAPPING_COLUMNS]);
    assert.equal(mappingRows(db, { provider: 'freee', year: 2026, now: T0 }).length, 2);
    db.close();
  });
});
