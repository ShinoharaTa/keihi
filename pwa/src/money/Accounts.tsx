// 口座（モック Accounts。GET /api/accounts・GET /api/bank/status、src/web/routes/bank.ts）。上に最終同期と「今すぐ同期」（POST /api/bank/sync。created:false は 10 分以内に実行済み）。
// 口座ごとのカード: 名前・種別・同期の時刻・過去分の取り込み・エラー・最新残高。押すと設定（既定タグ・見通しに含める・AI に見せる範囲・有効、カードなら引落元と摘要の文字）を開き、
// PATCH /api/accounts/:id（変わった項目だけ）。引落元が未設定のカードは警告のカードにして、その場で引落元（銀行だけ）と摘要の文字を直せる。
// focus の口座は開いたときに設定を開く（ホームの「引落元を設定」から）。設定を変えている間は onLock(true) で「戻る」を止める。CSV の取り込みは準備中（押せない）。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson, patchJson, postJson } from '../api.ts';
import { Icon, type IconName } from './Icons.tsx';
import {
  ACCOUNT_KIND_LABELS,
  accountDraft,
  accountPatch,
  failText,
  md,
  needsSettlement,
  settlementChoices,
  shortTime,
  syncText,
  TAG_LABELS,
  TAG_ORDER,
  TEXT_MAX,
  VISIBILITY_LABELS,
  VISIBILITY_ORDER,
  withStatus,
  yen,
  type Account,
  type AccountDraft,
  type BankStatus,
} from './model.ts';
import { ScreenHead } from './Money.tsx';

type Row = Account & { status: BankStatus | null };
const KIND_ICON: Record<string, IconName> = { bank: 'bank', card: 'card', wallet: 'wallet', paypay: 'wallet', cash: 'cash' };
const TAG_SEG_LABELS = { ...TAG_LABELS, unset: '決めない' };

function Switch({ label, sub, checked, onChange }: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="m-switchrow">
      <span>
        <b class="m-fs14">{label}</b>
        {sub && <span class="m-sub">{sub}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class="m-knob" aria-hidden="true" />
    </label>
  );
}

