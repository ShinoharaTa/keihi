// 「お金」タブのグラフ（インライン SVG。外部ライブラリは使わない）。座標は chart.ts の純関数で計算し、色は style.css の c-* / f-* / t-* で当てる。
// どれも hooks を使わない描画だけの部品（SSR のスナップショットで試す）。押せるグラフは onPick / onSelect を受ける。
import { areaPoints, lineChart, pairBars, pct, r1, spans, stackBars, xAt, type Plot } from './chart.ts';
import { man, markSize, signedMan, type ForecastMonth, type MonthMarks, type PeakMonth } from './model.ts';

const mon = (month: string) => `${Number(month.slice(5, 7))}月`;
const tickLabel = (v: number) => (v === 0 ? '0' : man(v));

// 横の帯（割合の合計 100）。各段は cls の色。段の間に細い隙間。
export function StackBar({ parts, label, tall }: { parts: { cls: string; pct: number }[]; label: string; tall?: boolean }) {
  let x = 0;
  const rects = parts
    .filter((p) => p.pct > 0)
    .map((p) => {
      const r = { cls: p.cls, x: r1(x), w: r1(p.pct) };
      x += p.pct;
      return r;
    });
  return (
    <svg class={tall ? 'm-bar m-bar-14' : 'm-bar'} viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label={label}>
      <rect class="f-track" x="0" y="0" width="100" height="10" />
      {rects.map((r) => (
        <rect key={r.cls} class={r.cls} x={r.x} y="0" width={r.w} height="10" />
      ))}
      {rects.slice(1).map((r) => (
        <line key={`g-${r.cls}`} class="f-gap" x1={r.x} x2={r.x} y1="0" y2="10" vector-effect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

// カテゴリ別の横棒。値の棒と、平均の縦線。
export function CatBar({ value, avg, max }: { value: number; avg: number; max: number }) {
  const v = pct(value, max);
  const a = Math.min(99, Math.max(1, pct(avg, max)));
  return (
    <svg class="m-catbar" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
      <rect class="f-track" x="0" y="3" width="100" height="12" />
      <rect class="f-out" x="0" y="3" width={v} height="12" />
      <line class="f-avg" x1={a} x2={a} y1="0" y2="18" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

const TREND: Plot = { w: 340, h: 150, l: 36, r: 8, t: 12, b: 30 };

// ホームの残高の推移（月末・直近 12 か月）。残す額の点線、最低の月と今月に印。
export function BalanceTrend({ months, reserve }: { months: { month: string; total: number }[]; reserve: number | null }) {
  if (months.length === 0) return null;
  const p = TREND;
  const c = lineChart(
    months.map((m) => m.total),
    p,
    reserve === null ? [] : [reserve],
  );
  const n = months.length;
  let lo = 0;
  months.forEach((m, i) => {
    if (m.total < months[lo]!.total) lo = i;
  });
  const first = months[0]!;
  const last = months[n - 1]!;
  const lastPt = c.pts[n - 1]!;
  const loPt = c.pts[lo]!;
  const ry = reserve === null ? null : c.y(reserve);
  const xs = months.map((m, i) => ({ m, i })).filter(({ i }) => i === n - 1 || (i % 3 === 0 && n - 1 - i >= 2));
  const label = `直近 ${n} か月の月末残高。${first.month} の ${man(first.total)}円から ${last.month} の ${man(last.total)}円へ。最低は ${months[lo]!.month} の ${man(months[lo]!.total)}円${reserve === null ? '' : `。残す額は ${man(reserve)}円`}`;
  return (
    <svg class="m-svg" role="img" aria-label={label} viewBox={`0 0 ${p.w} ${p.h}`}>
      {c.ticks.map((t) => (
        <line key={`g${t.v}`} class="c-grid" x1={p.l} x2={p.w - p.r} y1={t.y} y2={t.y} />
      ))}
      {c.ticks.map((t) => (
        <text key={`t${t.v}`} class="c-axis" x={p.l - 6} y={t.y + 3} font-size="10" text-anchor="end">
          {tickLabel(t.v)}
        </text>
      ))}
      {ry !== null && reserve !== null && (
        <>
          <line class="c-dash" x1={p.l} x2={p.w - p.r} y1={ry} y2={ry} />
          <text class="c-label" x={p.l + 4} y={ry + 12} font-size="10">
            残す額 {man(reserve)}
          </text>
        </>
      )}
      <polyline class="c-line" points={c.points} />
      {lo !== n - 1 && (
        <>
          <circle class="c-ring" cx={loPt.x} cy={loPt.y} r="3" />
          <text class="c-fg2" x={loPt.x} y={loPt.y + 14} font-size="10" text-anchor="middle">
            {man(months[lo]!.total)}
          </text>
        </>
      )}
      <circle class="c-dot" cx={lastPt.x} cy={lastPt.y} r="4" />
      <text class="c-fg t-b" x={lastPt.x} y={lastPt.y - 10} font-size="11" text-anchor="end">
        {man(last.total)}
      </text>
      {xs.map(({ m, i }) => (
        <text key={m.month} class="c-label" x={i === n - 1 ? xAt(i, n, p) - 8 : xAt(i, n, p)} y={p.h - 12} font-size="10" text-anchor="middle">
          {mon(m.month)}
        </text>
      ))}
    </svg>
  );
}

const FC: Plot = { w: 350, h: 236, l: 40, r: 8, t: 12, b: 64 };
const MARK_ROWS = [
  { key: 'tax', label: '税金', y: 200 },
  { key: 'insurance', label: '保険', y: 213 },
  { key: 'car', label: '車', y: 226 },
] as const;

// 見通しの折れ線（36 か月）。残す額の帯、足りない期間の色、最初に足りなくなる月の印、下に 税金・保険・車 の印（大きいほど金額が大きい）。
export function ForecastChart({ months, marks, shortfall, onPick }: { months: ForecastMonth[]; marks: MonthMarks[]; shortfall: string | null; onPick?: (month: string) => void }) {
  if (months.length === 0) return null;
  const p = FC;
  const n = months.length;
  const c = lineChart(
    months.map((m) => m.balance_end),
    p,
    months.map((m) => m.reserve),
  );
  const base = c.y(0);
  const reservePts = months.map((m, i) => ({ x: c.pts[i]!.x, y: c.y(m.reserve) }));
  const shorts = spans(
    months.map((m) => m.margin < 0),
    p,
  );
  const si = shortfall ? months.findIndex((m) => m.month === shortfall) : -1;
  const first = months[0]!;
  const last = months[n - 1]!;
  const max = Math.max(0, ...marks.flatMap((m) => [m.tax, m.insurance, m.car]));
  const pick = (e: MouseEvent) => {
    if (!onPick) return;
    const el = e.currentTarget as SVGSVGElement;
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / (rect.width || 1)) * p.w;
    const step = (p.w - p.l - p.r) / Math.max(1, n - 1);
    const i = Math.min(n - 1, Math.max(0, Math.round((x - p.l) / step)));
    onPick(months[i]!.month);
  };
  const label = `${n} か月の推定月末残高。${first.month} の ${man(first.balance_end)}円から ${last.month} の ${man(last.balance_end)}円。${shortfall ? `${shortfall} に残す額を下回る` : '残す額を下回る月はない'}`;
  return (
    <svg class={onPick ? 'm-svg m-svg-tap' : 'm-svg'} role="img" aria-label={label} viewBox={`0 0 ${p.w} ${p.h}`} onClick={pick}>
      {shorts.map((s) => (
        <rect key={s.x} class="f-short" x={s.x} y={p.t} width={s.w} height={p.h - p.b - p.t} />
      ))}
      {c.ticks.map((t) => (
        <line key={`g${t.v}`} class="c-grid" x1={p.l} x2={p.w - p.r} y1={t.y} y2={t.y} />
      ))}
      {months.map((m, i) =>
        m.month.endsWith('-01') ? <line key={`v${m.month}`} class="c-grid" x1={c.pts[i]!.x} x2={c.pts[i]!.x} y1={p.t} y2={p.h - p.b} /> : null,
      )}
      {c.ticks.map((t) => (
        <text key={`t${t.v}`} class="c-axis" x={p.l - 6} y={t.y + 3} font-size="10" text-anchor="end">
          {tickLabel(t.v)}
        </text>
      ))}
      <polygon class="c-reserve" points={areaPoints(reservePts, base)} />
      <line class="c-base" x1={p.l} x2={p.w - p.r} y1={base} y2={base} />
      <polyline class="c-line" points={c.points} />
      {si >= 0 && (
        <>
          <line class="c-dash-warn" x1={c.pts[si]!.x} x2={c.pts[si]!.x} y1={p.t} y2={p.h - p.b} />
          <circle class="c-ring-warn" cx={c.pts[si]!.x} cy={c.pts[si]!.y} r="4" />
          <text class="t-out t-b" x={c.pts[si]!.x + (c.pts[si]!.x < 110 ? 4 : -4)} y={p.t + 12} font-size="10" text-anchor={c.pts[si]!.x < 110 ? 'start' : 'end'}>
            {shortfall}
          </text>
        </>
      )}
      <circle class="c-dot" cx={c.pts[0]!.x} cy={c.pts[0]!.y} r="3.5" />
      <text class="c-fg" x={c.pts[0]!.x + 6} y={c.pts[0]!.y - 8} font-size="10">
        {man(first.balance_end)}
      </text>
      <text class={last.margin < 0 ? 't-out t-b' : 'c-fg t-b'} x={c.pts[n - 1]!.x - 4} y={c.pts[n - 1]!.y - 8} font-size="10" text-anchor="end">
        {man(last.balance_end)}
      </text>
      {months.map((m, i) => {
        if (i === 0) {
          return (
            <text key="x0" class="c-label" x={c.pts[0]!.x + 4} y={p.h - p.b + 14} font-size="10" text-anchor="middle">
              {mon(m.month)}
            </text>
          );
        }
        if (!m.month.endsWith('-01') || i < 3) return null;
        return (
          <text key={`x${m.month}`} class="c-label" x={c.pts[i]!.x} y={p.h - p.b + 14} font-size="10" text-anchor="middle">
            {m.month.slice(0, 4)}
          </text>
        );
      })}
      {MARK_ROWS.map((row) => (
        <g key={row.key}>
          <line class="c-grid" x1={p.l} x2={p.w - p.r} y1={row.y} y2={row.y} />
          <text class="c-fg2" x={p.l - 6} y={row.y + 3} font-size="9" text-anchor="end">
            {row.label}
          </text>
          {marks.map((mk, i) => {
            const s = markSize(mk[row.key], max);
            if (s === 0) return null;
            const x = c.pts[i]!.x;
            if (row.key === 'tax') return <circle key={mk.month} class="f-tax" cx={x} cy={row.y} r={[0, 2.5, 3.5, 5][s]} />;
            if (row.key === 'insurance') {
              const w = [0, 5, 7, 9][s]!;
              return <rect key={mk.month} class="f-insurance" x={r1(x - w / 2)} y={r1(row.y - w / 2)} width={w} height={w} />;
            }
            const h = [0, 3.5, 4.5, 5.5][s]!;
            return <path key={mk.month} class="f-car" d={`M${x},${r1(row.y - h)} L${r1(x + h)},${r1(row.y + h * 0.75)} L${r1(x - h)},${r1(row.y + h * 0.75)} Z`} />;
          })}
        </g>
      ))}
    </svg>
  );
}

const SIX: Plot = { w: 334, h: 166, l: 40, r: 4, t: 12, b: 38 };

// 月次の 6 か月の収支（収入・支出の 2 本並び、下に差額）。選んだ月の背景を塗る。棒を押すとその月へ。
export function SixMonthBars({ months, selected, onSelect }: { months: { month: string; income: number; expense: number }[]; selected: string; onSelect?: (month: string) => void }) {
  if (months.length === 0) return null;
  const p = SIX;
  const g = pairBars(months, p);
  const slot = (p.w - p.l - p.r) / months.length;
  const label = `${months[0]!.month} から ${months[months.length - 1]!.month} の収入と支出。差額は ${months.map((m) => `${mon(m.month)} ${signedMan(m.income - m.expense)}`).join('、')}`;
  return (
    <svg class="m-svg" role="img" aria-label={label} viewBox={`0 0 ${p.w} ${p.h}`}>
      {months.map((m, i) =>
        m.month === selected ? <rect key="sel" class="f-sel" x={r1(g.bars[i]!.cx - slot / 2 + 2)} y="4" width={r1(slot - 4)} height={p.h - 6} rx="6" /> : null,
      )}
      {g.ticks.map((t) => (
        <line key={`g${t.v}`} class="c-grid" x1={p.l} x2={p.w - p.r} y1={t.y} y2={t.y} />
      ))}
      {g.ticks.map((t) => (
        <text key={`t${t.v}`} class="c-axis" x={p.l - 6} y={t.y + 3} font-size="10" text-anchor="end">
          {tickLabel(t.v)}
        </text>
      ))}
      {g.bars.map((b, i) => (
        <g key={months[i]!.month}>
          <rect class="f-in" x={b.inc.x} y={b.inc.y} width="14" height={b.inc.h} rx="2" />
          <rect class="f-out" x={b.exp.x} y={b.exp.y} width="14" height={b.exp.h} rx="2" />
        </g>
      ))}
      {months.map((m, i) => {
        const net = m.income - m.expense;
        const on = m.month === selected;
        return (
          <g key={`l${m.month}`}>
            <text class={on ? 'c-fg2 t-b' : 'c-fg2'} x={g.bars[i]!.cx} y={p.h - p.b + 14} font-size="11" text-anchor="middle">
              {mon(m.month)}
            </text>
            <text class={`${net < 0 ? 't-out' : 't-in'}${on ? ' t-b' : ''}`} x={g.bars[i]!.cx} y={p.h - p.b + 29} font-size="10" text-anchor="middle">
              {signedMan(net)}
            </text>
          </g>
        );
      })}
      {onSelect &&
        months.map((m, i) => (
          <rect key={`hit${m.month}`} x={r1(g.bars[i]!.cx - slot / 2)} y="0" width={r1(slot)} height={p.h} fill="transparent" onClick={() => onSelect(m.month)} />
        ))}
    </svg>
  );
}

const PEAK: Plot = { w: 334, h: 104, l: 0, r: 0, t: 22, b: 26 };
const PEAK_KEYS = ['insurance', 'tax', 'car', 'other'] as const;

// 予定のこの先 12 か月の山（分類別の積み上げ。毎月の分は除く）。重い月には金額。
export function PeakStrip({ peaks, heavy }: { peaks: PeakMonth[]; heavy: string[] }) {
  if (peaks.length === 0) return null;
  const p = PEAK;
  const bars = stackBars(peaks, PEAK_KEYS, p);
  const base = p.h - p.b;
  const label = `${peaks[0]!.month} から ${peaks[peaks.length - 1]!.month} の予定支出（毎月の分を除く）。${
    heavy.length ? `山は ${heavy.map((m) => `${m} の ${man(peaks.find((x) => x.month === m)!.total)}円`).join('、')}` : '大きな支出はなし'
  }`;
  return (
    <svg class="m-svg" role="img" aria-label={label} viewBox={`0 0 ${p.w} ${p.h}`}>
      <line class="c-base" x1="0" x2={p.w} y1={base} y2={base} />
      {bars.map((b, i) => (
        <g key={peaks[i]!.month}>
          {b.segs.map((s) => (
            <rect key={s.key} class={`f-${s.key}`} x={r1(b.cx - 8)} y={s.y} width="16" height={s.h} />
          ))}
          {heavy.includes(peaks[i]!.month) && (
            <text class="c-fg t-b" x={b.cx} y={b.top - 5} font-size="10" text-anchor="middle">
              {man(peaks[i]!.total)}
            </text>
          )}
          <text class="c-label" x={b.cx} y={base + 14} font-size="10" text-anchor="middle">
            {Number(peaks[i]!.month.slice(5, 7))}
          </text>
          {peaks[i]!.month.endsWith('-01') && (
            <text class="c-label" x={b.cx} y={base + 25} font-size="10" text-anchor="middle">
              {peaks[i]!.month.slice(0, 4)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
