// 予定（docs/mvp-plan-v3.md T301・T302。src/web/routes/cashflow.ts）。
// 上に周期検出の提案（GET /api/recurrence_candidates?state=open）: 「予定に追加」で分類と金額を確かめて accept、「却下」で dismiss、「今すぐ検出」で detect。
// 下に予定の台帳（GET /api/scheduled_items?all=1。次の期日は GET /api/scheduled_items/upcoming の最初の due_date）。
// 「予定を追加」で POST、行を押すと同じフォームで PATCH と停止（deactivate）/ 再開（activate）。停止の後は「元に戻す」を出す。
// 提案の分類の初期値は摘要から推す（guessCategory）。フォームを開いている間は onLock(true) でセグメントの切り替えを止める。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson, patchJson, postJson } from '../api.ts';
import {
  categoriesFor,
  draftBody,
  draftError,
  draftOf,
  emptyDraft,
  failText,
  guessCategory,
  lastOccurrence,
  nextDueMap,
  parseYen,
  RECURRENCE_LABELS,
  RECURRENCES,
  SCHEDULE_CATEGORY_LABELS,
  NOTIFY_MAX,
  TEXT_MAX,
  UPCOMING_DAYS,
  yen,
  type Account,
  type Candidate,
  type Direction,
  type ItemDraft,
  type ScheduleCategory,
  type ScheduledItem,
} from './model.ts';

export type Accepting = { id: string; category: ScheduleCategory; amount: string };