function SettlementFields({ draft, accounts, idp, onChange }: { draft: AccountDraft; accounts: Account[]; idp: string; onChange: (d: AccountDraft) => void }) {
  return (
    <>
      <label class="m-field-wrap" for={`${idp}-from`}>
        <span class="m-label">引落元の口座</span>
        <select id={`${idp}-from`} class="m-field" value={draft.card_settlement_account_id} onChange={(e) => onChange({ ...draft, card_settlement_account_id: e.currentTarget.value })}>
          <option value="">選んでください</option>
          {settlementChoices(accounts).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label class="m-field-wrap" for={`${idp}-pat`}>
        <span class="m-label">銀行明細の摘要に出る文字</span>
        <input
          id={`${idp}-pat`}
          class="m-field"
          maxLength={TEXT_MAX}
          placeholder="例: ミツイスミトモ"
          value={draft.card_settlement_pattern}
          onInput={(e) => onChange({ ...draft, card_settlement_pattern: e.currentTarget.value })}
        />
        <span class="m-sub">銀行の明細の摘要に含まれる文字。長音記号は入れない。</span>
      </label>
    </>
  );
}

export function AccountCard({
  a,
  today,
  accounts,
  edit,
  open,
  busy,
  onOpen,
  onDraft,
  onSave,
}: {
  a: Row;
  today: string;
  accounts: Account[];
  // 書きかけの設定（この口座のときだけ）と、設定を開いているか。
  edit: AccountDraft | null;
  open: boolean;
  busy: boolean;
  onOpen: (open: boolean) => void;
  onDraft: (d: AccountDraft) => void;
  onSave: () => void;
}) {
  const s = a.status;
  const fix = needsSettlement(a);
  const idp = `m-a-${a.id}`;
  const draft = edit ?? accountDraft(a);
  const dirty = Object.keys(accountPatch(a, draft)).length > 0;
  const subs = [
    ACCOUNT_KIND_LABELS[a.kind] ?? a.kind,
    a.source === 'csv' ? (s?.last_csv_at ? `CSV · 最後の取り込み ${md(s.last_csv_at.slice(0, 10))}` : 'CSV · まだ取り込んでいません') : `同期 ${shortTime(s?.last_ok_at ?? null, today)}`,
    s?.backfill_done_until ? `過去分 ${s.backfill_done_until.slice(0, 7)} まで済み` : null,
    a.active ? null : '無効',
  ].filter(Boolean);
  return (
    <article class={fix || s?.last_error ? 'm-acct m-acct-warn' : 'm-acct'} aria-labelledby={`${idp}-name`}>
      <button type="button" class="m-acct-head" aria-expanded={open} onClick={() => onOpen(!open)}>
        <span class="m-acct-icon">
          <Icon name={KIND_ICON[a.kind] ?? 'bank'} />
        </span>
        <span class="m-acct-text">
          <b id={`${idp}-name`}>{a.name}</b>
          <span class="m-sub">{subs.join(' · ')}</span>
          {s?.last_error && (
            <span class="m-sub m-err">
              同期エラー: {s.last_error}（{shortTime(s.last_sync_at, today)}）
            </span>
          )}
        </span>
        <span class="m-acct-bal">
          {a.latest_balance ? yen(a.latest_balance.balance) : '—'}
          {a.latest_balance && (
            <>
              <br />
              <span class="m-sub">{md(a.latest_balance.as_of_date)} 時点</span>
            </>
          )}
        </span>
      </button>
      {fix && !open && (
        <div class="m-acct-fix">
          <p class="m-fs14">
            <b class="m-warn-text">引落の設定が済んでいません。</b>引落元の口座と摘要の文字の両方が要ります。無いあいだは、カードの利用と銀行の引落が両方とも支出に入ります。
          </p>
          <SettlementFields draft={draft} accounts={accounts} idp={`${idp}-fix`} onChange={(d) => onDraft(d)} />
          <button type="button" class="m-btn m-btn-primary m-btn-big" disabled={busy || !draft.card_settlement_account_id || !draft.card_settlement_pattern.trim()} onClick={onSave}>
            保存して二重計上を直す
          </button>
        </div>
      )}
      {open && (
        <div class="m-acct-body">
          <fieldset class="m-fs m-fs-sm">
            <legend>既定のタグ</legend>
            <div class="m-seg m-seg-3 m-seg-tag">
              {TAG_ORDER.map((t) => (
                <button type="button" key={t} class={t} aria-pressed={draft.default_tag === t} onClick={() => onDraft({ ...draft, default_tag: t })}>
                  {TAG_SEG_LABELS[t]}
                </button>
              ))}
            </div>
          </fieldset>
          <Switch label="見通しに含める" sub="残高と予定にない支出の目安に入れる" checked={draft.include_in_cashflow} onChange={(v) => onDraft({ ...draft, include_in_cashflow: v })} />
          <fieldset class="m-fs m-fs-sm">
            <legend>AI に見せる範囲</legend>
            <div class="m-seg m-seg-3">
              {VISIBILITY_ORDER.map((v) => (
                <button type="button" key={v} aria-pressed={draft.mcp_visibility === v} onClick={() => onDraft({ ...draft, mcp_visibility: v })}>
                  {VISIBILITY_LABELS[v]}
                </button>
              ))}
            </div>
          </fieldset>
          <Switch label="有効" sub="切ると同期と集計から外す" checked={draft.active} onChange={(v) => onDraft({ ...draft, active: v })} />
          {a.kind === 'card' && <SettlementFields draft={draft} accounts={accounts} idp={idp} onChange={onDraft} />}
          {a.source === 'csv' && (
            <button type="button" class="m-btn m-btn-wide" disabled>
              <Icon name="upload" size={18} />
              CSV を取り込む（準備中）
            </button>
          )}
          <div class="m-grid2">
            <button type="button" class="m-btn m-btn-primary" disabled={busy || !dirty} onClick={onSave}>
              保存
            </button>
            <button type="button" class="m-btn" onClick={() => onOpen(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export type Edit = { id: string; draft: AccountDraft; open: boolean };

export function AccountsView({
  rows,
  today,
  accounts,
  edit,
  busy,
  onOpen,
  onDraft,
  onSave,
}: {
  rows: Row[];
  today: string;
  accounts: Account[];
  edit: Edit | null;
  busy: boolean;
  onOpen: (a: Account, open: boolean) => void;
  onDraft: (a: Account, d: AccountDraft) => void;
  onSave: (a: Account, d: AccountDraft) => void;
}) {
  // 引落元が未設定のカードを先に。
  const sorted = [...rows].sort((x, y) => Number(needsSettlement(y)) - Number(needsSettlement(x)));
  return (
    <>
      {sorted.map((a) => {
        const mine = edit?.id === a.id ? edit : null;
        return (
          <AccountCard
            key={a.id}
            a={a}
            today={today}
            accounts={accounts}
            edit={mine?.draft ?? null}
            open={mine?.open ?? false}
            busy={busy}
            onOpen={(o) => onOpen(a, o)}
            onDraft={(d) => onDraft(a, d)}
            onSave={() => onSave(a, mine?.draft ?? accountDraft(a))}
          />
        );
      })}
    </>
  );
}

export function Accounts({
  today,
  accounts,
  focus,
  locked,
  onChanged,
  onLock,
  onBack,
}: {
  today: string;
  accounts: Account[];
  focus?: string;
  locked: boolean;
  onChanged: () => Promise<void>;
  onLock: (locked: boolean) => void;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<BankStatus[]>([]);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const dirty = (() => {
    const a = edit ? accounts.find((x) => x.id === edit.id) : null;
    return a && edit ? Object.keys(accountPatch(a, edit.draft)).length > 0 : false;
  })();
  useEffect(() => {
    onLock(dirty);
    return () => onLock(false);
  }, [dirty]);

  // focus の口座（ホームの「引落元を設定」）: 引落元が未設定のカードは警告のカードのまま、それ以外は設定を開く。
  useEffect(() => {
    const a = accounts.find((x) => x.id === focus);
    if (a && !needsSettlement(a)) setEdit((e) => e ?? { id: a.id, draft: accountDraft(a), open: true });
    if (focus) requestAnimationFrame(() => document.getElementById(`m-a-${focus}-name`)?.scrollIntoView({ block: 'center' }));
  }, [focus, accounts.length]);

  const loadStatus = useCallback(async () => {
    const r = await getJson<{ accounts: BankStatus[] }>('/api/bank/status');
    if (r.ok) setStatus(r.data.accounts);
    else setMsg(failText(r.status, r.body));
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

  const save = async (a: Account, d: AccountDraft) => {
    const body = accountPatch(a, d);
    if (Object.keys(body).length === 0) return;
    setBusy(true);
    const r = await patchJson(`/api/accounts/${encodeURIComponent(a.id)}`, body);
    setBusy(false);
    if (r.status !== 200) {
      setMsg(failText(r.status, r.body));
      return;
    }
    setMsg(`「${a.name}」を保存しました。`);
    setEdit(null);
    await Promise.all([onChanged(), loadStatus()]);
  };

  const lastOk = status.map((s) => s.last_ok_at).filter((x): x is string => !!x).sort().pop() ?? null;
  return (
    <>
      <ScreenHead title="口座" locked={locked} onBack={onBack} />
      <div class="m-main m-gap12">
        <section class="m-card m-sync" aria-label="同期">
          <div>
            <b>最終同期 {shortTime(lastOk, today)}</b>
            <span class="m-sub">毎朝自動で同期します。手動は 10 分あけて</span>
          </div>
          <button type="button" class="m-btn m-btn-accent m-btn-round" disabled={busy} onClick={() => void sync()}>
            <Icon name="sync" size={18} />
            今すぐ同期
          </button>
        </section>
        {msg && (
          <p class="m-msg" role="status">
            {msg}
          </p>
        )}
        {accounts.length === 0 && <p class="m-empty">口座はまだありません。</p>}
        <AccountsView
          rows={withStatus(accounts, status)}
          today={today}
          accounts={accounts}
          edit={edit}
          busy={busy}
          onOpen={(a, open) => setEdit(open ? { id: a.id, draft: edit?.id === a.id ? edit.draft : accountDraft(a), open: true } : null)}
          onDraft={(a, d) => setEdit({ id: a.id, draft: d, open: edit?.id === a.id ? edit.open : false })}
          onSave={(a, d) => void save(a, d)}
        />
      </div>
    </>
  );
}
