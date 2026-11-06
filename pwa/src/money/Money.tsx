// 「お金」タブ（docs/mvp-plan-v3.md T111・T304。UI はモック 7 画面に合わせる）。開くとホーム。各画面へは行を押して進み、ヘッダの「戻る」でホームへ。
// 口座（GET /api/accounts）とカテゴリ（GET /api/categories）はここで読んで各画面に渡す。口座はホームに戻るたびに読み直す（他の画面で直した設定を映すため）。
// 画面の移動は go(view, intent)。intent は移った先の初期状態（明細の絞り込み・口座の設定・予定の追加フォーム・月次の月・見通しの月）。
// フォームを開いている間（onLock）は「戻る」を押せない（入力を失わないため）。
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { Accounts } from './Accounts.tsx';
import { Cashflow } from './Cashflow.tsx';
import { Home } from './Home.tsx';
import { Icon } from './Icons.tsx';
import type { Account, Categories, Direction, TxnFilter } from './model.ts';
import { Monthly } from './Monthly.tsx';
import { Schedule } from './Schedule.tsx';
import { Txns } from './Txns.tsx';

export type MoneyView = 'home' | 'monthly' | 'txns' | 'forecast' | 'schedule' | 'accounts';
export type Intent = { filter?: Partial<TxnFilter>; account?: string; add?: Direction; month?: string };
export type Go = (view: MoneyView, intent?: Intent) => void;

// 各画面の上の帯: 「戻る」・題・右端（任意）。
export function ScreenHead({ title, sub, locked, flat, onBack, children }: { title: string; sub?: string; locked?: boolean; flat?: boolean; onBack: () => void; children?: ComponentChildren }) {
  return (
    <header class={flat ? 'm-head m-head-flat' : 'm-head'}>
      <button type="button" class="m-icon" aria-label="お金に戻る" disabled={locked} onClick={onBack}>
        <Icon name="back" size={22} />
      </button>
      {sub ? (
        <div class="m-head-titles">
          <h1>{title}</h1>
          <span class="m-sub">{sub}</span>
        </div>
      ) : (
        <h1>{title}</h1>
      )}
      {children}
    </header>
  );
}

export function Money({ today }: { today: string }) {
  const [nav, setNav] = useState<{ view: MoneyView; intent: Intent; key: number }>({ view: 'home', intent: {}, key: 0 });
  const [locked, setLocked] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cats, setCats] = useState<Categories | null>(null);

  const go: Go = (view, intent = {}) => {
    setLocked(false);
    setNav((n) => ({ view, intent, key: n.key + 1 }));
  };
  const home = () => go('home');

  const loadAccounts = useCallback(async () => {
    const r = await getJson<{ accounts: Account[] }>('/api/accounts');
    if (r.ok) setAccounts(r.data.accounts);
  }, []);

  useEffect(() => {
    void (async () => {
      const r = await getJson<Categories>('/api/categories');
      if (r.ok) setCats(r.data);
    })();
  }, []);

  useEffect(() => {
    if (nav.view === 'home') void loadAccounts();
    window.scrollTo(0, 0);
  }, [nav.view, nav.key, loadAccounts]);

  const { view, intent, key } = nav;
  return (
    <section class="m">
      {view === 'home' && <Home key={key} today={today} accounts={accounts} cats={cats} go={go} />}
      {view === 'monthly' && <Monthly key={key} today={today} cats={cats} initialMonth={intent.month} onBack={home} go={go} />}
      {view === 'txns' && <Txns key={key} today={today} accounts={accounts} cats={cats} initial={intent.filter} onBack={home} />}
      {view === 'forecast' && <Cashflow key={key} accounts={accounts} focus={intent.month} onBack={home} go={go} />}
      {view === 'schedule' && <Schedule key={key} today={today} accounts={accounts} addDirection={intent.add} locked={locked} onLock={setLocked} onBack={home} />}
      {view === 'accounts' && <Accounts key={key} today={today} accounts={accounts} focus={intent.account} locked={locked} onChanged={loadAccounts} onLock={setLocked} onBack={home} />}
    </section>
  );
}
