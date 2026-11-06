// 月次（モック Monthly。GET /api/summary/monthly?from&to で、選んだ月で終わる 6 か月を読む）。上で月を切り替える（既定は締まった先月、今月より先へは進めない）。
// 収入 / 支出 / 差額 → カテゴリ別の横棒（6 か月平均の縦線と差。押すとその月・そのカテゴリの明細へ。未分類は最後に「n 件を分類する」）
// → 事業 / 私用 / 未設定の帯（未設定の明細へ）→ 集計に入れていないもの（振替・引落・チャージ）→ 6 か月の収支の棒（押すとその月へ）。
// 未分類・未設定の件数は GET /api/bank_txns?category=none / tag=unset（上限 100 件、超えたら「100+」）。月を速く切り替えたときは連番で古い応答を捨てる。
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { CatBar, SixMonthBars, StackBar } from './Charts.tsx';
import { Icon } from './Icons.tsx';
import {
  addMonth,
  categoryLabel,
  categoryRows,
  failText,
  KIND_LABELS,
  monthlyRangeUrl,
  periodRange,
  notableDiff,
  signed,
  tagShares,
  TAG_LABELS,
  UNCATEGORIZED_QUERY,
  yen,
  type Categories,
  type MonthlySummary,
  type TxnFilter,
  type TxnPage,
} from './model.ts';
import { ScreenHead, type Go } from './Money.tsx';

export type Count = { n: number; more: boolean } | null;
const countText = (c: Count) => (c ? `${c.n}${c.more ? '+' : ''}` : '');
const EX_LABELS = { ...KIND_LABELS, card_settlement: 'カード引落' };

export function MonthBar({ month, today, onSelect }: { month: string; today: string; onSelect: (m: string) => void }) {
  const cur = today.slice(0, 7);
  const prev = addMonth(month, -1);
  const next = addMonth(month, 1);
  const mn = (m: string) => Number(m.slice(5, 7));
  return (
    <div class="m-monthbar">
      <button type="button" class="m-icon" aria-label={`前の月（${mn(prev)} 月）`} onClick={() => onSelect(prev)}>
        <Icon name="back" size={22} />
      </button>
      <div class="m-monthbar-label">
        <b>
          {month.slice(0, 4)} 年 {mn(month)} 月
        </b>
        <span class="m-sub">{month === cur ? '途中' : '締まった月'}</span>
      </div>
      <button type="button" class="m-icon" aria-label={`次の月（${mn(next)} 月${next === cur ? '・途中' : ''}）`} disabled={month >= cur} onClick={() => onSelect(next)}>
        <Icon name="next" size={22} />
      </button>
    </div>
  );
}

