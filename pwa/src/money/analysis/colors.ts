// 分析の画面（#74）のカテゴリの並びと色。並びは src/bank/tags.ts の CATEGORIES（固定 13 種）、未分類（null）は最後。
// 色は style.css の k-0〜k-11（13 番目は k-0 に戻る）と k-none（未分類）。カテゴリ台帳（PR5）の値に置き換えるときはここだけ直す。
export const CATEGORY_ORDER: readonly string[] = ['food', 'daily', 'transport', 'telecom', 'housing', 'utilities', 'insurance', 'tax', 'car', 'leisure', 'medical', 'savings', 'other'];
const COLORS = 12;

// 並べる順（知らないカテゴリは固定 13 種の後、未分類はさらに後）。
export function categoryRank(c: string | null): number {
  if (c === null) return CATEGORY_ORDER.length + 1;
  const i = CATEGORY_ORDER.indexOf(c);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

// 色のクラス。知らないカテゴリは未分類と同じグレー。
export function categoryColor(c: string | null): string {
  const i = c === null ? -1 : CATEGORY_ORDER.indexOf(c);
  return i < 0 ? 'k-none' : `k-${i % COLORS}`;
}
