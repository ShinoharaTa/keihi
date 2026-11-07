// 見通し（モック Forecast。GET /api/cashflow?months=36、src/cashflow/forecast.ts）。台帳（GET /api/scheduled_items?all=1）で予定の分類を引く。
// 上から 結論（不足する月 / 足りる。cut_per_month_to_survive があれば「月 n 円減らせば足りる」）→ 警告 → 36 か月の折れ線（残す額の帯・足りない期間・
// 税金・保険・車の印。押すとその月の行へ）→ 計算の前提 → 月ごとの行（年ごとに折りたたむ。1 年目だけ開く。税・保険の見積もりの項目に「 · 見積」）。
import { useEffect, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { ForecastChart } from './Charts.tsx';
import { Icon } from './Icons.tsx';
import {
  failText,
  flatIncome,
  itemInfoMap,
  monthMarks,
  noIncome,
  verdict,
  warningText,
  yearGroups,
  yearSummary,
  yen,
  type Account,
  type Forecast,
  type ItemInfo,
  type MonthMarks,
  type ScheduledItem,
  type YearGroup,
} from './model.ts';
import { ScreenHead, type Go } from './Money.tsx';

export const CASHFLOW_MONTHS = 36;
export const NO_INCOME_WARNING = '収入の予定がないため、残高は減る一方の見通しです。';
const rowId = (m: string) => `m-f-${m}`;

function YearBlock({ g, marks, flat, open, onToggle }: { g: YearGroup; marks: MonthMarks[]; flat: boolean; open: boolean; onToggle: () => void }) {
  const short = g.shortCount > 0;
  return (
    <div class={`m-year${short ? ' m-year-short' : ''}${open ? ' m-year-open' : ''}`}>
      <button type="button" class="m-yearbtn" aria-expanded={open} onClick={onToggle}>
        <span>
          <b>
            {g.index + 1} 年目 {g.from}〜{g.to}
          </b>
          <span class={short ? 'm-sub m-warn-text t-b' : 'm-sub'}>{yearSummary(g)}</span>
        </span>
        <Icon name="next" size={18} class={open ? 'm-chev m-chev-open' : 'm-chev'} />
      </button>
      {open && (
        <ul class="m-frows">
          {g.months.map((m) => {
            const mk = marks.find((x) => x.month === m.month);
            return (
              <li key={m.month} id={rowId(m.month)} class={m.margin < 0 ? 'm-frow m-frow-short' : 'm-frow'}>
                <div class="m-frow-top">
                  <b>{m.month}</b>
                  {mk?.names.map((n) => (
                    <span key={`${n.category}-${n.name}`} class="m-mk">
                      <span class={`mk mk-${n.category}`} />
                      {n.name}
                      {n.estimate ? ' · 見積' : ''} {yen(n.amount)}
                    </span>
                  ))}
                  <span class={m.balance_end < 0 ? 'm-frow-bal m-warn-text' : 'm-frow-bal'}>{yen(m.balance_end)}</span>
                </div>
                <div class="m-frow-sub">
                  {!flat && m.planned_in > 0 && <span>収入 +{yen(m.planned_in)}</span>}
                  <span>予定 −{yen(m.planned_out)}</span>
                  <span>目安 −{yen(m.unplanned_out)}</span>
                  {m.unplanned_in > 0 && <span>目安 +{yen(m.unplanned_in)}</span>}
                  <span class={m.margin < 0 ? 'end m-warn-text t-b' : 'end'}>余裕 {yen(m.margin)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function CashflowView({
  cf,
  info,
  accounts,
  openYears,
  onToggleYear,
  onJump,
  onMonthly,
  onSchedule,
  onAddIncome,
}: {
  cf: Forecast;
  info: Record<string, ItemInfo>;
  accounts: Account[];
  openYears: number[];
  onToggleYear: (i: number) => void;
  onJump: (month: string) => void;
  onMonthly: () => void;
  onSchedule: () => void;
  onAddIncome: () => void;
}) {
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const v = verdict(cf);
  const marks = monthMarks(cf.months, info);
  const flat = flatIncome(cf.months);
  const biggest = marks.flatMap((m) => m.names.map((n) => ({ ...n, month: m.month }))).sort((a, b) => b.amount - a.amount)[0];
  const short = cf.first_shortfall_month;
  return (
    <>
      <section class={v.short ? 'm-card m-verdict' : 'm-card m-verdict m-verdict-ok'} aria-labelledby="m-verdict">
        <div class="m-verdict-head">
          {v.short && <Icon name="warn" size={22} class="m-warn-icon" />}
          <div>
            <h2 id="m-verdict">{v.title}</h2>
            {v.detail && <p class="m-fs14">{v.detail}</p>}
          </div>
        </div>
        {v.cut && <p class="m-cut">{v.cut}</p>}
        <div class="m-btnrow">
          {short && (
            <button type="button" class="m-btn m-btn-warn" onClick={() => onJump(short)}>
              {short} の行へ
            </button>
          )}
          <button type="button" class="m-btn" onClick={onMonthly}>
            支出の内訳を見る
          </button>
        </div>
      </section>

      {noIncome(cf) && (
        <div class="m-msg m-col">
          <span>{NO_INCOME_WARNING}</span>
          <button type="button" class="m-btn m-btn-start" onClick={onAddIncome}>
            収入を予定に追加
          </button>
        </div>
      )}
      {cf.warnings.map((w, i) => (
        <p class="m-msg" key={i}>
          {warningText(w, nameOf)}
        </p>
      ))}

      <section class="m-card m-gap6 m-pad-chart" aria-labelledby="m-fchart">
        <h2 id="m-fchart" class="m-h2 m-px4">
          推定の月末残高
        </h2>
        <div class="m-legend m-px4" aria-hidden="true">
          <span>
            <span class="m-sw sw-line" />
            月末残高
          </span>
          <span>
            <span class="m-sw sw-reserve" />
            残す額
          </span>
          <span>
            <span class="m-sw sw-short" />
            足りない期間
          </span>
        </div>
        <ForecastChart months={cf.months} marks={marks} shortfall={short} onPick={onJump} />
        <div class="m-btnrow m-px4" role="group" aria-label="年ごとの行へ移る">
          {yearGroups(cf.months).map((g) => (
            <button type="button" key={g.index} class={g.shortCount > 0 ? 'm-btn m-btn-warn' : 'm-btn'} onClick={() => onJump(g.from)}>
              {g.index + 1} 年目の行へ
            </button>
          ))}
        </div>
        <p class="m-sub m-px4">
          下の 3 段は予定の大きな支出。大きい印ほど金額が大きい{biggest ? `（最大は ${biggest.month} の${biggest.name} ${yen(biggest.amount)}）` : ''}。グラフか下のボタンを押すとその行へ移ります。
        </p>
      </section>

      <section class="m-card m-gap6 m-pad-basis" aria-labelledby="m-basis">
        <h2 id="m-basis" class="m-h2 m-fs14">
          計算の前提
        </h2>
        <dl class="m-dl m-dl-sm">
          <dt>起点の残高（{cf.as_of}）</dt>
          <dd>{yen(cf.opening_balance)}</dd>
          <dt>収入（予定）</dt>
          <dd>{flat !== null ? `毎月 ${yen(flat)}` : noIncome(cf) ? 'なし' : '月ごとに違う'}</dd>
          <dt>予定にない支出の目安（過去の中央値）</dt>
          <dd>月 {yen(cf.unplanned_out_per_month)}</dd>
          {cf.unplanned_in_per_month > 0 && (
            <>
              <dt>予定にない収入の目安</dt>
              <dd>月 {yen(cf.unplanned_in_per_month)}</dd>
            </>
          )}
          <dt>残す額（この先の予定支出）</dt>
          <dd>{yen(cf.reserve)}</dd>
        </dl>
        <button type="button" class="m-link" onClick={onSchedule}>
          予定を見直す
        </button>
      </section>

      <section class="m-col" aria-labelledby="m-rows">
        <div class="m-row m-px4">
          <h2 id="m-rows" class="m-h2">
            月ごと
          </h2>
          {flat !== null && <span class="m-sub">収入は毎月 {yen(flat)} のため省略</span>}
        </div>
        {yearGroups(cf.months).map((g) => (
          <YearBlock key={g.index} g={g} marks={marks} flat={flat !== null} open={openYears.includes(g.index)} onToggle={() => onToggleYear(g.index)} />
        ))}
      </section>
    </>
  );
}

export function Cashflow({ accounts, focus, onBack, go }: { accounts: Account[]; focus?: string; onBack: () => void; go: Go }) {
  const [cf, setCf] = useState<Forecast | null>(null);
  const [info, setInfo] = useState<Record<string, ItemInfo>>({});
  const [openYears, setOpenYears] = useState<number[]>([0]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void (async () => {
      const [r, s] = await Promise.all([getJson<Forecast>(`/api/cashflow?months=${CASHFLOW_MONTHS}`), getJson<{ items: ScheduledItem[] }>('/api/scheduled_items?all=1')]);
      if (s.ok) setInfo(itemInfoMap(s.data.items));
      if (r.ok) setCf(r.data);
      else setMsg(failText(r.status, r.body));
    })();
  }, []);

  const jump = (month: string) => {
    if (!cf) return;
    const i = Math.floor(cf.months.findIndex((m) => m.month === month) / 12);
    if (i < 0) return;
    setOpenYears((o) => (o.includes(i) ? o : [...o, i]));
    requestAnimationFrame(() => document.getElementById(rowId(month))?.scrollIntoView({ block: 'center' }));
  };

  useEffect(() => {
    if (cf && focus) jump(focus);
  }, [cf]);

  const first = cf?.months[0]?.month;
  const last = cf?.months[cf.months.length - 1]?.month;
  return (
    <>
      <ScreenHead title="見通し" sub={cf && first ? `${cf.months.length} か月 · ${first}〜${last}` : undefined} onBack={onBack} />
      <div class="m-main">
        {msg && <p class="m-msg">{msg}</p>}
        {cf ? (
          <CashflowView
            cf={cf}
            info={info}
            accounts={accounts}
            openYears={openYears}
            onToggleYear={(i) => setOpenYears((o) => (o.includes(i) ? o.filter((x) => x !== i) : [...o, i]))}
            onJump={jump}
            onMonthly={() => go('monthly')}
            onSchedule={() => go('schedule')}
            onAddIncome={() => go('schedule', { add: 'in' })}
          />
        ) : (
          !msg && <p class="m-empty">読み込み中…</p>
        )}
      </div>
    </>
  );
}
