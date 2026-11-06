// 資金繰り表（docs/mvp-plan-v3.md T304。GET /api/cashflow?months=36、src/cashflow/forecast.ts）。
// 上から 警告（口座名つきの文。予定収入が 0 なら「収入を予定に追加」）→ 結論（足りなくなる月を大きく。押すとその行へ。
// 足りるならいちばん少ない月と金額）→ 起点残高 → 残す額 → 予定にない支出の目安。下に縦 36 行。
// 1 行は 2 段（上: 月・推定月末残高・残す額を引いた後、下: 予定収入・予定支出）にして、横にスクロールさせない。行を押すとその月の予定の内訳。
import { useEffect, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { failText, lowestMonth, noIncome, warningText, yen, type Account, type Forecast } from './model.ts';

export const CASHFLOW_MONTHS = 36;
export const NO_INCOME_WARNING = '収入の予定がないため、残高は減る一方の見通しです。';
const rowId = (m: string) => `cf-${m}`;

export function CashflowView({
  cf,
  accounts,
  open,
  onOpen,
  onAddIncome,
}: {
  cf: Forecast;
  accounts: Account[];
  open: string | null;
  onOpen: (m: string | null) => void;
  onAddIncome: () => void;
}) {
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const low = lowestMonth(cf);
  const short = cf.first_shortfall_month;
  const jump = (m: string) => {
    onOpen(m);
    document.getElementById(rowId(m))?.scrollIntoView({ block: 'center' });
  };
  return (
    <>
      {noIncome(cf) && (
        <div class="msg fields">
          <span>{NO_INCOME_WARNING}</span>
          <button type="button" class="btn" onClick={onAddIncome}>
            収入を予定に追加
          </button>
        </div>
      )}
      {cf.warnings.map((w, i) => (
        <p class="msg" key={i}>
          {warningText(w, nameOf)}
        </p>
      ))}
      {short ? (
        <button type="button" class="verdict out" onClick={() => jump(short)}>
          {short} に足りなくなります ▸
        </button>
      ) : (
        <p class="verdict">
          {CASHFLOW_MONTHS} か月の範囲で不足なし
          {low && <span class="sub verdict-sub">いちばん少ないのは {low.month} の {yen(low.balance_end)} 円</span>}
        </p>
      )}
      <dl class="status">
        <dt>起点残高</dt>
        <dd class="num-l">
          {yen(cf.opening_balance)} 円（{cf.as_of}）
        </dd>
        <dt>残す額</dt>
        <dd class="num-l">{yen(cf.reserve)} 円（今後の予定支出）</dd>
        <dt>予定にない支出</dt>
        <dd class="num-l">月 {yen(cf.unplanned_out_per_month)} 円（過去の中央値）</dd>
        {cf.unplanned_in_per_month > 0 && (
          <>
            <dt>予定にない収入</dt>
            <dd class="num-l">月 {yen(cf.unplanned_in_per_month)} 円（過去の中央値）</dd>
          </>
        )}
      </dl>
      <div class="cf" aria-label="資金繰り表">
        <div class="cf-row cf-head">
          <span>月</span>
          <span class="num">推定月末残高</span>
          <span class="num">残す額を引いた後</span>
        </div>
        {cf.months.map((m) => (
          <div key={m.month} id={rowId(m.month)}>
            <button
              type="button"
              class={m.month === short ? 'cf-row cf-btn cf-short' : 'cf-row cf-btn'}
              aria-expanded={open === m.month}
              onClick={() => onOpen(open === m.month ? null : m.month)}
            >
              <span>
                {open === m.month ? '▾' : '▸'} {m.month}
              </span>
              <span class={m.balance_end < 0 ? 'num out' : 'num'}>{yen(m.balance_end)}</span>
              <span class={m.margin < 0 ? 'num out' : 'num'}>{yen(m.margin)}</span>
              <span class="cf-sub num">
                予定 入 {yen(m.planned_in)} / 出 {yen(m.planned_out)}
              </span>
            </button>
            {open === m.month && (
              <ul class="cf-items">
                {m.items.length === 0 && <li class="sub">この月の予定はありません。</li>}
                {m.items.map((it) => (
                  <li key={`${it.id}-${it.due}`}>
                    <span class="txn-date">{it.due.slice(5).replace('-', '/')}</span>
                    <span class="item-name">{it.name}</span>
                    <span class={it.direction === 'out' ? 'num out' : 'num in'}>
                      {it.direction === 'out' ? '−' : '+'}
                      {yen(it.amount)}
                    </span>
                  </li>
                ))}
                <li class="sub">
                  予定にない支出の目安 −{yen(m.unplanned_out)}
                  {m.unplanned_in > 0 ? ` / +${yen(m.unplanned_in)}` : ''}・残す額 {yen(m.reserve)}
                </li>
              </ul>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function Cashflow({ accounts, onAddIncome }: { accounts: Account[]; onAddIncome: () => void }) {
  const [cf, setCf] = useState<Forecast | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void (async () => {
      const r = await getJson<Forecast>(`/api/cashflow?months=${CASHFLOW_MONTHS}`);
      if (r.ok) setCf(r.data);
      else setMsg(failText(r.status, r.body));
    })();
  }, []);

  return (
    <>
      {msg && <p class="msg">{msg}</p>}
      {cf && <CashflowView cf={cf} accounts={accounts} open={open} onOpen={setOpen} onAddIncome={onAddIncome} />}
    </>
  );
}
