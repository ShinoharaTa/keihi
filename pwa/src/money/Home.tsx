// お金のホーム（モック Main）。上から 今日使えるお金（残高合計 − 残す額）→ 今月の進み（収入と、支出の 済み / 予定の残り / 目安 の帯、月末の見込み残高）
// → 残高の推移（直近 12 か月の折れ線）→ 確認すること（引落元が未設定のカード・提案・未設定の明細・収入の予定なし）→ 各画面への入口（状態を 1 行）。
// GET /api/bank/overview と /api/balance_history は追加中: overview が無ければ資金繰り・月次・口座から代わりを作り（overviewFallback）、推移が無ければ隠す。
// ヘッダの同期ボタンは POST /api/bank/sync（created:false は 10 分以内に実行済み）。
import { useEffect, useState } from 'preact/hooks';
import { getJson, postJson } from '../api.ts';
import { BalanceTrend, StackBar } from './Charts.tsx';
import { Icon } from './Icons.tsx';
import {
  addMonth,
  balanceSeries,
  cardUsage,
  dayOfMonth,
  failText,
  incomeAhead,
  incomePct,
  md,
  monthlyLine,
  notices,
  overviewFallback,
  shortTime,
  spendBand,
  syncErrorCount,
  syncText,
  verdict,
  waitingText,
  yen,
  type Account,
  type BalanceHistory,
  type BankStatus,
  type Candidate,
  type Categories,
  type Forecast,
  type MonthlySummary,
  type Notice,
  type Overview,
  type TxnPage,
  type Upcoming,
  pageCount,
} from './model.ts';
import type { Go } from './Money.tsx';

export type HomeData = {
  o: Overview | null;
  history: BalanceHistory | null;
  cf: Forecast | null;
  months: MonthlySummary[];
  upcoming: Upcoming[];
  status: BankStatus[];
};

const Chev = () => <Icon name="next" size={18} class="m-chev" />;

function NoticeItem({ n, go }: { n: Notice; go: Go }) {
  if (n.kind === 'card_settlement') {
    return (
      <div class="m-warn">
        <Icon name="warn" class="m-warn-icon" />
        <div class="m-col m-tile-text">
          <p>
            <b>{n.name} の引落の設定が済んでいません</b>
            <br />
            <span class="m-sub13">カードの利用と銀行の引落が両方とも支出に入り、二重に数えています。</span>
          </p>
          <button type="button" class="m-btn m-btn-warn m-btn-start" onClick={() => go('accounts', { account: n.accountId })}>
            引落元を設定
          </button>
        </div>
      </div>
    );
  }
  const t =
    n.kind === 'candidates'
      ? { title: `定期の支払いが ${n.count} 件見つかりました`, sub: '予定に入れると見通しに反映されます', on: () => go('schedule') }
      : n.kind === 'untagged'
        ? { title: `事業/私用が未設定の明細が ${n.count}${n.more ? '+' : ''} 件`, sub: '押すと未設定だけを出します', on: () => go('txns', { filter: { period: 'all', tag: 'unset' } }) }
        : { title: '収入の予定がありません', sub: '入れないと見通しは減る一方になります', on: () => go('schedule', { add: 'in' }) };
  return (
    <button type="button" class="m-tile" onClick={t.on}>
      <Icon name="found" class="m-accent-icon" />
      <span class="m-tile-text">
        <b>{t.title}</b>
        <br />
        <span class="m-sub13">{t.sub}</span>
      </span>
      <Chev />
    </button>
  );
}

function NavRow({ title, sub, warn, count, onClick }: { title: string; sub: string; warn?: boolean; count?: string; onClick: () => void }) {
  return (
    <button type="button" class="m-nav-row" onClick={onClick}>
      <span class="m-nav-text">
        <span class="m-nav-title">{title}</span>
        <span class={warn ? 'm-nav-sub m-warn-text' : 'm-nav-sub'}>{sub}</span>
      </span>
      {count && <span class="m-count">{count}</span>}
      <Chev />
    </button>
  );
}

