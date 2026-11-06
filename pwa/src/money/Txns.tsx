// 明細（GET /api/bank_txns）。日付の新しい順に 50 件ずつ、「さらに読む」で続きを読む。
// 行を押すと下からシートを出し、事業/私用/未設定とカテゴリを選んで POST /api/bank_txns/:id/tag。保存したら行を差し替える。
// 描画だけの部品（TxnFilters・TxnRows・TagSheet）は SSR のスナップショットで試す（test/unit/money-pwa.test.ts）。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson, postJson } from '../api.ts';
import {
  applyTag,
  categoryLabel,
  emptyFilter,
  failText,
  KIND_LABELS,
  PERIOD_LABELS,
  PERIODS,
  signedYen,
  TAG_LABELS,
  TAG_ORDER,
  txnsUrl,
  UNCATEGORIZED_QUERY,
  type Account,
  type Categories,
  type Tag,
  type TagResult,
  type Txn,
  type TxnFilter,
  type TxnPage,
} from './model.ts';

export function TxnFilters({ f, accounts, cats, onChange }: { f: TxnFilter; accounts: Account[]; cats: Categories | null; onChange: (f: TxnFilter) => void }) {
  return (
    <div class="fields">
      <div class="seg seg-4" role="group" aria-label="期間">
        {PERIODS.map((p) => (
          <button type="button" key={p} class={f.period === p ? 'seg-on' : ''} onClick={() => onChange({ ...f, period: p })}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>
      <div class="filters">
        <select class="field" aria-label="口座" value={f.accountId} onChange={(e) => onChange({ ...f, accountId: e.currentTarget.value })}>
          <option value="">口座: 全部</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select class="field" aria-label="タグ" value={f.tag} onChange={(e) => onChange({ ...f, tag: e.currentTarget.value as TxnFilter['tag'] })}>
          <option value="">タグ: 全部</option>
          {TAG_ORDER.map((t) => (
            <option key={t} value={t}>
              {TAG_LABELS[t]}
            </option>
          ))}
        </select>
        <select class="field" aria-label="カテゴリ" value={f.category} onChange={(e) => onChange({ ...f, category: e.currentTarget.value })}>
          <option value="">カテゴリ: 全部</option>
          <option value={UNCATEGORIZED_QUERY}>{categoryLabel(cats, null)}</option>
          {(cats?.items ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <form
        class="search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = (e.currentTarget.elements.namedItem('q') as HTMLInputElement | null)?.value ?? '';
          onChange({ ...f, q });
        }}
      >
        <input class="field" name="q" type="search" placeholder="摘要で検索" aria-label="摘要で検索" value={f.q} />
        <button type="submit" class="btn">
          検索
        </button>
      </form>
    </div>
  );
}

export function TxnRows({ items, cats, onOpen }: { items: Txn[]; cats: Categories | null; onOpen: (t: Txn) => void }) {
  return (
    <ul class="list">
      {items.map((t) => (
        <li key={t.id}>
          <button type="button" class={t.excluded ? 'item item-btn txn txn-excluded' : 'item item-btn txn'} onClick={() => onOpen(t)}>
            <div class="item-head">
              <span class="txn-date">{t.txn_date.slice(5).replace('-', '/')}</span>
              <span class="item-name">{t.description}</span>
              <span class={t.side === 'expense' ? 'num out' : 'num in'}>{signedYen(t.side, t.amount)}</span>
            </div>
            <div class="chips chips-sm">
              <span class="sub">{t.account_name}</span>
              {t.transfer_kind && <span class="badge">{KIND_LABELS[t.transfer_kind]}</span>}
              <span class={t.tag === 'unset' ? 'badge' : `badge badge-${t.tag}`}>{TAG_LABELS[t.tag]}</span>
              <span class="badge">{categoryLabel(cats, t.category)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function TagSheet({
  txn,
  tag,
  category,
  cats,
  busy,
  onTag,
  onCategory,
  onSave,
  onClose,
}: {
  txn: Txn;
  tag: Tag;
  category: string | null;
  cats: Categories | null;
  busy: boolean;
  onTag: (t: Tag) => void;
  onCategory: (c: string | null) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const options: (string | null)[] = [null, ...(cats?.items ?? []).map((c) => c.id)];
  return (
    <div class="sheet" role="dialog" aria-label="タグとカテゴリ">
      <p class="sheet-title">
        {txn.txn_date} {txn.description} {signedYen(txn.side, txn.amount)}
      </p>
      <div class="seg seg-wrap" role="group" aria-label="タグ">
        {TAG_ORDER.map((t) => (
          <button type="button" key={t} class={tag === t ? 'seg-on' : ''} onClick={() => onTag(t)}>
            {TAG_LABELS[t]}
          </button>
        ))}
      </div>
      <div class="chips sheet-list" role="group" aria-label="カテゴリ">
        {options.map((c) => (
          <button type="button" key={c ?? 'none'} class={category === c ? 'chip seg-on' : 'chip'} onClick={() => onCategory(c)}>
            {categoryLabel(cats, c)}
          </button>
        ))}
      </div>
      <div class="row-btns">
        <button type="button" class="btn btn-primary" disabled={busy} onClick={onSave}>
          保存
        </button>
        <button type="button" class="btn" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}

export function Txns({ today, accounts, cats }: { today: string; accounts: Account[]; cats: Categories | null }) {
  const [filter, setFilter] = useState<TxnFilter>(emptyFilter);
  const [items, setItems] = useState<Txn[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<{ txn: Txn; tag: Tag; category: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(
    async (f: TxnFilter, after: string | null) => {
      setBusy(true);
      const r = await getJson<TxnPage>(txnsUrl(f, today, after));
      setBusy(false);
      if (!r.ok) {
        setMsg(failText(r.status));
        if (!after) setItems([]);
        return;
      }
      setMsg('');
      setItems((cur) => (after && cur ? [...cur, ...r.data.items] : r.data.items));
      setCursor(r.data.next_cursor);
    },
    [today],
  );

  useEffect(() => {
    void load(filter, null);
  }, [filter, load]);

  const save = async () => {
    if (!open) return;
    setBusy(true);
    const r = await postJson(`/api/bank_txns/${encodeURIComponent(open.txn.id)}/tag`, { tag: open.tag, category: open.category });
    setBusy(false);
    if (r.status !== 200) {
      setMsg(failText(r.status, r.body));
      return;
    }
    setItems((cur) => (cur ? applyTag(cur, open.txn.id, r.body as TagResult) : cur));
    setOpen(null);
  };

  return (
    <>
      <TxnFilters f={filter} accounts={accounts} cats={cats} onChange={setFilter} />
      {msg && <p class="msg">{msg}</p>}
      {items && items.length === 0 && <p class="empty">明細はありません。</p>}
      {items && items.length > 0 && <TxnRows items={items} cats={cats} onOpen={(t) => setOpen({ txn: t, tag: t.tag, category: t.category })} />}
      {cursor && (
        <button type="button" class="btn" disabled={busy} onClick={() => void load(filter, cursor)}>
          さらに読む
        </button>
      )}
      {open && (
        <TagSheet
          txn={open.txn}
          tag={open.tag}
          category={open.category}
          cats={cats}
          busy={busy}
          onTag={(tag) => setOpen({ ...open, tag })}
          onCategory={(category) => setOpen({ ...open, category })}
          onSave={() => void save()}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