export function MonthlyView({
  months,
  selected,
  cats,
  uncat,
  unset,
  onSelect,
  onTxns,
}: {
  months: MonthlySummary[];
  selected: string;
  cats: Categories | null;
  uncat: Count;
  unset: Count;
  onSelect: (m: string) => void;
  onTxns: (f: Partial<TxnFilter>) => void;
}) {
  const cur = months.find((m) => m.month === selected) ?? null;
  if (!cur) return <p class="m-empty">この月の集計はありません。</p>;
  const mn = Number(selected.slice(5, 7));
  const all = categoryRows(months, selected);
  const rows = all.filter((r) => r.category !== null && r.expense > 0);
  const none = all.find((r) => r.category === null) ?? null;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.expense, r.expense - r.diff)));
  const shares = tagShares(cur);
  const shareTotal = shares.reduce((a, s) => a + s.expense, 0);
  const open = (f: Partial<TxnFilter>) => onTxns({ period: 'month', month: selected, ...f });
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  return (
    <>
      <section class="m-tiles3" aria-label={`${mn} 月の合計`}>
        <div class="m-tile3">
          <span class="k-in">収入</span>
          <b>{yen(cur.total.income)}</b>
        </div>
        <div class="m-tile3">
          <span class="k-out">支出</span>
          <b>{yen(cur.total.expense)}</b>
        </div>
        <div class="m-tile3">
          <span>差額</span>
          <b>{yen(cur.total.net)}</b>
        </div>
      </section>

      <section class="m-card m-pad12 m-gap6" aria-labelledby="m-cat">
        <div class="m-row">
          <h2 id="m-cat" class="m-h2">
            カテゴリ別の支出
          </h2>
          <span class="m-sub">押すと明細</span>
        </div>
        <div class="m-legend" aria-hidden="true">
          <span>
            <span class="m-sw sw-out" />
            {mn} 月
          </span>
          <span>
            <span class="m-sw sw-avg" />
            {months.length} か月平均
          </span>
          <span>右端は平均との差</span>
        </div>
        {rows.length === 0 && !none && <p class="m-sub13">この月の支出はありません。</p>}
        {rows.map((r) => {
          const strong = notableDiff(r);
          const label = categoryLabel(cats, r.category);
          return (
            <button
              type="button"
              key={r.category}
              class="m-catrow"
              aria-label={`${label} ${yen(r.expense)} 円、平均との差 ${signed(r.diff)} 円。明細を見る`}
              onClick={() => open({ category: r.category! })}
            >
              <span class={strong ? 'strong' : ''}>{label}</span>
              <CatBar value={r.expense} avg={r.expense - r.diff} max={max} />
              <span class={strong ? 'v strong' : 'v'}>{yen(r.expense)}</span>
              <span class={`d${r.diff > 0 ? ' up' : r.diff < 0 ? ' down' : ''}${strong ? ' strong' : ''}`}>{r.diff === 0 ? '±0' : signed(r.diff)}</span>
            </button>
          );
        })}
        {(none || (uncat && uncat.n > 0)) && (
          <button type="button" class="m-catrow m-catrow-uncat" onClick={() => open({ category: UNCATEGORIZED_QUERY })}>
            <span>{categoryLabel(cats, null)}</span>
            <span class="cta">{uncat && uncat.n > 0 ? `${countText(uncat)} 件を分類する` : '分類する'}</span>
            <span class="v">{yen(none?.expense ?? 0)}</span>
            <span class="d">―</span>
          </button>
        )}
      </section>

      <section class="m-card m-pad12 m-gap8" aria-labelledby="m-tag">
        <h2 id="m-tag" class="m-h2">
          事業 / 私用
        </h2>
        <StackBar
          tall
          parts={[
            { cls: 'f-biz', pct: shares[0]!.pct },
            { cls: 'f-priv', pct: shares[1]!.pct },
            { cls: 'f-unset', pct: shares[2]!.pct },
          ]}
          label={`支出 ${yen(shareTotal)} 円のうち ${shares.map((s) => `${TAG_LABELS[s.tag]} ${yen(s.expense)} 円`).join('、')}`}
        />
        <dl class="m-dl3">
          {shares.map((s) => (
            <Fragment key={s.tag}>
              <dt>
                <span class={`m-sw sw-${s.tag === 'business' ? 'biz' : s.tag === 'private' ? 'priv' : 'unset'}`} />
                {TAG_LABELS[s.tag]}
              </dt>
              <dd>{yen(s.expense)}</dd>
              <dd>{Math.round(s.pct)}%</dd>
            </Fragment>
          ))}
        </dl>
        {(shares[2]!.expense > 0 || (unset && unset.n > 0)) && (
          <button type="button" class="m-btn m-btn-start" onClick={() => open({ tag: 'unset' })}>
            未設定{unset && unset.n > 0 ? `の ${countText(unset)} 件` : ''}をタグ付け
          </button>
        )}
      </section>

      {cur.excluded.length > 0 && (
        <section class="m-card m-pad12 m-gap8" aria-labelledby="m-excl">
          <h2 id="m-excl" class="m-h2">
            集計に入れていないもの
          </h2>
          <p class="m-sub13">口座どうしの移動は、二重に数えないよう収入にも支出にも入れていません。</p>
          {cur.excluded.map((r) => (
            <div key={r.kind} class="m-exrow">
              <span>
                {EX_LABELS[r.kind]}
                <span class="m-sub13"> · {r.count} 件</span>
              </span>
              <span>{yen(Math.max(r.expense, r.income))}</span>
            </div>
          ))}
        </section>
      )}

      <section class="m-card m-pad12 m-gap6" aria-labelledby="m-six">
        <div class="m-row">
          <h2 id="m-six" class="m-h2">
            {months.length} か月の収支
          </h2>
          <span class="m-legend" aria-hidden="true">
            <span>
              <span class="m-sw sw-in" />
              収入
            </span>
            <span>
              <span class="m-sw sw-out" />
              支出
            </span>
          </span>
        </div>
        <SixMonthBars months={sorted.map((m) => ({ month: m.month, income: m.total.income, expense: m.total.expense }))} selected={selected} onSelect={onSelect} />
        <p class="m-sub">棒を押すとその月に切り替わります。</p>
      </section>
    </>
  );
}

const countOf = (r: { ok: true; data: TxnPage } | { ok: false }): Count => (r.ok ? { n: r.data.items.length, more: r.data.next_cursor !== null } : null);

export function Monthly({ today, cats, initialMonth, onBack, go }: { today: string; cats: Categories | null; initialMonth?: string; onBack: () => void; go: Go }) {
  const cur = today.slice(0, 7);
  const [selected, setSelected] = useState(() => (initialMonth && initialMonth <= cur ? initialMonth : addMonth(cur, -1)));
  const [data, setData] = useState<{ months: MonthlySummary[]; uncat: Count; unset: Count } | null>(null);
  const [msg, setMsg] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    void (async () => {
      const r = periodRange('month', today, selected);
      const range = `from=${r.from}&to=${r.to}`;
      const [m, c, t] = await Promise.all([
        getJson<{ months: MonthlySummary[] }>(monthlyRangeUrl(selected)),
        getJson<TxnPage>(`/api/bank_txns?${range}&category=${UNCATEGORIZED_QUERY}&limit=100`),
        getJson<TxnPage>(`/api/bank_txns?${range}&tag=unset&limit=100`),
      ]);
      if (n !== seq.current) return; // 後から別の月を選んだ
      if (!m.ok) {
        setMsg(failText(m.status, m.body));
        setData(null);
        return;
      }
      setMsg('');
      setData({ months: m.data.months, uncat: countOf(c), unset: countOf(t) });
    })();
  }, [selected, today]);

  const select = (m: string) => setSelected(m > cur ? cur : m);
  return (
    <>
      <ScreenHead title="月次" onBack={onBack} />
      <MonthBar month={selected} today={today} onSelect={select} />
      <div class="m-main">
        {msg && <p class="m-msg">{msg}</p>}
        {data ? (
          <MonthlyView months={data.months} selected={selected} cats={cats} uncat={data.uncat} unset={data.unset} onSelect={select} onTxns={(filter) => go('txns', { filter })} />
        ) : (
          !msg && <p class="m-empty">読み込み中…</p>
        )}
      </div>
    </>
  );
}
