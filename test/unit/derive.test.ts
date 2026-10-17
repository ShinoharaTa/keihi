// T0-5 送信用の派生画像の向き補正（docs/mvp-plan.md）。
// Orientation 6・8 の画像は sharp でその場で作る（画素は横長、タグで縦に見せる）。fixture 生成器は変えない。
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { JPEG_QUALITY, deriveForAi, isPdf, thumbnail } from '../../src/ai/gemini/derive.ts';
import { hasJpegExif } from '../../tools/poc/gemini-poc.ts';

const W = 64;
const H = 32;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// 左半分が黒、右半分が白の横長画像。回転の向きを画素で確かめるため。
function landscape(): ReturnType<typeof sharp> {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = W / 2; x < W; x++) raw.fill(255, (y * W + x) * 3, (y * W + x) * 3 + 3);
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } });
}

let plain: Buffer;
let plainPng: Buffer;
let o6: Buffer;
let o8: Buffer;

before(async () => {
  plain = await landscape().jpeg().toBuffer();
  plainPng = await landscape().png().toBuffer();
  o6 = await landscape().withMetadata({ orientation: 6 }).jpeg().toBuffer();
  o8 = await landscape().withMetadata({ orientation: 8 }).jpeg().toBuffer();
});

async function pixel(buf: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data[y * info.width + x];
}

describe('deriveForAi', () => {
  test('前提: テスト画像に Orientation が付いている', async () => {
    assert.equal((await sharp(o6).metadata()).orientation, 6);
    assert.equal((await sharp(o8).metadata()).orientation, 8);
    assert.ok(hasJpegExif(o6));
  });

  for (const [name, get, topIsWhite] of [
    ['Orientation 6（時計回りに 90°）', () => o6, false],
    ['Orientation 8（反時計回りに 90°）', () => o8, true],
  ] as const) {
    test(`${name}: 縦横が入れ替わり、EXIF が無く、原本は変わらない`, async () => {
      const src = get();
      const before = sha256(src);
      const d = await deriveForAi(src);
      assert.equal(sha256(src), before);
      assert.equal(d.mime, 'image/jpeg');
      assert.deepEqual([d.width, d.height], [H, W]);
      const meta = await sharp(d.bytes).metadata();
      assert.deepEqual([meta.width, meta.height], [H, W]);
      assert.equal(meta.orientation, undefined);
      assert.equal(meta.exif, undefined);
      assert.equal(hasJpegExif(d.bytes), false);
      // 6 は元の左（黒）が上へ、8 は元の右（白）が上へ来る。
      const top = await pixel(d.bytes, H / 2, 2);
      const bottom = await pixel(d.bytes, H / 2, W - 3);
      if (topIsWhite) assert.ok(top > 200 && bottom < 55, `top=${top} bottom=${bottom}`);
      else assert.ok(top < 55 && bottom > 200, `top=${top} bottom=${bottom}`);
    });
  }

  test('Orientation 無し: 寸法が一致し、メタデータが無い', async () => {
    for (const src of [plain, plainPng]) {
      const before = sha256(src);
      const d = await deriveForAi(src);
      assert.equal(sha256(src), before);
      assert.deepEqual([d.width, d.height], [W, H]);
      const meta = await sharp(d.bytes).metadata();
      assert.equal(meta.format, 'jpeg');
      assert.deepEqual([meta.width, meta.height], [W, H]);
      assert.equal(meta.exif, undefined);
      assert.equal(meta.icc, undefined);
    }
  });

  test('JPEG 品質は 90', () => {
    assert.equal(JPEG_QUALITY, 90);
  });

  test('PDF は加工せずそのまま返す', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%dummy\n%%EOF\n', 'latin1');
    assert.ok(isPdf(pdf));
    const d = await deriveForAi(pdf);
    assert.equal(d.bytes, pdf);
    assert.equal(d.mime, 'application/pdf');
    assert.equal(d.width, null);
  });
});

describe('thumbnail', () => {
  test('向きを補正してから長辺を maxEdge に縮める。EXIF は無い', async () => {
    const before = sha256(o6);
    const t = await thumbnail(o6, 16);
    assert.equal(sha256(o6), before);
    assert.deepEqual([t.width, t.height], [8, 16]);
    assert.equal(hasJpegExif(t.bytes), false);
    assert.equal((await sharp(t.bytes).metadata()).orientation, undefined);
  });

  test('maxEdge より小さい画像は拡大しない', async () => {
    const t = await thumbnail(plain, 1000);
    assert.deepEqual([t.width, t.height], [W, H]);
  });

  test('maxEdge が不正なら例外', () => {
    assert.throws(() => thumbnail(plain, 0));
  });
});
