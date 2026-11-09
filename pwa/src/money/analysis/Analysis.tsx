// 分析の画面（#74）の殻。hooks はここだけで、描画は parts.tsx の AnalysisView、計算は aggregate.ts。
// 状態: 期間の種類（月 / 四半期 / 年）・基準の期間（既定は今月 / 今四半期 / 今年。initialMonth があればその月を含む期間）・向き（既定は支出）・
// タグの絞り込み・スマホのクロス表の列・選んだ所（ドリルダウン）。口座の絞り込みは月次集計に口座の引数が無いので出さない。
// 月次集計は GET /api/summary/monthly?from&to を 1 回（推移の 12 本分。最大 36 か月 = API の上限）。期間の種類か基準を変えたら読み直し、
// 向き・タグは読んだ分から作り直す。ドリルダウンは GET /api/bank_txns（excluded=0）の最初の 1 ページ +「もっと見る」。応答は連番で古いものを捨てる。
// 「明細で開く」は明細の画面へ同じ期間・カテゴリ・タグ・向きで移る（Money の go('txns', {filter})）。
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getJson } from '../../api.ts';
import { failText, type Categories, type MonthlySummary, type Tag, type TxnPage } from '../model.ts';
import { ScreenHead, type Go } from '../Money.tsx';
import { useWide } from '../useWide.ts';
import {
  crossTable,
  drillUrl,
  fetchRange,
  periodLabel,
  periodStart,
  pickCell,
  shiftPeriod,
  slice,
  summaryUrl,
  totals,
  trend,
  txnsFilter,
  type Col,
  type Pick,
  type Side,
  type Span,
} from './aggregate.ts';
import { AnalysisView, pickTitle, type Drill } from './parts.tsx';

export function Analysis({ today, cats, initialMonth, backLabel, onBack, go }: { today: string; cats: Categories | null; initialMonth?: string; backLabel?: string; onBack: () => void; go: Go }) {
  const cur = today.slice(0, 7);
  const wide = useWide();
  const [span, setSpan] = useState<Span>('month');
  const [anchor, setAnchor] = useState(() => (initialMonth && initialMonth <= cur ? initialMonth : cur));
  const [side, setSide] = useState<Side>('expense');
  const [tag, setTag] = useState<'' | Tag>('');
  const [col, setCol] = useState<Col>('all');
  const [months, setMonths] = useState<MonthlySummary[] | null>(null);
  const [msg, setMsg] = useState('');
  const [pick, setPick] = useState<Pick | null>(null);
  const [drill, setDrill] = useState<(Drill & { cursor: string | null }) | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const seq = useRef(0);
  const drillSeq = useRef(0);

  const start = periodStart(span, anchor);
  const canNext = shiftPeriod(span, start, 1) <= cur;

  useEffect(() => {
    const n = ++seq.current;
    setMonths(null);
    void (async () => {
      const r = await getJson<{ months: MonthlySummary[] }>(summaryUrl(fetchRange(span, start, today)));
      if (n !== seq.current) return; // 後から別の期間を選んだ
      if (!r.ok) {
        setMsg(failText(r.status, r.body));
        return;
      }
      setMsg('');
      setMonths(r.data.months);
    })();
  }, [span, start, today]);

  const view = useMemo(() => {
    if (!months) return null;
    const s = slice(months, span, start);
    return { slice: s, totals: totals(s.rows, tag), bars: trend(months, span, start, side, tag), cross: crossTable(s.rows, side) };
  }, [months, span, start, side, tag]);

  const loadDrill = async (p: Pick, cursor: string | null) => {
    const n = ++drillSeq.current;
    setDrill((d) => (cursor && d ? { ...d, loading: true } : { items: [], more: false, loading: true, msg: '', cursor: null }));
    const r = await getJson<TxnPage>(drillUrl(span, p, side, cursor));
    if (n !== drillSeq.current) return;
    if (!r.ok) {
      setDrill((d) => ({ items: d?.items ?? [], more: false, loading: false, msg: failText(r.status, r.body), cursor: null }));
      return;
    }
    setDrill((d) => ({ items: [...(cursor ? (d?.items ?? []) : []), ...r.data.items], more: r.data.next_cursor !== null, loading: false, msg: '', cursor: r.data.next_cursor }));
  };

  // 選んだ所を変える（null は閉じる）。期間・向きが変わったら外す。
  const choose = (p: Pick | null) => {
    setPick(p);
    if (p) void loadDrill(p, null);
    else {
      drillSeq.current++;
      setDrill(null);
    }
  };
  const reset = () => choose(null);

  // 推移の棒は「その期間・今のタグの絞り込み・全カテゴリ」。基準の期間は変えない。
  const onBar = (s: string) => choose({ start: s, ...(tag ? { tag } : {}) });
  const label = periodLabel(span, start);
  const barLabel = (s: string) => (view?.bars.find((b) => b.start === s)?.label ?? periodLabel(span, s));
  const rowsOf = (s: string) => (s === start ? view?.slice.rows : months ? slice(months, span, s).rows : undefined) ?? [];

  return (
    <div class={wide ? 'm-an m-wide' : 'm-an'}>
      <ScreenHead title="分析" backLabel={backLabel} onBack={onBack} />
      <AnalysisView
        wide={wide}
        today={today}
        span={span}
        start={start}
        label={view?.slice.label ?? label}
        canNext={canNext}
        side={side}
        tag={tag}
        col={col}
        cats={cats}
        view={view}
        msg={msg}
        pick={pick}
        pickTitle={pick ? pickTitle(pick, barLabel(pick.start), side, cats) : null}
        pickCell={pick ? pickCell(rowsOf(pick.start), pick, side) : null}
        drill={drill}
        filterOpen={filterOpen}
        onSpan={(s) => {
          setSpan(s);
          reset();
        }}
        onShift={(n) => {
          const next = shiftPeriod(span, start, n);
          if (next > cur) return;
          setAnchor(next);
          reset();
        }}
        onSide={(s) => {
          setSide(s);
          reset();
        }}
        onTag={(t) => {
          setTag(t);
          reset();
        }}
        onCol={setCol}
        onPick={choose}
        onBar={onBar}
        onMore={() => pick && drill?.cursor && void loadDrill(pick, drill.cursor)}
        onTxns={() => pick && go('txns', { filter: txnsFilter(span, pick, side) })}
        onFilter={setFilterOpen}
      />
    </div>
  );
}
