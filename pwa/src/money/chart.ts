// 「お金」タブのグラフの座標計算（純関数）。描画は Charts.tsx のインライン SVG。外部のグラフライブラリは使わない。
// 座標は SVG の viewBox の単位で、小数 1 桁に丸める（スナップショットを安定させる）。
export type Plot = { w: number; h: number; l: number; r: number; t: number; b: number };

export const r1 = (n: number) => Math.round(n * 10) / 10;

// 目盛り: 0 を含み、1・2・5 × 10^k の刻みで n 本前後。
export function niceTicks(min: number, max: number, n = 4): number[] {
  const lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (hi === lo) hi = lo + 10000;
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  // 刻みは最低 1 円（小さな値で目盛りが重ならないように）。丸めて同じになった目盛りは 1 つにする。
  const step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) {
    const r = Math.round(v);
    if (out[out.length - 1] !== r) out.push(r);
  }
  return out;
}

// 目盛りの最小〜最大を、描画域の下端〜上端に。
export function yScale(ticks: number[], p: Plot): (v: number) => number {
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const top = p.t;
  const bottom = p.h - p.b;
  return (v) => r1(bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top));
}

// n 点を左端〜右端に等間隔で（1 点なら真ん中）。
export function xAt(i: number, n: number, p: Plot): number {
  const w = p.w - p.l - p.r;
  return r1(n <= 1 ? p.l + w / 2 : p.l + (i * w) / (n - 1));
}

export type Pt = { x: number; y: number };
export type LineChart = { ticks: { v: number; y: number }[]; pts: Pt[]; points: string; y: (v: number) => number };
// 折れ線。extra は目盛りの範囲に入れたい値（残す額の線など）。
export function lineChart(values: number[], p: Plot, extra: number[] = [], nTicks = 4): LineChart {
  const all = [...values, ...extra];
  const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0), nTicks);
  const y = yScale(ticks, p);
  const pts = values.map((v, i) => ({ x: xAt(i, values.length, p), y: y(v) }));
  return { ticks: ticks.map((v) => ({ v, y: y(v) })), pts, points: pts.map((q) => `${q.x},${q.y}`).join(' '), y };
}

// 下端（0 の線）から値までの面（残す額の帯）。
export function areaPoints(pts: Pt[], baseY: number): string {
  if (pts.length === 0) return '';
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  return [...pts.map((q) => `${q.x},${q.y}`), `${last.x},${baseY}`, `${first.x},${baseY}`].join(' ');
}

// 条件を満たす点の続き（足りない期間）を x の範囲にする。各点の左右は隣との中点まで。
export function spans(flags: boolean[], p: Plot): { x: number; w: number }[] {
  const n = flags.length;
  const half = n > 1 ? (p.w - p.l - p.r) / (n - 1) / 2 : 0;
  const out: { x: number; w: number }[] = [];
  let i = 0;
  while (i < n) {
    if (!flags[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && flags[j + 1]) j++;
    const x0 = Math.max(p.l, xAt(i, n, p) - half);
    const x1 = Math.min(p.w - p.r, xAt(j, n, p) + half);
    out.push({ x: r1(x0), w: r1(x1 - x0) });
    i = j + 1;
  }
  return out;
}

// 2 本並びの棒（収入・支出）。月ごとの中心 cx と、各棒の y・高さ。
export type PairBar = { cx: number; inc: { x: number; y: number; h: number }; exp: { x: number; y: number; h: number } };
export function pairBars(rows: { income: number; expense: number }[], p: Plot, barW = 14): { ticks: { v: number; y: number }[]; bars: PairBar[]; baseY: number } {
  const max = Math.max(0, ...rows.map((r) => Math.max(r.income, r.expense)));
  const ticks = niceTicks(0, max, 2);
  const y = yScale(ticks, p);
  const baseY = y(0);
  const slot = (p.w - p.l - p.r) / Math.max(1, rows.length);
  const bars = rows.map((r, i) => {
    const cx = r1(p.l + slot * (i + 0.5));
    const iy = y(r.income);
    const ey = y(r.expense);
    return { cx, inc: { x: r1(cx - barW - 1), y: iy, h: r1(baseY - iy) }, exp: { x: r1(cx + 1), y: ey, h: r1(baseY - ey) } };
  });
  return { ticks: ticks.map((v) => ({ v, y: y(v) })), bars, baseY };
}

// 積み上げの棒（予定の山）。各段の y と高さ（下から順）。
export function stackBars<K extends string>(rows: Record<K, number>[], keys: readonly K[], p: Plot): { cx: number; segs: { key: K; y: number; h: number }[]; top: number }[] {
  const totals = rows.map((r) => keys.reduce((a, k) => a + r[k], 0));
  const max = Math.max(1, ...totals);
  const plotH = p.h - p.t - p.b;
  const baseY = p.h - p.b;
  const slot = (p.w - p.l - p.r) / Math.max(1, rows.length);
  return rows.map((r, i) => {
    const cx = r1(p.l + slot * (i + 0.5));
    let acc = 0;
    const segs: { key: K; y: number; h: number }[] = [];
    for (const k of keys) {
      if (r[k] <= 0) continue;
      const h = (r[k] / max) * plotH;
      segs.push({ key: k, y: r1(baseY - acc - h), h: r1(h) });
      acc += h;
    }
    return { cx, segs, top: r1(baseY - acc) };
  });
}

// 値の割合（%、0〜100）。
export const pct = (v: number, max: number) => (max <= 0 ? 0 : r1(Math.min(100, Math.max(0, (v / max) * 100))));
