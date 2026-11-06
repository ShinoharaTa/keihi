// 資金繰り表（docs/mvp-plan-v3.md T304。GET /api/cashflow?months=36、src/cashflow/forecast.ts）。
// 上に起点残高・予定外支出の目安・残す額・最初に足りなくなる月と警告（口座名つきの文）。下に縦 36 行。
// 1 行は 2 段（上: 月・推定月末残高・余裕、下: 予定収入・予定支出）にして、横にスクロールさせない。行を押すとその月の予定の内訳。
import { useEffect, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { failText, warningText, yen, type Account, type Forecast } from './model.ts';

export const CASHFLOW_MONTHS = 36;

export function CashflowView({ cf, accounts, open, onOpen }: { cf: Forecast; accounts: Account[]; open: string | null; onOpen: (m: string | null) => void }) {
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  return (
    <>
      <dl class="status">
        <dt>起点残高</dt>
        <dd class="num-l">
          {yen(cf.opening_balance)} 円（{cf.as_of}）
        </dd>
        <dt>予定外支出</dt>
        <dd class="num-l">月 {yen(cf.unplanned_out_per_month)} 円の目安</dd>
        {cf.unplanned_in_per_month > 0 && (
          <>
            <dt>予定外収入</dt>
            <dd class="num-l">月 {yen(cf.unplanned_in_per_month)} 円の目安</dd>
          </>
        )}
        <dt>残す額</dt>
        <dd class="num-l">{yen(cf.reserve)} 円</dd>
        <dt>不足</dt>
        <dd class={cf.first_shortfall_month ? 'out' : ''}>{cf.first_shortfall_month ? `${cf.first_shortfall_month} に足りなくなります` : '36 か月の間は足ります'}</dd>
      </dl>
      {cf.warnings.map((w, i) => (
        <p class="msg" key={i}>
          {warningText(w, nameOf)}
        </p>
      ))}
      <div class="cf" aria-label="資金繰り表">
        <div class="cf-row cf-head">
          <span>月</span>
          <span class="num">
            推定月末残高
          </span>
          <span class="num">
            余裕
          </span>
        </div>
        {cf.months.map((m) => (
          <div key={m.month}>
            <button
              type="button"
             
              class={m.month === cf.first_shortfall_month ? 'cf-row cf-btn cf-short' : 'cf-row cf-btn'}
              aria-expanded={open === m.month}
              onClick={() => onOpen(open === m.month ? null : m.month)}
            >
              <span>{m.month}</span>
              <span class={m.balance_end < 0 ? 'num out' : 'num'}>
                {yen(m.balance_end)}
              </span>
              <span class={m.margin < 0 ? 'num out' : 'num'}>
                {yen(m.margin)}
              </span>
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
                  予定外の目安 −{yen(m.unplanned_out)}
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

export function Cashflow({ accounts }: { accounts: Account[] }) {
  const [cf, setCf] = useState<Forecast | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void (async () => {
      const r = await getJson<Forecast>(`/api/cashflow?months=${CASHFLOW_MONTHS}`);
      if (r.ok) setCf(r.data);
      else setMsg(failText(r.status));
    })();
  }, []);

  return (
    <>
      {msg && <p class="msg">{msg}</p>}
      {cf && <CashflowView cf={cf} accounts={accounts} open={open} onOpen={setOpen} />}
    </>
  );
}
