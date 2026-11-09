// 分析の画面（#74）の描画だけの部品（hooks を使わない。SSR のスナップショットで試す）。状態と読み込みは殻の Analysis.tsx。
// wide（PC 幅、3 カラム）と スマホ（1 カラム）で出す数値・できる操作は同じ。スマホのクロス表は「計 / 事業 / 私用 / 未設定」の切替で 1 列ずつ。
// 推移はインライン SVG（chart.ts の stackBars。外部ライブラリは使わない）。棒は押せる（role=button）。色は colors.ts の k-*。
import type { ComponentChildren } from 'preact';
import { r1, stackBars, type Plot } from '../chart.ts';
import { Icon } from '../Icons.tsx';
import { categoryLabel, dayLabel, KIND_LABELS, man, signedYen, TAG_LABELS, TAG_ORDER, yen, type Categories, type Tag, type Txn } from '../model.ts';
import {
  COL_LABELS,
  COLS,
  SIDE_LABELS,
  SPAN_LABELS,
  SPANS,
  share,
  type Col,
  type Cross,
  type CrossCell,
  type Pick,
  type Side,
  type Span,
  type Totals,
  type TrendBar,
  samePick,
} from './aggregate.ts';
import { categoryColor, categoryRank } from './colors.ts';

const SIDES: readonly Side[] = ['expense', 'income'];
const count = (n: number) => `${n} 件`;

// 期間の切替（月 / 四半期 / 年 と 前後の矢印）。
export function PeriodSwitch({ span, label, canNext, onSpan, onShift }: { span: Span; label: string; canNext: boolean; onSpan: (s: Span) => void; onShift: (n: number) => void }) {
  return (
    <div class="m-an-period">
      <div class="m-seg m-seg-3" role="group" aria-label="期間の種類">
        {SPANS.map((s) => (
          <button type="button" key={s} aria-pressed={span === s} onClick={() => onSpan(s)}>
            {SPAN_LABELS[s]}
          </button>
        ))}
      </div>
      <div class="m-an-step">
        <button type="button" class="m-icon" aria-label="前の期間" onClick={() => onShift(-1)}>
          <Icon name="back" size={22} />
        </button>
        <b>{label}</b>
        <button type="button" class="m-icon" aria-label="次の期間" disabled={!canNext} onClick={() => onShift(1)}>
          <Icon name="next" size={22} />
        </button>
      </div>
    </div>
  );
}

// 向き（支出 / 収入）とタグの絞り込み（全部 / 事業 / 私用 / 未設定）。
export function FilterControls({ side, tag, onSide, onTag }: { side: Side; tag: '' | Tag; onSide: (s: Side) => void; onTag: (t: '' | Tag) => void }) {
  return (
    <div class="m-col">
      <span class="m-sub">向き</span>
      <div class="m-seg m-seg-2" role="group" aria-label="向き">
        {SIDES.map((s) => (
          <button type="button" key={s} aria-pressed={side === s} onClick={() => onSide(s)}>
            {SIDE_LABELS[s]}
          </button>
        ))}
      </div>
      <span class="m-sub">タグ</span>
      <div class="m-seg m-seg-4" role="group" aria-label="タグ">
        {(['', ...TAG_ORDER] as const).map((t) => (
          <button type="button" key={t || 'all'} aria-pressed={tag === t} onClick={() => onTag(t)}>
            {t ? TAG_LABELS[t] : '全部'}
          </button>
        ))}
      </div>
    </div>
  );
}

// 絞り込みのボタンの文言（スマホの帯）。
export const filterText = (side: Side, tag: '' | Tag) => `${SIDE_LABELS[side]}${tag ? ` · ${TAG_LABELS[tag]}` : ''}`;

// 合計（収入・支出・差額・件数）。
export function TotalsCard({ t, label }: { t: Totals; label: string }) {
  return (
    <section class="m-col" aria-label={`${label}の合計`}>
      <div class="m-row">
        <h2 class="m-h2">合計</h2>
        <span class="m-sub">{count(t.count)}</span>
      </div>
      <div class="m-tiles3">
        <div class="m-tile3">
          <span class="k-in">収入</span>
          <b>{yen(t.income)}</b>
        </div>
        <div class="m-tile3">
          <span class="k-out">支出</span>
          <b>{yen(t.expense)}</b>
        </div>
        <div class="m-tile3">
          <span>差額</span>
          <b>{yen(t.net)}</b>
        </div>
      </div>
    </section>
  );
}

