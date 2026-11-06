// 取り込みの入力検証（docs/mvp-plan-v0.1.md T1-6、legal.md R1〜R3、D6）。
// - MIME は宣言ではなく先頭のマジックバイトで判定する（JPEG / PNG / PDF のみ）。
// - R2: 必要画素 = 寸法 mm ÷ 25.4 × 200（切り上げ）。D6 の短辺に加え、長辺の寸法が決まっているプリセット（A4 など）は長辺も見る。
// - R3: 3 チャンネル以上（グレースケールでない）、パレットでない、1 チャンネル 8bit 以上。
import sharp from 'sharp';

export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export const REQUIRED_DPI = 200;

// 書類の寸法（mm）。レシートは長さが決まらないので幅（短辺）だけ。
export const SIZE_PRESETS: Record<string, { shortMm: number; longMm?: number }> = {
  receipt58: { shortMm: 58 },
  receipt80: { shortMm: 80 },
  a5: { shortMm: 148, longMm: 210 },
  b5: { shortMm: 182, longMm: 257 },
  a4: { shortMm: 210, longMm: 297 },
};

export function sniffMime(b: Uint8Array): AllowedMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 5 && Buffer.from(b.subarray(0, 5)).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export function requiredPx(mm: number, dpi: number = REQUIRED_DPI): number {
  return Math.ceil((mm / 25.4) * dpi);
}

export type ImageCheck = {
  width: number;
  height: number;
  resolutionOk: boolean;
  colorOk: boolean;
  required: { shortPx: number; longPx: number | null };
};

export async function checkScanImage(bytes: Uint8Array, preset: string): Promise<ImageCheck> {
  const p = SIZE_PRESETS[preset];
  if (!p) throw new Error(`知らないサイズのプリセット: ${preset}`);
  const m = await sharp(bytes).metadata();
  if (!m.width || !m.height) throw new Error('画像の寸法を読めない');
  const shortPx = requiredPx(p.shortMm);
  const longPx = p.longMm === undefined ? null : requiredPx(p.longMm);
  const s = Math.min(m.width, m.height);
  const l = Math.max(m.width, m.height);
  const resolutionOk = s >= shortPx && (longPx === null || l >= longPx);
  // パレット PNG は 256 色までなので 24bit カラーとみなさない。
  const colorOk = (m.channels ?? 0) >= 3 && m.space !== 'b-w' && !m.isPalette && (m.bitsPerSample === undefined || m.bitsPerSample >= 8);
  return { width: m.width, height: m.height, resolutionOk, colorOk, required: { shortPx, longPx } };
}
