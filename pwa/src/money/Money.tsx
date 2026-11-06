// 「お金」タブ（docs/mvp-plan-v3.md T111・T304）。上のセグメントで 明細 / 月次 / 予定 / 資金繰り / 口座 を切り替える。
// 口座（GET /api/accounts）とカテゴリ（GET /api/categories）はここで 1 回読んで各画面に渡す。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { Accounts } from './Accounts.tsx';
import { Cashflow } from './Cashflow.tsx';
import type { Account, Categories } from './model.ts';
import { Monthly } from './Monthly.tsx';
import { Schedule } from './Schedule.tsx';
import { Txns } from './Txns.tsx';

export type MoneyView = 'txns' | 'monthly' | 'schedule' | 'cashflow' | 'accounts';
export const MONEY_VIEWS: readonly { id: MoneyView; label: string }[] = [
  { id: 'txns', label: '明細' },
  { id: 'monthly', label: '月次' },
  { id: 'schedule', label: '予定' },
  { id: 'cashflow', label: '資金繰り' },
  { id: 'accounts', label: '口座' },
];

export function MoneySeg({ view, onView }: { view: MoneyView; onView: (v: MoneyView) => void }) {
  return (
    <div class="seg seg-5" role="group" aria-label="お金">
      {MONEY_VIEWS.map((v) => (
        <button type="button" key={v.id} class={view === v.id ? 'seg-on' : ''} onClick={() => onView(v.id)}>
          {v.label}
        </button>
      ))}
    </div>
  );
}

export function Money({ today }: { today: string }) {
  const [view, setView] = useState<MoneyView>('txns');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cats, setCats] = useState<Categories | null>(null);

  const loadAccounts = useCallback(async () => {
    const r = await getJson<{ accounts: Account[] }>('/api/accounts');
    if (r.ok) setAccounts(r.data.accounts);
  }, []);

  useEffect(() => {
    void loadAccounts();
    void (async () => {
      const r = await getJson<Categories>('/api/categories');
      if (r.ok) setCats(r.data);
    })();
  }, [loadAccounts]);

  return (
    <section class="screen">
      <MoneySeg view={view} onView={setView} />
      {view === 'txns' && <Txns today={today} accounts={accounts} cats={cats} />}
      {view === 'monthly' && <Monthly today={today} cats={cats} />}
      {view === 'schedule' && <Schedule today={today} accounts={accounts} />}
      {view === 'cashflow' && <Cashflow accounts={accounts} />}
      {view === 'accounts' && <Accounts accounts={accounts} onChanged={loadAccounts} />}
    </section>
  );
}