export function CandidateList({
  items,
  accounts,
  accepting,
  busy,
  onAccept,
  onChange,
  onConfirm,
  onDismiss,
}: {
  items: Candidate[];
  accounts: Account[];
  accepting: Accepting | null;
  busy: boolean;
  onAccept: (c: Candidate) => void;
  onChange: (a: Accepting | null) => void;
  onConfirm: () => void;
  onDismiss: (c: Candidate) => void;
}) {
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  return (
    <ul class="list">
      {items.map((c) => (
        <li class="item" key={c.id}>
          <div class="item-head">
            <span class="item-name">{c.description_norm}</span>
            <span class="num out">−{yen(c.amount)}</span>
          </div>
          <p class="sub">
            {RECURRENCE_LABELS[c.interval]}・最後 {lastOccurrence(c) ?? '—'}・{nameOf(c.account_id)}
          </p>
          {accepting?.id === c.id ? (
            <div class="fields">
              <div class="chips" role="group" aria-label="分類">
                {categoriesFor('out').map((k) => (
                  <button type="button" key={k} class={accepting.category === k ? 'chip seg-on' : 'chip'} onClick={() => onChange({ ...accepting, category: k })}>
                    {SCHEDULE_CATEGORY_LABELS[k]}
                  </button>
                ))}
              </div>
              <label class="fields">
                <span class="label">金額（円）</span>
                <input class="field" inputMode="numeric" value={accepting.amount} onInput={(e) => onChange({ ...accepting, amount: e.currentTarget.value })} />
              </label>
              <div class="row-btns">
                <button type="button" class="btn btn-primary" disabled={busy || parseYen(accepting.amount) === null} onClick={onConfirm}>
                  予定に追加
                </button>
                <button type="button" class="btn" onClick={() => onChange(null)}>
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <div class="row-btns">
              <button type="button" class="btn btn-primary" disabled={busy} onClick={() => onAccept(c)}>
                予定に追加
              </button>
              <button type="button" class="btn" disabled={busy} onClick={() => onDismiss(c)}>
                予定にしない
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ItemRows({ items, nextDue, onOpen }: { items: ScheduledItem[]; nextDue: Record<string, string>; onOpen: (it: ScheduledItem) => void }) {
  return (
    <ul class="list">
      {items.map((it) => (
        <li key={it.id}>
          <button type="button" class={it.active ? 'item item-btn' : 'item item-btn txn-excluded'} onClick={() => onOpen(it)}>
            <div class="item-head">
              <span class="item-name">{it.name}</span>
              {!it.active && <span class="badge">停止中</span>}
              <span class={it.direction === 'out' ? 'num out' : 'num in'}>
                {it.direction === 'out' ? '−' : '+'}
                {yen(it.amount)}
              </span>
            </div>
            <p class="sub">
              {RECURRENCE_LABELS[it.recurrence]}・{SCHEDULE_CATEGORY_LABELS[it.category]}・次 {it.active ? (nextDue[it.id] ?? '—') : '—'}
            </p>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ItemForm({
  draft,
  editing,
  busy,
  onChange,
  onSave,
  onToggle,
  onClose,
}: {
  draft: ItemDraft;
  editing: ScheduledItem | null;
  busy: boolean;
  onChange: (d: ItemDraft) => void;
  onSave: () => void;
  onToggle: () => void;
  onClose: () => void;
}) {
  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) => onChange({ ...draft, [k]: v });
  const err = draftError(draft);
  return (
    <div class="fields">
      <p class="sheet-title">{editing ? `「${editing.name}」を編集` : '予定を追加'}</p>
      <label class="fields">
        <span class="label">名称</span>
        <input class="field" maxLength={TEXT_MAX} value={draft.name} onInput={(e) => set('name', e.currentTarget.value)} />
      </label>
      <label class="fields">
        <span class="label">金額（円）</span>
        <input class="field" inputMode="numeric" value={draft.amount} onInput={(e) => set('amount', e.currentTarget.value)} />
      </label>
      <div class="seg" role="group" aria-label="向き">
        <button type="button" class={draft.direction === 'out' ? 'seg-on' : ''} onClick={() => onChange({ ...draft, direction: 'out', category: draft.category === 'income' ? 'other' : draft.category })}>
          支出
        </button>
        <button type="button" class={draft.direction === 'in' ? 'seg-on' : ''} onClick={() => onChange({ ...draft, direction: 'in', category: draft.category === 'other' ? 'income' : draft.category })}>
          収入
        </button>
      </div>
      <label class="fields">
        <span class="label">分類</span>
        <select class="field" value={draft.category} onChange={(e) => set('category', e.currentTarget.value as ScheduleCategory)}>
          {categoriesFor(draft.direction).map((k) => (
            <option key={k} value={k}>
              {SCHEDULE_CATEGORY_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label class="fields">
        <span class="label">周期</span>
        <select class="field" value={draft.recurrence} onChange={(e) => set('recurrence', e.currentTarget.value as ItemDraft['recurrence'])}>
          {RECURRENCES.map((k) => (
            <option key={k} value={k}>
              {RECURRENCE_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label class="fields">
        <span class="label">最初の支払日</span>
        <input class="field" type="date" value={draft.anchor_date} onInput={(e) => set('anchor_date', e.currentTarget.value)} />
      </label>
      <label class="fields">
        <span class="label">終わりの日（任意）</span>
        <input class="field" type="date" min={draft.anchor_date} value={draft.end_date} onInput={(e) => set('end_date', e.currentTarget.value)} />
      </label>
      <label class="fields">
        <span class="label">何日前から知らせるか（0〜{NOTIFY_MAX}）</span>
        <input class="field" inputMode="numeric" maxLength={3} value={draft.notify_days_before} onInput={(e) => set('notify_days_before', e.currentTarget.value)} />
      </label>
      {err && draft.name !== '' && <p class="msg">{err}</p>}
      <div class="row-btns">
        <button type="button" class="btn btn-primary" disabled={busy || err !== null} onClick={onSave}>
          保存
        </button>
        <button type="button" class="btn" onClick={onClose}>
          閉じる
        </button>
      </div>
      {editing && (
        <button type="button" class={editing.active ? 'btn btn-danger' : 'btn'} disabled={busy} onClick={onToggle}>
          {editing.active ? '停止する' : '再開する'}
        </button>
      )}
    </div>
  );
}

export function Schedule({
  today,
  accounts,
  addDirection,
  onLock,
}: {
  today: string;
  accounts: Account[];
  // 開いたときに追加フォームを出す（資金繰り・はじめにから「収入を予定に追加」）。
  addDirection?: Direction;
  onLock: (locked: boolean) => void;
}) {
  const [cands, setCands] = useState<Candidate[]>([]);
  const [items, setItems] = useState<ScheduledItem[] | null>(null);
  const [nextDue, setNextDue] = useState<Record<string, string>>({});
  const [accepting, setAccepting] = useState<Accepting | null>(null);
  const [form, setForm] = useState<{ draft: ItemDraft; editing: ScheduledItem | null } | null>(() =>
    addDirection ? { draft: emptyDraft(today, addDirection), editing: null } : null,
  );
  const [undo, setUndo] = useState<ScheduledItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    onLock(form !== null);
    return () => onLock(false);
  }, [form !== null]);

  // 読み直す。失敗したときだけ msg を書く（書き込みの結果の文を消さない）。
  const load = useCallback(async () => {
    const [c, s, u] = await Promise.all([
      getJson<{ candidates: Candidate[] }>('/api/recurrence_candidates?state=open'),
      getJson<{ items: ScheduledItem[] }>('/api/scheduled_items?all=1'),
      getJson<{ items: { id: string; due_date: string }[] }>(`/api/scheduled_items/upcoming?days=${UPCOMING_DAYS}`),
    ]);
    const failed = [c, s, u].find((r) => !r.ok);
    if (failed && !failed.ok) setMsg(failText(failed.status, failed.body));
    setCands(c.ok ? c.data.candidates : []);
    setItems(s.ok ? s.data.items : null);
    setNextDue(u.ok ? nextDueMap(u.data.items) : {});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 書き込み → 結果の文 → 読み直し → busy を戻す。成功なら true。
  const run = async (p: Promise<{ status: number; body: unknown }>, ok: (body: unknown) => string): Promise<boolean> => {
    setBusy(true);
    setUndo(null);
    const r = await p;
    const good = r.status === 200 || r.status === 201;
    setMsg(good ? ok(r.body) : failText(r.status, r.body));
    if (good) await load();
    setBusy(false);
    return good;
  };

  const confirmAccept = async () => {
    if (!accepting) return;
    const c = cands.find((x) => x.id === accepting.id);
    const amount = parseYen(accepting.amount);
    const body: Record<string, unknown> = { category: accepting.category };
    if (amount !== null && amount !== c?.amount) body.amount = amount;
    if (await run(postJson(`/api/recurrence_candidates/${encodeURIComponent(accepting.id)}/accept`, body), () => '予定に追加しました。')) setAccepting(null);
  };

  const save = async () => {
    if (!form) return;
    const body = draftBody(form.draft);
    if (!body) return;
    const p = form.editing ? patchJson(`/api/scheduled_items/${encodeURIComponent(form.editing.id)}`, body) : postJson('/api/scheduled_items', body);
    if (await run(p, () => '保存しました。')) setForm(null);
  };

  const setActive = async (it: ScheduledItem, active: boolean) => {
    const action = active ? 'activate' : 'deactivate';
    const ok = await run(postJson(`/api/scheduled_items/${encodeURIComponent(it.id)}/${action}`, {}), () => (active ? '再開しました。' : `「${it.name}」を停止しました。`));
    if (ok) setForm(null);
    if (ok && !active) setUndo(it);
  };

  if (form) {
    return (
      <>
        {msg && <p class="msg">{msg}</p>}
        <ItemForm
          draft={form.draft}
          editing={form.editing}
          busy={busy}
          onChange={(draft) => setForm({ ...form, draft })}
          onSave={() => void save()}
          onToggle={() => form.editing && void setActive(form.editing, !form.editing.active)}
          onClose={() => setForm(null)}
        />
      </>
    );
  }

  return (
    <>
      {msg && (
        <div class="msg undo">
          <span>{msg}</span>
          {undo && (
            <button type="button" class="btn" disabled={busy} onClick={() => void setActive(undo, true)}>
              元に戻す
            </button>
          )}
        </div>
      )}
      <h2 class="h">提案</h2>
      {cands.length === 0 && <p class="sub">提案はありません。</p>}
      {cands.length > 0 && (
        <CandidateList
          items={cands}
          accounts={accounts}
          accepting={accepting}
          busy={busy}
          onAccept={(c) => setAccepting({ id: c.id, category: guessCategory(c.description_norm), amount: String(c.amount) })}
          onChange={setAccepting}
          onConfirm={() => void confirmAccept()}
          onDismiss={(c) => void run(postJson(`/api/recurrence_candidates/${encodeURIComponent(c.id)}/dismiss`, {}), () => '予定にしないことにしました。')}
        />
      )}
      <button
        type="button"
        class="btn"
        disabled={busy}
        onClick={() =>
          void run(postJson('/api/recurrence_candidates/detect', {}), (b) => {
            const r = b as { created?: number; updated?: number } | null;
            return `探しました（新しい提案 ${r?.created ?? 0} 件、更新 ${r?.updated ?? 0} 件）。`;
          })
        }
      >
        明細から定期の支払いを探す
      </button>
      <h2 class="h">予定の台帳</h2>
      {items && items.length === 0 && <p class="sub">予定はまだありません。</p>}
      {items && items.length > 0 && <ItemRows items={items} nextDue={nextDue} onOpen={(it) => setForm({ draft: draftOf(it), editing: it })} />}
      <button type="button" class="btn btn-primary" onClick={() => setForm({ draft: emptyDraft(today), editing: null })}>
        予定を追加
      </button>
    </>
  );
}
