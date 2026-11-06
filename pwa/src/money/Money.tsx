// 「お金」タブ（docs/mvp-plan-v3.md T111・T304）。上のセグメントで 明細 / 月次 / 予定 / 見通し（資金繰り）/ 口座 を切り替える。
// 口座（GET /api/accounts）とカテゴリ（GET /api/categories）はここで 1 回読んで各画面に渡す。
// 明細を開いているときは先頭に「はじめに」（setupSteps。済んだ手順は出さず、全部済めば出さない）。各手順は該当の画面へ移る。
// 画面の移動は go(view, intent)。intent は移った先の初期状態（明細の絞り込み・口座の設定・予定の追加フォーム）。
// フォームを開いている間（onLock）はセグメントを押せない。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { Accounts } from './Accounts.tsx';
import { Cashflow } from './Cashflow.tsx';
import { setupSteps, UNCATEGORIZED_QUERY, type Account, type Categories, type Candidate, type Direction, type ScheduledItem, type SetupStep, type TxnFilter, type TxnPage } from './model.ts';
import { Monthly } from './Monthly.tsx';
import { Schedule } from './Schedule.tsx';
import { Txns } from './Txns.tsx';

export type MoneyView = 'txns' | 'monthly' | 'schedule' | 'cashflow' | 'accounts';
export const MONEY_VIEWS: readonly { id: MoneyView; label: string }[] = [
  { id: 'txns', label: '明細' },
  { id: 'monthly', label: '月次' },
  { id: 'schedule', label: '予定' },
  { id: 'cashflow', label: '見通し' },
  { id: 'accounts', label: '口座' },
];
type Intent = { filter?: Partial<TxnFilter>; account?: string; add?: Direction };
const UNSET_LIMIT = 100;

export function MoneySeg({ view, locked, onView }: { view: MoneyView; locked: boolean; onView: (v: MoneyView) => void }) {
  return (
    <div class="seg seg-5" role="group" aria-label="お金">
      {MONEY_VIEWS.map((v) => (
        <button type="button" key={v.id} class={view === v.id ? 'seg-on' : ''} disabled={locked && view !== v.id} onClick={() => onView(v.id)}>
          {v.label}
        </button>
      ))}
    </div>
  );
}

export function SetupCard({ steps, onStep }: { steps: SetupStep[]; onStep: (s: SetupStep) => void }) {
  if (steps.length === 0) return null;
  const text = (s: SetupStep) => {
    if (s.kind === 'card_settlement') return `引落元が未設定のカードが ${s.count} 件あります`;
    if (s.kind === 'income') return '収入の予定がまだありません';
    if (s.kind === 'candidates') return `定期の支払いの提案が ${s.count} 件あります`;
    return `タグが未設定の明細が ${s.count}${s.more ? '+' : ''} 件あります`;
  };
  return (
    <div class="item setup">
      <span class="item-name">はじめに</span>
      <ul class="list">
        {steps.map((s) => (
          <li key={s.kind}>
            <button type="button" class="btn setup-step" onClick={() => onStep(s)}>
              <span class="item-name">{text(s)}</span> ▸
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Money({ today }: { today: string }) {
  const [nav, setNav] = useState<{ view: MoneyView; intent: Intent; key: number }>({ view: 'txns', intent: {}, key: 0 });
  const [locked, setLocked] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cats, setCats] = useState<Categories | null>(null);
  const [setup, setSetup] = useState<{ items: ScheduledItem[] | null; candidates: number; unset: { count: number; more: boolean } | null }>({ items: null, candidates: 0, unset: null });

  const go = (view: MoneyView, intent: Intent = {}) => {
    setLocked(false);
    setNav((n) => ({ view, intent, key: n.key + 1 }));
  };

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

  // 明細に戻るたびに口座と「はじめに」の材料を読み直す（他の画面で済ませた手順を消すため）。
  useEffect(() => {
    if (nav.view !== 'txns') return;
    void loadAccounts();
    void (async () => {
      const [s, c, u] = await Promise.all([
        getJson<{ items: ScheduledItem[] }>('/api/scheduled_items'),
        getJson<{ candidates: Candidate[] }>('/api/recurrence_candidates?state=open'),
        getJson<TxnPage>(`/api/bank_txns?tag=unset&limit=${UNSET_LIMIT}`),
      ]);
      setSetup({
        items: s.ok ? s.data.items : null,
        candidates: c.ok ? c.data.candidates.length : 0,
        unset: u.ok ? { count: u.data.items.length, more: u.data.next_cursor !== null } : null,
      });
    })();
  }, [nav.view, nav.key, loadAccounts]);

  const onStep = (s: SetupStep) => {
    if (s.kind === 'card_settlement') go('accounts', { account: s.accountId });
    else if (s.kind === 'income') go('schedule', { add: 'in' });
    else if (s.kind === 'candidates') go('schedule');
    else go('txns', { filter: { period: 'all', tag: 'unset' } });
  };

  const { view, intent, key } = nav;
  return (
    <section class="screen">
      {view === 'txns' && <SetupCard steps={setupSteps({ accounts, ...setup })} onStep={onStep} />}
      <MoneySeg view={view} locked={locked} onView={(v) => go(v)} />
      {view === 'txns' && <Txns key={key} today={today} accounts={accounts} cats={cats} initial={intent.filter} />}
      {view === 'monthly' && (
        <Monthly
          key={key}
          today={today}
          cats={cats}
          onCategory={(month, category) => go('txns', { filter: { period: 'month', month, category: category ?? UNCATEGORIZED_QUERY } })}
        />
      )}
      {view === 'schedule' && <Schedule key={key} today={today} accounts={accounts} addDirection={intent.add} onLock={setLocked} />}
      {view === 'cashflow' && <Cashflow key={key} accounts={accounts} onAddIncome={() => go('schedule', { add: 'in' })} />}
      {view === 'accounts' && <Accounts key={key} accounts={accounts} focus={intent.account} onChanged={loadAccounts} onLock={setLocked} />}
    </section>
  );
}
