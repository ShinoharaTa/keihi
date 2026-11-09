// 「お金」タブ（docs/mvp-plan-v3.md T111・T304。UI はモック 7 画面に合わせる）。開くとホーム。各画面へは行を押して進み、ヘッダの「戻る」でホームへ。
// 口座（GET /api/accounts）とカテゴリ（GET /api/categories）はここで読んで各画面に渡す。口座はホームに戻るたびに読み直す（他の画面で直した設定を映すため）。
// 画面の移動は go(view, intent)。intent は移った先の初期状態（明細の絞り込み・口座の設定・予定の追加フォーム・月次の月・見通しの月）。
// 経費（expenses）はホームから開き、相手の行を押すと明細へ（intent.receipt = 'waiting' なら「領収書待ちだけ」で開く）。
// メールの要対応（mail）はホームの「メールの要対応 n 件」から開く（取り込みが無効なら行を出さない）。
// onCapture は撮影タブへ移る（明細のシートの「領収書を撮る」）。
// フォームを開いている間（onLock）は「戻る」を押せない（入力を失わないため）。税・保険の見積もり（tax）は予定から開き、「戻る」で予定に戻る。
// 税の試算（tax_sim）は予定のカードと見積もりの画面から開き、「戻る」で呼んだ画面（intent.back、既定は予定）に戻る。
// 経費・メール・試算は別チャンク（お金のチャンクを軽くする）。初めて開いたときに読む（main.tsx のお金タブと同じ形）。
// 税・保険の見積もり（Tax.tsx）は予定（Schedule.tsx）が TaxCard を静的に読むのでお金のチャンクに残る。
import { h, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { Accounts } from './Accounts.tsx';
import { Cashflow } from './Cashflow.tsx';
import { Home } from './Home.tsx';
import { Icon } from './Icons.tsx';
import type { Account, Categories, Direction, TxnFilter } from './model.ts';
import { Monthly } from './Monthly.tsx';
import { Schedule } from './Schedule.tsx';
import { Tax } from './Tax.tsx';
import { Txns } from './Txns.tsx';

export type MoneyView = 'home' | 'monthly' | 'txns' | 'forecast' | 'schedule' | 'accounts' | 'tax' | 'tax_sim' | 'expenses' | 'mail';
export type Intent = { filter?: Partial<TxnFilter>; account?: string; add?: Direction; month?: string; receipt?: 'waiting'; back?: MoneyView };
export type Go = (view: MoneyView, intent?: Intent) => void;
type ExpensesComponent = (typeof import('./Expenses.tsx'))['Expenses'];
type MailComponent = (typeof import('./Mail.tsx'))['Mail'];
type TaxSimComponent = (typeof import('./TaxSim.tsx'))['TaxSim'];

// 別チャンクの画面を読んでいる間・読めなかったときの表示（main.tsx のお金タブと同じ）。
export function Pending({ failed }: { failed: boolean }) {
  return <p class="empty">{failed ? 'お金の画面を読めませんでした。電波の良い所で開き直してください。' : '読み込み中…'}</p>;
}

// 各画面の上の帯: 「戻る」・題・右端（任意）。
export function ScreenHead({
  title,
  sub,
  backLabel = 'お金に戻る',
  locked,
  flat,
  onBack,
  children,
}: {
  title: string;
  sub?: string;
  // 「戻る」の読み上げ（既定はお金に戻る）。
  backLabel?: string;
  locked?: boolean;
  flat?: boolean;
  onBack: () => void;
  children?: ComponentChildren;
}) {
  return (
    <header class={flat ? 'm-head m-head-flat' : 'm-head'}>
      <button type="button" class="m-icon" aria-label={backLabel} disabled={locked} onClick={onBack}>
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

export function Money({ today, onCapture }: { today: string; onCapture?: () => void }) {
  const [nav, setNav] = useState<{ view: MoneyView; intent: Intent; key: number }>({ view: 'home', intent: {}, key: 0 });
  const [locked, setLocked] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cats, setCats] = useState<Categories | null>(null);
  const [expenses, setExpenses] = useState<ExpensesComponent | 'error' | null>(null);
  const [mail, setMail] = useState<MailComponent | 'error' | null>(null);
  const [taxSim, setTaxSim] = useState<TaxSimComponent | 'error' | null>(null);

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

  useEffect(() => {
    if (nav.view === 'expenses' && typeof expenses !== 'function') {
      import('./Expenses.tsx').then(
        (m) => setExpenses(() => m.Expenses),
        () => setExpenses('error'),
      );
    }
    if (nav.view === 'mail' && typeof mail !== 'function') {
      import('./Mail.tsx').then(
        (m) => setMail(() => m.Mail),
        () => setMail('error'),
      );
    }
    if (nav.view === 'tax_sim' && typeof taxSim !== 'function') {
      import('./TaxSim.tsx').then(
        (m) => setTaxSim(() => m.TaxSim),
        () => setTaxSim('error'),
      );
    }
  }, [nav.view, nav.key]);

  const { view, intent, key } = nav;
  return (
    <section class="m">
      {view === 'home' && <Home key={key} today={today} accounts={accounts} cats={cats} go={go} />}
      {view === 'monthly' && <Monthly key={key} today={today} cats={cats} initialMonth={intent.month} onBack={home} go={go} />}
      {view === 'txns' && <Txns key={key} today={today} accounts={accounts} cats={cats} initial={intent.filter} onBack={home} onCapture={onCapture} />}
      {view === 'expenses' &&
        (typeof expenses === 'function' ? h(expenses, { key, today, cats, initialWaiting: intent.receipt === 'waiting', onBack: home, go }) : <Pending failed={expenses === 'error'} />)}
      {view === 'mail' && (typeof mail === 'function' ? h(mail, { key, today, onBack: home }) : <Pending failed={mail === 'error'} />)}
      {view === 'forecast' && <Cashflow key={key} accounts={accounts} focus={intent.month} onBack={home} go={go} />}
      {view === 'schedule' && <Schedule key={key} today={today} accounts={accounts} addDirection={intent.add} locked={locked} onLock={setLocked} onBack={home} onTax={() => go('tax')} onTaxSim={() => go('tax_sim', { back: 'schedule' })} />}
      {view === 'accounts' && <Accounts key={key} today={today} accounts={accounts} focus={intent.account} locked={locked} onChanged={loadAccounts} onLock={setLocked} onBack={home} />}
      {view === 'tax' && <Tax key={key} today={today} accounts={accounts} locked={locked} onLock={setLocked} onBack={() => go('schedule')} onSim={() => go('tax_sim', { back: 'tax' })} />}
      {view === 'tax_sim' && (
        typeof taxSim === 'function' ? (
          h(taxSim, { key, today, backLabel: intent.back === 'tax' ? '見積もりに戻る' : '予定に戻る', onBack: () => go(intent.back ?? 'schedule') })
        ) : (
          <Pending failed={taxSim === 'error'} />
        )
      )}
    </section>
  );
}