const TREND: Plot = { w: 576, h: 190, l: 8, r: 8, t: 22, b: 40 };
const BAR_W = 22;

// 推移（期間ごとのカテゴリの積み上げ）。スマホは横スクロール（最大 12 本）。棒を押すとその期間のドリルダウン。
export function TrendChart({
  bars,
  side,
  cats,
  selected,
  wide,
  onPick,
}: {
  bars: TrendBar[];
  side: Side;
  cats: Categories | null;
  selected: string | null;
  wide: boolean;
  onPick: (start: string) => void;
}) {
  const p = TREND;
  // 段の順は固定（下から固定 13 種の順、未分類が上）。未分類のキーは ''。
  const keys = [...new Set(bars.flatMap((b) => b.segs.map((s) => s.category ?? '')))].sort((a, b) => categoryRank(a || null) - categoryRank(b || null));
  const rows = bars.map((b) => Object.fromEntries(keys.map((k) => [k, b.segs.find((s) => (s.category ?? '') === k)?.amount ?? 0])) as Record<string, number>);
  const g = stackBars(rows, keys, p);
  const slot = (p.w - p.l - p.r) / Math.max(1, bars.length);
  const base = p.h - p.b;
  const svg = (
    <svg class="m-svg m-an-trend" role="group" aria-label={`${SIDE_LABELS[side]}の推移`} viewBox={`0 0 ${p.w} ${p.h}`}>
      {bars.map((b, i) =>
        b.start === selected ? <rect key="sel" class="f-sel" x={r1(g[i]!.cx - slot / 2 + 2)} y="2" width={r1(slot - 4)} height={p.h - 4} rx="6" /> : null,
      )}
      <line class="c-base" x1={p.l} x2={p.w - p.r} y1={base} y2={base} />
      {bars.map((b, i) => (
        <g key={b.start} class={b.partial ? 'm-an-partial' : undefined}>
          {g[i]!.segs.map((s) => (
            <rect key={s.key} class={categoryColor(s.key === '' ? null : s.key)} x={r1(g[i]!.cx - BAR_W / 2)} y={s.y} width={BAR_W} height={s.h} />
          ))}
          {b.amount > 0 && (
            <text class="c-fg2" x={g[i]!.cx} y={g[i]!.top - 6} font-size="10" text-anchor="middle">
              {man(b.amount)}
            </text>
          )}
          <text class={b.start === selected ? 'c-fg2 t-b' : 'c-fg2'} x={g[i]!.cx} y={base + 15} font-size="11" text-anchor="middle">
            {b.short}
          </text>
          {b.yearMark && (
            <text class="c-axis" x={g[i]!.cx} y={base + 30} font-size="10" text-anchor="middle">
              {b.yearMark}
            </text>
          )}
        </g>
      ))}
      {bars.map((b, i) => (
        <rect
          key={`hit${b.start}`}
          class="m-hit"
          x={r1(g[i]!.cx - slot / 2)}
          y="0"
          width={r1(slot)}
          height={p.h}
          fill="transparent"
          tabindex={0}
          role="button"
          aria-label={`${b.label} ${SIDE_LABELS[side]} ${yen(b.amount)} 円。明細を見る`}
          aria-pressed={b.start === selected}
          onClick={() => onPick(b.start)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onPick(b.start);
            }
          }}
        />
      ))}
    </svg>
  );
  return (
    <section class="m-card m-pad12 m-gap8" aria-labelledby="m-an-trend">
      <div class="m-row">
        <h2 id="m-an-trend" class="m-h2">
          {SIDE_LABELS[side]}の推移
        </h2>
        <span class="m-sub">棒を押すと明細</span>
      </div>
      {wide ? svg : <div class="m-an-scroll">{svg}</div>}
      <div class="m-legend" aria-hidden="true">
        {keys.map((k) => (
          <span key={k || 'none'}>
            <span class={`m-sw ${categoryColor(k === '' ? null : k)}`} />
            {categoryLabel(cats, k === '' ? null : k)}
          </span>
        ))}
      </div>
      {bars.some((b) => b.partial) && <p class="m-sub">薄い棒は、まだ途中か読めていない月がある期間です。</p>}
    </section>
  );
}

const ColBar = ({ cls, pct }: { cls: string; pct: number }) => (
  <svg class="m-an-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
    <rect class="f-track" x="0" y="0" width="100" height="6" />
    <rect class={cls} x="0" y="0" width={Math.min(100, pct)} height="6" />
  </svg>
);

