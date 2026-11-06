// 明細（GET /api/bank_txns）。日付の新しい順に 50 件ずつ、「さらに読む」で続きを読む。
// 絞り込みは「期間」と「絞り込み（n）」だけを常に出し、口座・タグ・カテゴリ・検索語は折りたたむ。結果の上に件数と支出の合計（読み込んだ分）。
// 行を押すと下からシート（暗幕つき。背景を押すと閉じる）。カテゴリは任意で選び、事業/私用/未設定を押した時点で
// POST /api/bank_txns/:id/tag で保存し、次の未設定の明細へ進む。応答は連番で古いものを捨てる。
// 描画だけの部品（TxnFilters・TxnRows・TagSheet）は SSR のスナップショットで試す（test/unit/money-pwa.test.ts）。
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getJson, postJson } from '../api.ts';
import {
  applyTag,
  categoryLabel,
  emptyFilter,
  failText,
  filterCount,
  KIND_LABELS,
  nextUnset,
  PERIOD_LABELS,
  PERIODS,
  signedYen,
  TAG_LABELS,
  TAG_ORDER,
  TEXT_MAX,
  txnsUrl,
  txnSummary,
  UNCATEGORIZED_QUERY,
  yen,
  type Account,
  type Categories,
  type Tag,
  type TagResult,
  type Txn,
  type TxnFilter,
  type TxnPage,
} from './model.ts';