export function HomeView({ today, d, accounts, cats, go }: { today: string; d: HomeData; accounts: Account[]; cats: Categories | null; go: Go }) {
  const { o, cf } = d;
  const month = today.slice(0, 7);
  const last = addMonth(month, -1);
  const day = dayOfMonth(today);
  const band = o ? spendBand(o.this_month) : null;
  const inc = incomeAhead(cf, month);
  const expected = (o?.this_month.income ?? 0) + inc.total;
  const cardsUsed = Object.values(cardUsage(accounts, d.months.find((m) => m.month === month))).reduce((x, y) => x + y, 0);
  const ns = o ? notices(o, cf) : [];
  const v = cf ? verdict(cf) : null;
  const next = d.upcoming[0] ?? null;
  const errors = d.status.filter((s) => s.last_error).length;
  const csv = accounts.filter((a) => a.active && a.source === 'csv');
  const acctLine = [
    `${accounts.filter((a) => a.active).length} 口座`,
    errors > 0 ? `同期エラー ${errors} 件` : null,
    ...csv.map((a) => {
      const at = d.status.find((s) => s.account_id === a.id)?.last_csv_at ?? a.sync_status?.last_csv_at ?? null;
      return at ? `${a.name} の CSV は ${md(at.slice(0, 10))} が最後` : `${a.name} は CSV 未取り込み`;
    }),
  ]
    .filter(Boolean)
    .join('・');
  const untagged = o?.untagged_count ?? 0;
  const untaggedText = `${untagged}${o?.untagged_more ? '+' : ''}`;
  const waiting = o?.receipt_waiting_count ?? 0;
  const trend = d.history ? balanceSeries(d.history.months) : [];
  return (
    <>
      {o ? (
        <section class="m-card" aria-labelledby="m-avail">
          <div class="m-col m-gap2">
            <h2 id="m-avail" class="m-h2-sub">
              今日使えるお金
            </h2>
            <p class="m-big">
              {yen(o.available)}
              <small>円</small>
            </p>
          </div>
          <dl class="m-dl">
            <dt>残高の合計（{o.balances.by_account.filter((b) => b.balance !== null).length} 口座）</dt>
            <dd>{yen(o.balances.total)}</dd>
            <dt>残す額（この先の予定支出）</dt>
            <dd>− {yen(o.reserve)}</dd>
          </dl>
          {cardsUsed > 0 && <p class="m-note">カードの今月の利用 {yen(cardsUsed)} 円はまだ残高から引かれていません。</p>}
        </section>
      ) : (
        <p class="m-msg">残高を読めませんでした。口座の同期を確かめてください。</p>
      )}

      {o && band && (
        <section class="m-card m-gap14" aria-labelledby="m-thismonth">
          <div class="m-row">
            <h2 id="m-thismonth" class="m-h2">
              {Number(month.slice(5, 7))} 月の進み
            </h2>
            <span class="m-sub">
              {day.day} 日目 / {day.days} 日
            </span>
          </div>
          <div class="m-col m-gap6">
            <div class="m-row m-num m-fs14">
              <span>
                <span class="m-sw sw-in" />
                収入
              </span>
              <span>
                <b>{yen(o.this_month.income)}</b>
                <span class="m-sub13"> / 見込み {yen(expected)}</span>
              </span>
            </div>
            <StackBar parts={[{ cls: 'f-in', pct: incomePct(o.this_month.income, expected) }]} label={`収入 ${yen(o.this_month.income)} 円、見込み ${yen(expected)} 円`} />
            {inc.first && (
              <span class="m-sub">
                {md(inc.first.due)} に「{inc.first.name}」の入金予定 {yen(inc.first.amount)}
              </span>
            )}
          </div>
          <div class="m-col m-gap6">
            <div class="m-row m-num m-fs14">
              <span>
                <span class="m-sw sw-out" />
                支出
              </span>
              <span>
                <b>{yen(band.done)}</b>
                <span class="m-sub13"> / 見込み {yen(band.total)}</span>
              </span>
            </div>
            <StackBar
              parts={[
                { cls: 'f-out', pct: band.pct[0] },
                { cls: 'f-mid', pct: band.pct[1] },
                { cls: 'f-soft', pct: band.pct[2] },
              ]}
              label={`支出 済み ${yen(band.done)} 円、予定 ${yen(band.planned)} 円、予定にない支出の目安 ${yen(band.unplanned)} 円`}
            />
            <div class="m-legend m-num">
              <span>
                <span class="m-sw m-sw-8 sw-out" />
                済み {yen(band.done)}
              </span>
              <span>
                <span class="m-sw m-sw-8 sw-mid" />
                予定の残り {yen(band.planned)}
              </span>
              <span>
                <span class="m-sw m-sw-8 sw-soft" />
                目安 {yen(band.unplanned)}
              </span>
            </div>
          </div>
          <div class="m-total">
            <span class="m-fs14">月末の見込み残高</span>
            <b>{yen(o.this_month.projected_end_balance)}</b>
          </div>
        </section>
      )}

      {trend.length >= 2 && (
        <section class="m-card m-gap8 m-trend" aria-labelledby="m-trend">
          <div class="m-row m-px4">
            <h2 id="m-trend" class="m-h2">
              残高の推移
            </h2>
            <span class="m-sub">月末・直近 {trend.length} か月</span>
          </div>
          <BalanceTrend months={trend} reserve={o?.reserve ?? null} />
          <button type="button" class="m-link" onClick={() => go('forecast')}>
            この先 36 か月の見通しを見る
          </button>
        </section>
      )}

      {ns.length > 0 && (
        <section class="m-col" aria-labelledby="m-notice">
          <h2 id="m-notice" class="m-h2-small">
            確認すること（{ns.length}）
          </h2>
          {ns.map((n) => (
            <NoticeItem key={n.kind === 'card_settlement' ? n.accountId : n.kind} n={n} go={go} />
          ))}
        </section>
      )}

      <nav class="m-nav" aria-label="お金の画面">
        <NavRow title="月次" sub={monthlyLine(d.months.filter((m) => m.month <= last), last, cats) ?? '月ごとの収入と支出'} onClick={() => go('monthly')} />
        <NavRow
          title="明細"
          sub={untagged > 0 ? `事業/私用が未設定 ${untaggedText} 件` : '未設定はありません'}
          count={untagged > 0 ? untaggedText : undefined}
          onClick={() => go('txns', untagged > 0 ? { filter: { period: 'all', tag: 'unset' } } : {})}
        />
        <NavRow
          title="経費"
          sub={waiting > 0 ? waitingText(waiting) : '事業の支出を相手ごとに'}
          warn={waiting > 0}
          count={waiting > 0 ? String(waiting) : undefined}
          onClick={() => go('expenses', waiting > 0 ? { receipt: 'waiting' } : {})}
        />
        <NavRow title="見通し" sub={cf && v ? (cf.first_shortfall_month ? `${cf.first_shortfall_month} に残す額を下回る見込み` : v.title) : '36 か月の残高の見通し'} warn={v?.short} onClick={() => go('forecast')} />
        <NavRow title="予定" sub={next ? `次: ${md(next.due_date)} ${next.name} ${yen(next.amount)}` : '税金・保険などの予定'} onClick={() => go('schedule')} />
        <NavRow title="口座" sub={acctLine} warn={errors > 0} onClick={() => go('accounts')} />
      </nav>
    </>
  );
}