const colPick = (start: string, category: string | null | undefined, col: Col): Pick => ({ start, ...(category !== undefined ? { category } : {}), ...(col !== 'all' ? { tag: col } : {}) });

// クロス表（行 = カテゴリ、列 = 事業 / 私用 / 未設定 / 計）。PC は 4 列の表、スマホは上の切替で 1 列（金額・件数・割合の棒）。セルを押すとドリルダウン。
export function CrossTable({
  cross,
  start,
  side,
  cats,
  col,
  selected,
  wide,
  onCol,
  onPick,
}: {
  cross: Cross;
  start: string;
  side: Side;
  cats: Categories | null;
  col: Col;
  selected: Pick | null;
  wide: boolean;
  onCol: (c: Col) => void;
  onPick: (p: Pick) => void;
}) {
  const head = (
    <div class="m-row">
      <h2 id="m-an-cross" class="m-h2">
        カテゴリ × 事業/私用（{SIDE_LABELS[side]}）
      </h2>
      <span class="m-sub">押すと明細</span>
    </div>
  );
  if (cross.rows.length === 0) {
    return (
      <section class="m-card m-pad12 m-gap8" aria-labelledby="m-an-cross">
        {head}
        <p class="m-sub13">この期間の{SIDE_LABELS[side]}はありません。</p>
      </section>
    );
  }
  const cellBtn = (c: CrossCell, category: string | null | undefined, k: Col, label: string) => {
    if (c.amount <= 0) return <span class="m-an-zero">―</span>;
    const p = colPick(start, category, k);
    return (
      <button type="button" class="m-an-cell" aria-pressed={samePick(selected, p)} aria-label={`${label} ${COL_LABELS[k]} ${yen(c.amount)} 円 ${count(c.count)}。明細を見る`} onClick={() => onPick(p)}>
        <b>{yen(c.amount)}</b>
        <span>{count(c.count)}</span>
      </button>
    );
  };
  if (wide) {
    const cols: Col[] = [...TAG_ORDER, 'all'];
    return (
      <section class="m-card m-pad12 m-gap8" aria-labelledby="m-an-cross">
        {head}
        <table class="m-an-table">
          <thead>
            <tr>
              <th scope="col">カテゴリ</th>
              {cols.map((k) => (
                <th key={k} scope="col">
                  {COL_LABELS[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cross.rows.map((r) => {
              const label = categoryLabel(cats, r.category);
              return (
                <tr key={r.category ?? 'none'}>
                  <th scope="row">
                    <span class={`m-sw ${categoryColor(r.category)}`} />
                    {label}
                  </th>
                  {cols.map((k) => (
                    <td key={k}>{cellBtn(r.cells[k], r.category, k, label)}</td>
                  ))}
                </tr>
              );
            })}
            <tr class="m-an-sum">
              <th scope="row">計</th>
              {cols.map((k) => (
                <td key={k}>{cellBtn(cross.total[k], undefined, k, '計')}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </section>
    );
  }
  const total = cross.total[col];
  const rows = cross.rows.filter((r) => r.cells[col].amount > 0);
  return (
    <section class="m-card m-pad12 m-gap8" aria-labelledby="m-an-cross">
      {head}
      <div class="m-seg m-seg-4" role="group" aria-label="列">
        {COLS.map((k) => (
          <button type="button" key={k} aria-pressed={col === k} onClick={() => onCol(k)}>
            {COL_LABELS[k]}
          </button>
        ))}
      </div>
      {rows.length === 0 && <p class="m-sub13">{COL_LABELS[col]}の{SIDE_LABELS[side]}はありません。</p>}
      <ul class="m-an-list">
        {rows.map((r) => {
          const c = r.cells[col];
          const label = categoryLabel(cats, r.category);
          const p = colPick(start, r.category, col);
          const pct = share(c.amount, total.amount);
          return (
            <li key={r.category ?? 'none'}>
              <button type="button" class="m-an-row" aria-pressed={samePick(selected, p)} aria-label={`${label} ${COL_LABELS[col]} ${yen(c.amount)} 円 ${count(c.count)} ${pct}%。明細を見る`} onClick={() => onPick(p)}>
                <span class="m-an-name">
                  <span class={`m-sw ${categoryColor(r.category)}`} />
                  {label}
                </span>
                <b>{yen(c.amount)}</b>
                <span class="m-an-n">{count(c.count)}</span>
                <span class="m-an-pct">{pct}%</span>
                <ColBar cls={categoryColor(r.category)} pct={pct} />
              </button>
            </li>
          );
        })}
        {total.amount > 0 && (
          <li class="m-an-sum">
            <button type="button" class="m-an-row" aria-pressed={samePick(selected, colPick(start, undefined, col))} aria-label={`計 ${COL_LABELS[col]} ${yen(total.amount)} 円 ${count(total.count)}。明細を見る`} onClick={() => onPick(colPick(start, undefined, col))}>
              <span class="m-an-name">計</span>
              <b>{yen(total.amount)}</b>
              <span class="m-an-n">{count(total.count)}</span>
              <span class="m-an-pct">100%</span>
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

// ドリルダウンの題「2026 年 11 月 · 食費 · 事業 · 支出」。
export function pickTitle(p: Pick, periodText: string, side: Side, cats: Categories | null): string {
  return [periodText, p.category === undefined ? 'すべてのカテゴリ' : categoryLabel(cats, p.category), p.tag ? TAG_LABELS[p.tag] : null, SIDE_LABELS[side]].filter(Boolean).join(' · ');
}

export type Drill = { items: Txn[]; more: boolean; loading: boolean; msg: string };

// 明細の行（読むだけ。一覧の TxnRow と同じ見た目で、タグの切替は無い。直すのは「明細で開く」から）。
function DrillRow({ t, cats, today }: { t: Txn; cats: Categories | null; today: string }) {
  return (
    <li class="m-txn">
      <div class="m-txn-main">
        <span class="m-txn-top">
          <span class="m-txn-name">{t.description}</span>
          <span class={t.side === 'expense' ? 'm-amt m-amt-out' : 'm-amt m-amt-in'}>{signedYen(t.side, t.amount)}</span>
        </span>
        <span class="m-txn-meta">
          <span>{dayLabel(t.txn_date, today)}</span>
          <span>{t.account_name}</span>
          <span class="m-cat">{t.excluded && t.transfer_kind ? KIND_LABELS[t.transfer_kind] : categoryLabel(cats, t.category)}</span>
          <span class={`m-tag m-tag-${t.tag}`}>{TAG_LABELS[t.tag]}</span>
        </span>
      </div>
    </li>
  );
}

// ドリルダウンの一覧（最初の 1 ページ +「もっと見る」）。上に集計の金額と件数、下に「明細で開く」。
export function DrillList({ cell, drill, cats, today, onMore }: { cell: CrossCell; drill: Drill; cats: Categories | null; today: string; onMore: () => void }) {
  return (
    <>
      <div class="m-sumline">
        <span>集計 {count(cell.count)}</span>
        <span>
          合計 <b>{yen(cell.amount)}</b>
        </span>
      </div>
      {drill.msg && <p class="m-msg">{drill.msg}</p>}
      {drill.items.length > 0 && (
        <ul class="m-txns">
          {drill.items.map((t) => (
            <DrillRow key={t.id} t={t} cats={cats} today={today} />
          ))}
        </ul>
      )}
      {drill.loading ? (
        <p class="m-empty">読み込み中…</p>
      ) : drill.more ? (
        <button type="button" class="m-link m-link-center" onClick={onMore}>
          もっと見る
        </button>
      ) : (
        drill.items.length === 0 && !drill.msg && <p class="m-empty">明細はありません。</p>
      )}
    </>
  );
}

// PC の右の列。選ぶ前は案内だけ。
export function DrillPane({ title, children, onTxns }: { title: string | null; children?: ComponentChildren; onTxns: () => void }) {
  return (
    <aside class="m-card m-pad12 m-gap8 m-an-drill" aria-labelledby="m-an-drill">
      <h2 id="m-an-drill" class="m-h2">
        {title ?? '明細'}
      </h2>
      {title === null ? (
        <p class="m-sub13">推移の棒か表のセルを押すと、ここに明細が出ます。</p>
      ) : (
        <>
          {children}
          <button type="button" class="m-btn" onClick={onTxns}>
            明細で開く
          </button>
        </>
      )}
    </aside>
  );
}

// スマホのボトムシート（ドリルダウン・絞り込み）。
export function Sheet({ id, title, foot, children, onClose }: { id: string; title: string; foot?: ComponentChildren; children: ComponentChildren; onClose: () => void }) {
  return (
    <>
      <div class="m-scrim" onClick={onClose} />
      <section class="m-sheet" role="dialog" aria-modal="true" aria-labelledby={id}>
        <div class="m-grip" aria-hidden="true">
          <span />
        </div>
        <div class="m-sheet-head">
          <h2 id={id}>{title}</h2>
          <button type="button" class="m-icon" aria-label="閉じる" onClick={onClose}>
            <Icon name="close" size={22} />
          </button>
        </div>
        <div class="m-sheet-body">{children}</div>
        {foot && <div class="m-sheet-foot">{foot}</div>}
      </section>
    </>
  );
}

export type AnalysisProps = {
  wide: boolean;
  today: string;
  span: Span;
  // 基準の期間の最初の月（YYYY-MM）と表示
  start: string;
  label: string;
  canNext: boolean;
  side: Side;
  tag: '' | Tag;
  col: Col;
  cats: Categories | null;
  // 期間の合計・推移・クロス表（aggregate.ts で作ったもの）。読み込み中は null
  view: { totals: Totals; bars: TrendBar[]; cross: Cross } | null;
  msg: string;
  pick: Pick | null;
  pickTitle: string | null;
  pickCell: CrossCell | null;
  drill: Drill | null;
  filterOpen: boolean;
  onSpan: (s: Span) => void;
  onShift: (n: number) => void;
  onSide: (s: Side) => void;
  onTag: (t: '' | Tag) => void;
  onCol: (c: Col) => void;
  onPick: (p: Pick | null) => void;
  onBar: (start: string) => void;
  onMore: () => void;
  onTxns: () => void;
  onFilter: (open: boolean) => void;
};

// 画面全体（PC は 3 カラム: 左 = 期間・向き・タグ、中央 = 合計 → 推移 → クロス表、右 = ドリルダウン。スマホは 1 カラムで、上の帯に期間と絞り込み）。
export function AnalysisView(p: AnalysisProps) {
  const barSel = p.pick && p.pick.category === undefined && p.pick.tag === (p.tag || undefined) ? p.pick.start : null;
  const center = p.view ? (
    <>
      <TotalsCard t={p.view.totals} label={p.label} />
      <TrendChart bars={p.view.bars} side={p.side} cats={p.cats} selected={barSel} wide={p.wide} onPick={p.onBar} />
      <CrossTable cross={p.view.cross} start={p.start} side={p.side} cats={p.cats} col={p.col} selected={p.pick} wide={p.wide} onCol={p.onCol} onPick={p.onPick} />
    </>
  ) : (
    !p.msg && <p class="m-empty">読み込み中…</p>
  );
  const drill = p.pick && p.drill && p.pickCell ? <DrillList cell={p.pickCell} drill={p.drill} cats={p.cats} today={p.today} onMore={p.onMore} /> : null;
  const period = <PeriodSwitch span={p.span} label={p.label} canNext={p.canNext} onSpan={p.onSpan} onShift={p.onShift} />;
  const filters = <FilterControls side={p.side} tag={p.tag} onSide={p.onSide} onTag={p.onTag} />;
  if (p.wide) {
    return (
      <div class="m-an-cols">
        <div class="m-an-left m-card m-pad12 m-gap8">
          {period}
          {filters}
        </div>
        <div class="m-an-center">
          {p.msg && <p class="m-msg">{p.msg}</p>}
          {center}
        </div>
        <DrillPane title={p.pick ? p.pickTitle : null} onTxns={p.onTxns}>
          {drill}
        </DrillPane>
      </div>
    );
  }
  return (
    <>
      <div class="m-an-band">
        {period}
        <button type="button" class="m-pill" aria-haspopup="dialog" onClick={() => p.onFilter(true)}>
          <Icon name="filter" size={18} />
          {filterText(p.side, p.tag)}
        </button>
      </div>
      <div class="m-main">
        {p.msg && <p class="m-msg">{p.msg}</p>}
        {center}
      </div>
      {p.filterOpen && (
        <Sheet id="m-an-filter" title="絞り込み" onClose={() => p.onFilter(false)}>
          {filters}
        </Sheet>
      )}
      {drill && (
        <Sheet
          id="m-an-drill"
          title={p.pickTitle ?? '明細'}
          foot={
            <button type="button" class="m-btn m-btn-primary m-an-full" onClick={p.onTxns}>
              明細で開く
            </button>
          }
          onClose={() => p.onPick(null)}
        >
          {drill}
        </Sheet>
      )}
    </>
  );
}
