// カテゴリの並びと色（#74）。どちらも台帳（GET /api/categories?all=1。bank_categories）から引く。
// 並びは台帳の順（サーバーが sort_order → id で返す items の順）、台帳に無い値はその後、未分類（null）は最後。
// 色は台帳の color（0〜11）→ style.css の k-0〜k-11。台帳に無い値・color の無い古いサーバー・未分類は k-none（グレー）。
// 明細の TagSheet・一括の CategoryPicker（お金のチャンク）からも使う。
import type { Categories } from '../model.ts';

export function categoryRank(cats: Categories | null, c: string | null): number {
  const n = cats?.items.length ?? 0;
  if (c === null) return n + 1;
  const i = cats ? cats.items.findIndex((x) => x.id === c) : -1;
  return i < 0 ? n : i;
}

export function categoryColor(cats: Categories | null, c: string | null): string {
  const color = c === null ? undefined : cats?.items.find((x) => x.id === c)?.color;
  return color === undefined ? 'k-none' : `k-${color}`;
}