type Raw = Omit<HomeData, 'o'> & { o: Overview | null; fallback: boolean; untagged: { n: number; more: boolean }; candidates: number };

export function Home({ today, accounts, cats, go }: { today: string; accounts: Account[]; cats: Categories | null; go: Go }) {
  const [raw, setRaw] = useState<Raw | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    void (async () => {
      const month = today.slice(0, 7);
      const [o, h, cf, m, up, st] = await Promise.all([
        getJson<Overview>('/api/bank/overview'),
        getJson<BalanceHistory>('/api/balance_history?months=12'),
        getJson<Forecast>('/api/cashflow?months=36'),
        getJson<{ months: MonthlySummary[] }>(`/api/summary/monthly?from=${addMonth(month, -6)}&to=${month}`),
        getJson<{ items: Upcoming[] }>('/api/scheduled_items/upcoming?days=60'),
        getJson<{ accounts: BankStatus[] }>('/api/bank/status'),
      ]);
      // overview が無い古いサーバー（404）だけ、未設定の明細と提案の数を別に読み、描画のときに代わりを作る。
      // それ以外の失敗は代わりを作らず、理由を出す（残高を間違って見せないため）。
      const fallback = !o.ok && o.status === 404;
      const [u, c] = !fallback
        ? [null, null]
        : await Promise.all([getJson<TxnPage>('/api/bank_txns?tag=unset&limit=100'), getJson<{ candidates: Candidate[] }>('/api/recurrence_candidates?state=open')]);
      if (!live) return;
      if (!o.ok && !fallback) setMsg(failText(o.status, o.body));
      else if (fallback && !cf.ok) setMsg(failText(cf.status, cf.body));
      setRaw({
        o: o.ok ? o.data : null,
        history: h.ok ? h.data : null,
        cf: cf.ok ? cf.data : null,
        months: m.ok ? m.data.months : [],
        upcoming: up.ok ? up.data.items : [],
        status: st.ok ? st.data.accounts : [],
        fallback,
        untagged: u?.ok ? pageCount(u.data, 100) : { n: 0, more: false },
        candidates: c?.ok ? c.data.candidates.length : 0,
      });
    })();
    return () => {
      live = false;
    };
  }, [today]);

  const sync = async () => {
    setBusy(true);
    const r = await postJson('/api/bank/sync', {});
    setBusy(false);
    setMsg(r.status === 200 ? syncText((r.body as { created?: boolean } | null)?.created === true) : failText(r.status, r.body));
  };

  const d: HomeData | null = raw && {
    ...raw,
    o:
      raw.o ??
      (raw.fallback
        ? overviewFallback({
        today,
        accounts,
        cf: raw.cf,
        month: raw.months.find((x) => x.month === today.slice(0, 7)) ?? null,
        untagged: raw.untagged,
        candidates: raw.candidates,
        lastOkAt: raw.status.map((s) => s.last_ok_at).filter((x): x is string => !!x).sort().pop() ?? null,
          })
        : null),
  };
  const lastOk = d?.o?.sync.last_ok_at ?? null;
  const syncErr = syncErrorCount(d?.o?.sync.errors);
  return (
    <>
      <header class="m-head m-head-home">
        <h1>お金</h1>
        <span class={syncErr > 0 ? 'm-sub m-warn-text' : 'm-sub'}>
          同期 {shortTime(lastOk, today)}
          {syncErr > 0 ? `・エラー ${syncErr}` : ''}
        </span>
        <button type="button" class="m-icon" aria-label="今すぐ同期" disabled={busy} onClick={() => void sync()}>
          <Icon name="sync" size={22} />
        </button>
      </header>
      <div class="m-main">
        {msg && (
          <p class="m-msg" role="status">
            {msg}
          </p>
        )}
        {d ? <HomeView today={today} d={d} accounts={accounts} cats={cats} go={go} /> : <p class="m-empty">読み込み中…</p>}
      </div>
    </>
  );
}
