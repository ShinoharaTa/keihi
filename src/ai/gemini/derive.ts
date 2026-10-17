// 送信用の派生画像（docs/mvp-plan.md T0-5、D13）。Gemini へ送る画像と PWA のサムネイルを作る。
// - Orientation に従って画素を回転してから、メタデータ（EXIF・XMP・IPTC・ICC・コメント）を全部落として JPEG で再エンコードする。
//   EXIF を落とすだけだと Orientation も消え、スマホの写真が横倒しで届くため。
// - 派生画像は法定の記録ではないので再エンコードしてよい。freee へ送る原本は加工しない（R4）。入力のバッファは書き換えない。
// - PDF は加工せずそのまま返す。
import sharp from 'sharp';

export const JPEG_QUALITY = 90;

export type Derived = {
  bytes: Buffer;
  mime: string;
  // PDF は寸法を持たない（加工しない）ので null。
  width: number | null;
  height: number | null;
};

export function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

async function derive(buf: Buffer, maxEdge?: number): Promise<Derived> {
  if (isPdf(buf)) return { bytes: buf, mime: 'application/pdf', width: null, height: null };
  // rotate() は引数なしで Orientation に従って回転する。withMetadata を付けないので出力にメタデータは残らない。
  let img = sharp(buf).rotate();
  if (maxEdge !== undefined) img = img.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  // JPEG は透過を持てないので、透過のある PNG は白で埋める（領収書の地の色）。
  const { data, info } = await img
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, mime: 'image/jpeg', width: info.width, height: info.height };
}

export function deriveForAi(buf: Buffer): Promise<Derived> {
  return derive(buf);
}

// PWA のサムネイル。長辺を maxEdge 以下に縮める（拡大はしない）。それ以外は deriveForAi と同じ経路。
export function thumbnail(buf: Buffer, maxEdge: number): Promise<Derived> {
  if (!Number.isInteger(maxEdge) || maxEdge <= 0) throw new Error(`maxEdge が不正: ${maxEdge}`);
  return derive(buf, maxEdge);
}
