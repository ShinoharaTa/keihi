// 経費の一覧（docs/cashflow.md §15.1、GET /api/expenses?month）。上で月を切り替える（既定は今月、今月より先へは進めない）。
// 合計（経費・件数・領収書待ち）→「領収書待ちだけ」→ 相手ごとの行（件数・金額・待ち・カテゴリ）。行を押すとその月・その相手の明細へ
// （tag=business・side=expense・excluded=0・vendor_key。待ちだけのときは receipt=waiting も）。行の表示と操作は明細に任せ、ここは合計だけ。
// 「その他」（上位 50 の外。vendor_key = null）は相手で絞れないので押せない。月を速く切り替えたときは連番で古い応答を捨てる。
import { useEffect, useRef, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { Icon } from './Icons.tsx';
import { categoryLabel, expensesUrl, expenseVendors, failText, vendorFilter, waitingText, yen, type Categories, type Expenses as ExpensesData, type ExpenseVendor, type TxnFilter } from './model.ts';
import { ScreenHead, type Go } from './Money.tsx';
import { MonthBar } from './Monthly.tsx';

function VendorRow({ v, cats, onOpen }: { v: ExpenseVendor; cats: Categories | null; onOpen: (() => void) | null }) {
  const body = (
    <>
      <span class="m-nav-text">
        <span class="m-txn-top">
          <span class="m-txn-name">{v.label}</span>
          <span class="m-amt">{yen(v.amount)}</span>
        </span>
        <span class="m-txn-meta">
          <span>{v.count} 件</span>
          {v.category && <span class="m-cat">{categoryLabel(cats, v.category)}</span>}
          {v.waiting_count > 0 && <span class="m-rc m-rc-waiting">待ち {v.waiting_count}</span>}
        </span>
      </span>
      {onOpen && <Icon name="next" size={18} class="m-chev" />}
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button type="button" class="m-nav-row" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div class="m-nav-row">{body}</div>
      )}
    </li>
  );
}

export function ExpensesView({
  data,
  month,
  cats,
  waitingOnly,
  onWaiting,
  onTxns,
}: {
  data: ExpensesData;
  month: string;
  cats: Categories | null;
  waitingOnly: boolean;
  onWaiting: (v: boolean) => void;
  onTxns: (f: Partial<TxnFilter>) => void;
}) {
  const t = data.total;
  const rows = expenseVendors(data.vendors, waitingOnly);
  return (
    <>
      <section class="m-tiles3" aria-label={`${Number(month.slice(5, 7))} 月の経費`}>
        <div class="m-tile3">
          <span class="k-out">経費</span>
          <b>{yen(t.amount)}</b>
        </div>
        <div class="m-tile3">
          <span>件数</span>
          <b>{t.count} 件</b>
        </div>
        <div class="m-tile3">
          <span>領収書待ち</span>
          <b>{t.waiting_count} 件</b>
          <span class="m-sub13">{yen(t.waiting_amount)} 円</span>
        </div>
      </section>
      <div class="m-pills">
        <button type="button" class="m-pill m-pill-dashed" aria-pressed={waitingOnly} onClick={() => onWaiting(!waitingOnly)}>
          領収書待ちだけ（{t.waiting_count}）
        </button>
      </div>
      <section class="m-card m-pad12 m-gap6" aria-labelledby="m-vendors">
        <div class="m-row">
          <h2 id="m-vendors" class="m-h2">
            相手ごと
          </h2>
          <span class="m-sub">押すと明細</span>
        </div>
        {rows.length === 0 ? (
          <p class="m-empty">{waitingOnly ? waitingText(0) : 'この月の経費はありません。'}</p>
        ) : (
          <ul class="m-ledger">
            {rows.map((v) => {
              const f = vendorFilter(v, month, waitingOnly);
              return <VendorRow key={v.vendor_key ?? ''} v={v} cats={cats} onOpen={f ? () => onTxns(f) : null} />;
            })}
          </ul>
        )}
      </section>
    </>
  );
}

export function Expenses({ today, cats, initialWaiting, onBack, go }: { today: string; cats: Categories | null; initialWaiting?: boolean; onBack: () => void; go: Go }) {
  const cur = today.slice(0, 7);
  const [month, setMonth] = useState(cur);
  const [waitingOnly, setWaitingOnly] = useState(initialWaiting === true);
  const [data, setData] = useState<ExpensesData | null>(null);
  const [msg, setMsg] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    void (async () => {
      const r = await getJson<ExpensesData>(expensesUrl(month));
      if (n !== seq.current) return; // 後から別の月を選んだ
      setMsg(r.ok ? '' : failText(r.status, r.body));
      setData(r.ok ? r.data : null);
    })();
  }, [month]);

  return (
    <>
      <ScreenHead title="経費" onBack={onBack} />
      <MonthBar month={month} today={today} onSelect={(m) => setMonth(m > cur ? cur : m)} />
      <div class="m-main">
        {msg && <p class="m-msg">{msg}</p>}
        {data ? (
          <ExpensesView data={data} month={month} cats={cats} waitingOnly={waitingOnly} onWaiting={setWaitingOnly} onTxns={(filter) => go('txns', { filter })} />
        ) : (
          !msg && <p class="m-empty">読み込み中…</p>
        )}
      </div>
    </>
  );
}
