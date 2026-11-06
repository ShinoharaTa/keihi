// PoC スクリプト（gemini-poc.ts・freee-poc.ts）で共通の小物。
import { stat } from 'node:fs/promises';
import path from 'node:path';

// 拡張子から MIME 型を決める。HEIC は opts.heic のときだけ受け付ける（Gemini へは EXIF を落とせない形式を送らない）。
export function mimeOf(file: string, opts: { heic?: boolean } = {}): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.pdf') return 'application/pdf';
  if (opts.heic && (ext === '.heic' || ext === '.heif')) return 'image/heic';
  throw new Error(`未対応の形式: ${ext}`);
}

// secrets.env が通常のファイルで 0600 であることを確かめる（それ以外は拒否）。
export async function assertSecretsFile(secretsPath: string): Promise<void> {
  let st;
  try {
    st = await stat(secretsPath);
  } catch {
    throw new Error(`${secretsPath} が無い`);
  }
  if (!st.isFile()) throw new Error(`${secretsPath} が通常のファイルではない`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${secretsPath} のパーミッションが 0600 ではない（現在 0${mode.toString(8)}）。chmod 600 してから実行する`);
  }
}
