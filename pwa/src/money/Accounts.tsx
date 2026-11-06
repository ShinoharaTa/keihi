// 口座（GET /api/accounts・GET /api/bank/status、src/web/routes/bank.ts）。口座ごとに名前・種別・最新残高・最終同期・エラー・過去分の取り込みの進み。
// 「設定」で既定タグ・資金繰りに含める・MCP の公開範囲・有効、カードなら引落元の口座とパターンを変えて PATCH /api/accounts/:id（変わった項目だけ）。
// 上に「今すぐ同期」（POST /api/bank/sync。created:false は 10 分以内に実行済み）。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson, patchJson, postJson } from '../api.ts';
import {
  ACCOUNT_KIND_LABELS,
  accountDraft,
  accountPatch,
  dateTime,
  failText,
  syncText,
  TAG_LABELS,
  TAG_ORDER,
  VISIBILITY_LABELS,
  VISIBILITY_ORDER,
  withStatus,
  yen,
  type Account,
  type AccountDraft,
  type BankStatus,
} from './model.ts';

type Row = Account & { status: BankStatus | null };

export function AccountRows({ rows, onEdit }: { rows: Row[]; onEdit: (a: Account) => void }) {
  return (
    <ul class="list">
      {rows.map((a) => {
        const s = a.status;
        return (
          <li class={s?.last_error ? 'item item-warn' : a.active ? 'item' : 'item txn-excluded'} key={a.id}>
            <div class="item-head">
              <span class="item-name">{a.name}</span>
              <span class="badge">{ACCOUNT_KIND_LABELS[a.kind] ?? a.kind}</span>
              {!a.active && <span class="badge">無効</span>}
            </div>
            <dl class="status">
              <dt>残高</dt>
              <dd class="num-l">{a.latest_balance ? `${yen(a.latest_balance.balance)} 円（${a.latest_balance.as_of_date}）` : '—'}</dd>
              <dt>最終同期</dt>
              <dd>{a.source === 'csv' ? `CSV ${dateTime(s?.last_csv_at ?? null)}` : dateTime(s?.last_ok_at ?? null)}</dd>
              {s?.backfill_done_until && (
                <>
                  <dt>過去分</dt>
                  <dd>{s.backfill_done_until} まで取り込み済み</dd>
                </>
              )}
              {s?.last_error && (
                <>
                  <dt>エラー</dt>
                  <dd class="out">
                    {s.last_error}（{dateTime(s.last_sync_at)}）
                  </dd>
                </>
              )}
            </dl>
            <p class="sub">
              既定 {TAG_LABELS[a.default_tag]}・{a.include_in_cashflow ? '資金繰りに含める' : '資金繰り対象外'}・MCP {VISIBILITY_LABELS[a.mcp_visibility]}
            </p>
            <button type="button" class="btn" onClick={() => onEdit(a)}>
              設定
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function AccountForm({
  account,
  draft,
  accounts,
  busy,
  onChange,
  onSave,
  onClose,
}: {
  account: Account;
  draft: AccountDraft;
  accounts: Account[];
  busy: boolean;
  onChange: (d: AccountDraft) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const set = <K extends keyof AccountDraft>(k: K, v: AccountDraft[K]) => onChange({ ...draft, [k]: v });
  return (
    <div class="fields">
      <p class="sheet-title">「{account.name}」の設定</p>
      <span class="label">既定のタグ</span>
      <div class="seg seg-wrap" role="group" aria-label="既定のタグ">
        {TAG_ORDER.map((t) => (
          <button type="button" key={t} class={draft.default_tag === t ? 'seg-on' : ''} onClick={() => set('default_tag', t)}>
            {TAG_LABELS[t]}
          </button>
        ))}
      </div>
      <span class="label">MCP の公開範囲</span>
      <div class="seg seg-wrap" role="group" aria-label="MCP の公開範囲">
        {VISIBILITY_ORDER.map((v) => (
          <button type="button" key={v} class={draft.mcp_visibility === v ? 'seg-on' : ''} onClick={() => set('mcp_visibility', v)}>
            {VISIBILITY_LABELS[v]}
          </button>
        ))}
      </div>
      <label class="toggle">
        <input type="checkbox" checked={draft.include_in_cashflow} onChange={(e) => set('include_in_cashflow', e.currentTarget.checked)} />
        資金繰りに含める
      </label>
      <label class="toggle">
        <input type="checkbox" checked={draft.active} onChange={(e) => set('active', e.currentTarget.checked)} />
        有効
      </label>
      {account.kind === 'card' && (
        <>
          <label class="fields">
            <span class="label">引落元の口座</span>
            <select class="field" value={draft.card_settlement_account_id} onChange={(e) => set('card_settlement_account_id', e.currentTarget.value)}>
              <option value="">なし</option>
              {accounts
                .filter((a) => a.id !== account.id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label class="fields">
            <span class="label">引落の摘要のパターン</span>
            <input class="field" value={draft.card_settlement_pattern} onInput={(e) => set('card_settlement_pattern', e.currentTarget.value)} />
          </label>
        </>
      )}
      <div class="row-btns">
        <button type="button" class="btn btn-primary" disabled={busy || Object.keys(accountPatch(account, draft)).length === 0} onClick={onSave}>
          保存
        </button>
        <button type="button" class="btn" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}

export function Accounts({ accounts, onChanged }: { accounts: Account[]; onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<BankStatus[]>([]);
  const [edit, setEdit] = useState<{ account: Account; draft: AccountDraft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const loadStatus = useCallback(async () => {
    const r = await getJson<{ accounts: BankStatus[] }>('/api/bank/status');
    if (r.ok) setStatus(r.data.accounts);
    else setMsg(failText(r.status));
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const sync = async () => {
    setBusy(true);
    const r = await postJson('/api/bank/sync', {});
    setBusy(false);
    setMsg(r.status === 200 ? syncText((r.body as { created?: boolean } | null)?.created === true) : failText(r.status, r.body));
  };

  const save = async () => {
    if (!edit) return;
    setBusy(true);
    const r = await patchJson(`/api/accounts/${encodeURIComponent(edit.account.id)}`, accountPatch(edit.account, edit.draft));
    setBusy(false);
    if (r.status !== 200) {
      setMsg(failText(r.status, r.body));
      return;
    }
    setMsg('保存しました。');
    setEdit(null);
    await Promise.all([onChanged(), loadStatus()]);
  };

  if (edit) {
    return (
      <>
        {msg && <p class="msg">{msg}</p>}
        <AccountForm
          account={edit.account}
          draft={edit.draft}
          accounts={accounts}
          busy={busy}
          onChange={(draft) => setEdit({ ...edit, draft })}
          onSave={() => void save()}
          onClose={() => setEdit(null)}
        />
      </>
    );
  }

  return (
    <>
      <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void sync()}>
        今すぐ同期
      </button>
      {msg && <p class="msg">{msg}</p>}
      {accounts.length === 0 && <p class="empty">口座はまだありません。</p>}
      {accounts.length > 0 && <AccountRows rows={withStatus(accounts, status)} onEdit={(a) => setEdit({ account: a, draft: accountDraft(a) })} />}
    </>
  );
}