export function TxnFilters({
  f,
  q,
  expanded,
  accounts,
  cats,
  onChange,
  onQ,
  onExpand,
}: {
  f: TxnFilter;
  q: string;
  expanded: boolean;
  accounts: Account[];
  cats: Categories | null;
  onChange: (f: TxnFilter) => void;
  onQ: (q: string) => void;
  onExpand: (v: boolean) => void;
}) {
  const n = filterCount(f);
  return (
    <div class="fields">
      <div class={f.period === 'month' ? 'seg seg-5' : 'seg seg-4'} role="group" aria-label="期間">
        {PERIODS.map((p) => (
          <button type="button" key={p} class={f.period === p ? 'seg-on' : ''} onClick={() => onChange({ ...f, period: p, month: undefined })}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
        {f.period === 'month' && f.month && (
          <button type="button" class="seg-on" aria-pressed="true">
            {f.month}
          </button>
        )}
      </div>
      <button type="button" class="btn" aria-expanded={expanded} onClick={() => onExpand(!expanded)}>
        絞り込み{n ? `（${n}）` : ''} {expanded ? '▴' : '▾'}
      </button>
      {expanded && (
        <>
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
              onChange({ ...f, q });
            }}
          >
            <input class="field" type="search" placeholder="摘要で検索" aria-label="摘要で検索" maxLength={TEXT_MAX} value={q} onInput={(e) => onQ(e.currentTarget.value)} />
            <button type="submit" class="btn">
              検索
            </button>
          </form>
        </>
      )}
    </div>
  );
}

export function TxnRows({ items, more, cats, onOpen }: { items: Txn[]; more: boolean; cats: Categories | null; onOpen: (t: Txn) => void }) {
  const sum = txnSummary(items);
  return (
    <>
      <p class="sub">
        {sum.count}
        {more ? '+' : ''} 件・支出 {yen(sum.expense)} 円{more ? '（読み込んだ分）' : ''}
      </p>
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
                {t.excluded && <span class="badge">集計外</span>}
                {t.transfer_kind && <span class="badge">{KIND_LABELS[t.transfer_kind]}</span>}
                <span class={t.tag === 'unset' ? 'badge' : `badge badge-${t.tag}`}>{TAG_LABELS[t.tag]}</span>
                <span class="badge">{categoryLabel(cats, t.category)}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function TagSheet({
  txn,
  category,
  cats,
  saving,
  error,
  onCategory,
  onTag,
  onClose,
}: {
  txn: Txn;
  category: string | null;
  cats: Categories | null;
  saving: boolean;
  error: string;
  onCategory: (c: string | null) => void;
  onTag: (t: Tag) => void;
  onClose: () => void;
}) {
  const options: (string | null)[] = [null, ...(cats?.items ?? []).map((c) => c.id)];
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class="sheet" role="dialog" aria-label="タグとカテゴリ">
        <p class="sheet-title">
          {txn.txn_date} {txn.description} {signedYen(txn.side, txn.amount)}
        </p>
        <span class="label">カテゴリ（任意）</span>
        <div class="chips sheet-list" role="group" aria-label="カテゴリ">
          {options.map((c) => (
            <button type="button" key={c ?? 'none'} class={category === c ? 'chip seg-on' : 'chip'} onClick={() => onCategory(c)}>
              {categoryLabel(cats, c)}
            </button>
          ))}
        </div>
        {error && <p class="msg">{error}</p>}
        <span class="label">押すと保存して次の未設定へ</span>
        <div class="seg seg-wrap" role="group" aria-label="タグ">
          {TAG_ORDER.map((t) => (
            <button type="button" key={t} class={txn.tag === t ? 'seg-on' : ''} disabled={saving} onClick={() => onTag(t)}>
              {TAG_LABELS[t]}
            </button>
          ))}
        </div>
        <button type="button" class="btn" onClick={onClose}>
          閉じる
        </button>
      </div>
    </>
  );
}

export function Txns({ today, accounts, cats, initial }: { today: string; accounts: Account[]; cats: Categories | null; initial?: Partial<TxnFilter> }) {
  const [filter, setFilter] = useState<TxnFilter>(() => ({ ...emptyFilter(), ...initial }));
  const [q, setQ] = useState(filter.q);
  const [expanded, setExpanded] = useState(() => filterCount(filter) > 0);
  const [items, setItems] = useState<Txn[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<{ txn: Txn; category: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sheetErr, setSheetErr] = useState('');
  const [msg, setMsg] = useState('');
  const seq = useRef(0);

  const load = useCallback(
    async (f: TxnFilter, after: string | null) => {
      const n = ++seq.current;
      setLoading(true);
      const r = await getJson<TxnPage>(txnsUrl(f, today, after));
      if (n !== seq.current) return; // 新しい読み込みが後から始まった
      setLoading(false);
      if (!r.ok) {
        setMsg(failText(r.status, r.body));
        setCursor(null);
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
    setCursor(null);
    void load(filter, null);
  }, [filter, load]);

  const openTxn = (t: Txn | null) => {
    setSheetErr('');
    setOpen(t ? { txn: t, category: t.category } : null);
  };

  const saveTag = async (tag: Tag) => {
    if (!open || !items) return;
    setSaving(true);
    const r = await postJson(`/api/bank_txns/${encodeURIComponent(open.txn.id)}/tag`, { tag, category: open.category });
    setSaving(false);
    if (r.status !== 200) {
      setSheetErr(failText(r.status, r.body));
      return;
    }
    const next = applyTag(items, open.txn.id, r.body as TagResult);
    setItems(next);
    openTxn(nextUnset(next, open.txn.id));
  };

  return (
    <>
      <TxnFilters f={filter} q={q} expanded={expanded} accounts={accounts} cats={cats} onChange={setFilter} onQ={setQ} onExpand={setExpanded} />
      {msg && <p class="msg">{msg}</p>}
      {items && items.length === 0 && <p class="empty">明細はありません。</p>}
      {items && items.length > 0 && <TxnRows items={items} more={cursor !== null} cats={cats} onOpen={openTxn} />}
      {cursor && (
        <button type="button" class="btn" disabled={loading} onClick={() => void load(filter, cursor)}>
          さらに読む
        </button>
      )}
      {open && (
        <TagSheet
          txn={open.txn}
          category={open.category}
          cats={cats}
          saving={saving}
          error={sheetErr}
          onCategory={(category) => setOpen({ ...open, category })}
          onTag={(t) => void saveTag(t)}
          onClose={() => openTxn(null)}
        />
      )}
    </>
  );
}
