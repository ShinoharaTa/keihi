// T0-1 ダミー領収書の生成器の受け入れ条件（docs/mvp-plan.md）。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  CASES,
  INJECTED_INSTRUCTION,
  WATERMARK,
  buildCase,
  checkDigit,
  generate,
  isValidRegistrationNumber,
  type Truth,
} from '../../tools/fixtures/gen-receipts.ts';

const FICTIONAL_VENDOR = /テスト|ダミー|架空|サンプル/;
const FIVE_MB = 5 * 1024 * 1024;

let work: string;
let dirA: string;
let dirB: string;
let truths: Truth[];

async function hashes(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of (await readdir(dir)).sort()) {
    out.set(f, createHash('sha256').update(await readFile(path.join(dir, f))).digest('hex'));
  }
  return out;
}

before(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'keihi-fixtures-'));
  dirA = path.join(work, 'a');
  dirB = path.join(work, 'b');
  truths = await generate({ seed: 1, outDir: dirA });
  await generate({ seed: 1, outDir: dirB });
});

after(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('決定性', () => {
  test('同じシードで 2 回生成すると同一のバイト列になる', async () => {
    const a = await hashes(dirA);
    const b = await hashes(dirB);
    assert.equal(a.size, CASES.length * 2);
    assert.deepEqual([...a.entries()], [...b.entries()]);
  });

  test('シードが違えば内容が変わる', () => {
    const one = CASES.map((_, i) => buildCase(1, i).svg);
    const two = CASES.map((_, i) => buildCase(2, i).svg);
    assert.notDeepEqual(one, two);
  });
});

describe('バリエーション', () => {
  test('T0-1 の種類とバリエーションがすべて含まれる', () => {
    const kinds = new Set(CASES.map((c) => c.kind));
    assert.deepEqual([...kinds].sort(), ['invoice_a4', 'receipt58', 'receipt80']);
    assert.ok(CASES.some((c) => c.kind === 'invoice_a4' && c.format === 'pdf'));
    const vars = new Set(CASES.flatMap((c) => c.variations));
    for (const v of [
      'reduced_rate_mix',
      'no_registration_number',
      'wareki',
      'over_5mb',
      'under_200dpi',
      'grayscale',
      'injected_instruction',
    ]) {
      assert.ok(vars.has(v as never), v);
    }
  });

  test('ファイル形式がヘッダと一致する', async () => {
    for (const t of truths) {
      const head = (await readFile(path.join(dirA, t.file))).subarray(0, 4);
      if (t.image.format === 'pdf') assert.equal(head.toString('latin1'), '%PDF', t.file);
      else assert.equal((await sharp(path.join(dirA, t.file)).metadata()).format, t.image.format === 'jpg' ? 'jpeg' : 'png', t.file);
    }
  });
});

describe('透かし・取引先・登録番号', () => {
  test('全画像に透かしと架空の取引先名が描かれる', () => {
    CASES.forEach((_, i) => {
      const b = buildCase(1, i);
      assert.ok(b.svg.includes(WATERMARK), b.stem);
      assert.match(b.content.vendor, FICTIONAL_VENDOR, b.stem);
      assert.ok(b.svg.includes(b.content.vendor), b.stem);
    });
    for (const t of truths) assert.equal(t.watermark, WATERMARK);
  });

  test('登録番号は T999 始まりで形式検査に通る。なしの指定では null', () => {
    for (const t of truths) {
      if (t.variations.includes('no_registration_number')) {
        assert.equal(t.registration_number, null, t.file);
        continue;
      }
      assert.ok(t.registration_number, t.file);
      assert.match(t.registration_number, /^T999\d{10}$/, t.file);
      assert.ok(isValidRegistrationNumber(t.registration_number), t.file);
    }
  });

  test('チェックデジットの計算（法人番号と同じ方式）', () => {
    assert.equal(checkDigit('000000000001'), 8);
    assert.ok(isValidRegistrationNumber('T8000000000001'));
    assert.ok(!isValidRegistrationNumber('T7000000000001'));
    assert.ok(!isValidRegistrationNumber('8000000000001'));
  });

  test('命令文混入の画像には命令文が描かれ、正解は元の値のまま', () => {
    const injected = CASES.map((_, i) => buildCase(1, i)).filter((b) =>
      b.spec.variations.includes('injected_instruction'),
    );
    assert.ok(injected.length > 0);
    for (const b of injected) {
      assert.ok(b.svg.includes(INJECTED_INSTRUCTION), b.stem);
      assert.notEqual(b.content.total, 1_000_000, b.stem);
    }
    for (const t of truths) {
      const expected = t.variations.includes('injected_instruction') ? INJECTED_INSTRUCTION : null;
      assert.equal(t.injected_instruction, expected, t.file);
    }
  });
});

describe('正解 JSON', () => {
  test('合計・税率別内訳・日付の整合', () => {
    for (const t of truths) {
      assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/, t.file);
      assert.equal(t.total, t.tax_breakdown.reduce((s, x) => s + x.amount_incl_tax, 0), t.file);
      if (t.variations.includes('reduced_rate_mix')) {
        assert.deepEqual(t.tax_breakdown.map((x) => x.rate).sort(), [10, 8], t.file);
      }
      if (t.variations.includes('wareki')) assert.match(t.date_printed, /^令和\d+年/, t.file);
      assert.ok(t.expected_account.length > 0, t.file);
    }
  });
});

describe('画像の条件', () => {
  test('5MB 超の指定は実際に 5MB を超える', async () => {
    const big = truths.filter((t) => t.variations.includes('over_5mb'));
    assert.ok(big.length > 0);
    for (const t of big) assert.ok((await stat(path.join(dirA, t.file))).size > FIVE_MB, t.file);
    for (const t of truths.filter((x) => !x.variations.includes('over_5mb'))) {
      assert.ok((await stat(path.join(dirA, t.file))).size <= FIVE_MB, t.file);
    }
  });

  test('200dpi 未満の指定は短辺の画素数が紙幅換算の 200dpi に届かない', async () => {
    for (const t of truths) {
      if (t.image.format === 'pdf') continue;
      const meta = await sharp(path.join(dirA, t.file)).metadata();
      const shortPx = Math.min(meta.width, meta.height);
      const min200 = (t.image.paper_width_mm / 25.4) * 200;
      if (t.variations.includes('under_200dpi')) assert.ok(shortPx < min200, `${t.file}: ${shortPx} >= ${min200}`);
      else assert.ok(shortPx >= min200, `${t.file}: ${shortPx} < ${min200}`);
    }
  });

  test('グレースケールの指定は 1 チャンネル、それ以外はカラー', async () => {
    for (const t of truths) {
      if (t.image.format === 'pdf') continue;
      const meta = await sharp(path.join(dirA, t.file)).metadata();
      if (t.variations.includes('grayscale')) assert.equal(meta.channels, 1, t.file);
      else assert.equal(meta.channels, 3, t.file);
    }
  });
});
