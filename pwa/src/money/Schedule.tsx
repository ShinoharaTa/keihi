// 予定（モック Schedule。docs/mvp-plan-v3.md T301・T302。src/web/routes/cashflow.ts）。
// 上に明細から見つけた定期の支払い（GET /api/recurrence_candidates?state=open）: 「予定にする（分類）」で accept（分類は摘要から推す）、「しない」で dismiss。
// 次に この先 12 か月の山（GET /api/scheduled_items/upcoming の期日から、毎月の分を除いて分類別に積む）。
// 下に台帳（GET /api/scheduled_items?all=1。分類で絞り、次の期日順。停止中は「停止中の n 件も表示」で出す）。
// ヘッダの「追加」で POST、行を押すと同じフォームで PATCH と停止（deactivate）/ 再開（activate）。停止の後は「元に戻す」。
// 先頭に税・保険の見積もりのカード（GET /api/tax/profile・/api/tax/estimates。読めなければ出さない）。見積もりの行（origin = estimate）に「 · 見積」、
// 手直しした行（pinned）に「 · 手直し」。手直しした行のフォームに「自動計算に戻す」（PATCH pinned: false）。
// フォームを開いている間は onLock(true) で「戻る」を止める。周期の「3 か月ごと」は追加中の API（古いサーバーは invalid_recurrence で断る）。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson, patchJson, postJson } from '../api.ts';
import { PeakStrip } from './Charts.tsx';
import { Icon } from './Icons.tsx';
import { TaxCard } from './Tax.tsx';
import {
  candidateName,
  candidateNext,
  categoriesFor,
  dateShort,
  daysBetween,
  draftBody,
  draftError,
  draftOf,
  emptyDraft,
  failText,
  guessCategory,
  heavyMonths,
  lastOccurrence,
  ledgerRows,
  md,
  monthlyFixed,
  nextDueMap,
  NOTIFY_MAX,
  occurrenceCount,
  peakMonths,
  runText,
  RECURRENCE_LABELS,
  RECURRENCES,
  SCHEDULE_CATEGORIES,
  SCHEDULE_CATEGORY_LABELS,
  TEXT_MAX,
  UPCOMING_DAYS,
  yen,
  type Account,
  type Candidate,
  type Direction,
  type ItemDraft,
  type LedgerFilter,
  type PeakMonth,
  type RunSummary,
  type ScheduleCategory,
  type ScheduledItem,
  type TaxProfileResponse,
  type TaxSummary,
  type Upcoming,
} from './model.ts';
import { ScreenHead } from './Money.tsx';

const PER: Record<string, string> = { monthly: '毎月', bimonthly: '2 か月ごと', quarterly: '3 か月ごと', yearly: '毎年', biennial: '2 年ごと' };

export function CandidateList({ items, accounts, today, busy, onAccept, onDismiss }: { items: Candidate[]; accounts: Account[]; today: string; busy: boolean; onAccept: (c: Candidate) => void; onDismiss: (c: Candidate) => void }) {
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  return (
    <>
      {items.map((c) => {
        const cat = guessCategory(c.description_norm);
        const last = lastOccurrence(c);
        const next = candidateNext(c);
        const n = occurrenceCount(c);
        return (
          <article key={c.id} class="m-card m-cand">
            <div class="m-row">
              <h3 class="m-h3">{candidateName(c)}</h3>
              <span class="m-h3 m-num">
                {yen(c.amount)}
                <span class="m-per"> / {PER[c.interval] ?? RECURRENCE_LABELS[c.interval]}</span>
              </span>
            </div>
            <p class="m-sub">
              {c.account_name || nameOf(c.account_id)}
              {last ? ` · 最後 ${dateShort(last, today)}${n > 0 ? `（${n} 回）` : ''}` : ''}
              {next ? ` · 次は ${dateShort(next, today)} ごろ` : ''}
            </p>
            <div class="m-grid2">
              <button type="button" class="m-btn m-btn-accent" disabled={busy} onClick={() => onAccept(c)}>
                予定にする（{SCHEDULE_CATEGORY_LABELS[cat]}）
              </button>
              <button type="button" class="m-btn" disabled={busy} onClick={() => onDismiss(c)}>
                しない
              </button>
            </div>
          </article>
        );
      })}
    </>
  );
}

export function PeakCard({ peaks, fixed }: { peaks: PeakMonth[]; fixed: number }) {
  const heavy = heavyMonths(peaks);
  return (
    <section class="m-card m-pad12 m-gap6" aria-labelledby="m-peak">
      <div class="m-row">
        <h2 id="m-peak" class="m-h2">
          この先 12 か月の山
        </h2>
        {fixed > 0 && <span class="m-sub">毎月の {yen(fixed)} は除く</span>}
      </div>
      <div class="m-legend" aria-hidden="true">
        <span>
          <span class="m-sw sw-tax" />
          税金
        </span>
        <span>
          <span class="m-sw sw-ins" />
          保険
        </span>
        <span>
          <span class="m-sw sw-car" />
          車
        </span>
        <span>
          <span class="m-sw sw-other" />
          その他
        </span>
      </div>
      <PeakStrip peaks={peaks} heavy={heavy} />
      <p class="m-sub">
        {heavy.length > 0 ? `${heavy.map((m) => `${Number(m.slice(5, 7))} 月`).join('・')}が重い月です。前の月までに残しておきましょう。` : 'この先 12 か月に大きな予定支出はありません。'}
      </p>
    </section>
  );
}

const FILTERS: { id: LedgerFilter; label: string }[] = [{ id: '', label: '全部' }, ...SCHEDULE_CATEGORIES.map((c) => ({ id: c, label: SCHEDULE_CATEGORY_LABELS[c] }))];

export function Ledger({
  items,
  nextDue,
  today,
  filter,
  showInactive,
  onFilter,
  onShowInactive,
  onOpen,
}: {
  items: ScheduledItem[];
  nextDue: Record<string, string>;
  today: string;
  filter: LedgerFilter;
  showInactive: boolean;
  onFilter: (f: LedgerFilter) => void;
  onShowInactive: (v: boolean) => void;
  onOpen: (it: ScheduledItem) => void;
}) {
  const rows = ledgerRows(items, nextDue, filter, showInactive);
  const inactive = items.filter((it) => !it.active && (filter === '' || it.category === filter)).length;
  return (
    <section class="m-col" aria-labelledby="m-ledger">
      <h2 id="m-ledger" class="m-h2 m-px4">
        台帳（次の期日順）
      </h2>
      <div class="m-chips6" role="group" aria-label="分類で絞り込む">
        {FILTERS.map((f) => (
          <button type="button" key={f.id || 'all'} aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p class="m-sub13 m-px4">予定はまだありません。</p>
      ) : (
        <ul class="m-ledger">
          {rows.map((it) => {
            const due = it.active ? (nextDue[it.id] ?? null) : null;
            const left = due ? daysBetween(today, due) : null;
            return (
              <li key={it.id}>
                <button type="button" class={it.active ? 'm-lrow' : 'm-lrow m-lrow-off'} onClick={() => onOpen(it)}>
                  <span class="m-lrow-date">
                    <b>{due ? md(due) : '—'}</b>
                    <span>{!it.active ? '停止中' : due === null ? '期日なし' : left !== null && left <= 60 ? (left <= 0 ? '今日' : `あと ${left} 日`) : due.slice(0, 4)}</span>
                  </span>
                  <span class="m-lrow-name">
                    <span>{it.name}</span>
                    <span>
                      <span class={`m-badge b-${it.category}`}>{SCHEDULE_CATEGORY_LABELS[it.category]}</span>
                      {PER[it.recurrence] ?? RECURRENCE_LABELS[it.recurrence]}
                      {it.origin === 'detected' ? ' · 明細から' : ''}
                      {it.origin === 'estimate' ? ' · 見積' : ''}
                      {it.pinned ? ' · 手直し' : ''}
                    </span>
                  </span>
                  <span class={it.direction === 'in' ? 'm-lrow-amt m-amt-in' : 'm-lrow-amt'}>
                    {it.direction === 'in' ? '+' : ''}
                    {yen(it.amount)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {inactive > 0 && (
        <button type="button" class="m-link m-link-center" onClick={() => onShowInactive(!showInactive)}>
          {showInactive ? '停止中を隠す' : `停止中の ${inactive} 件も表示`}
        </button>
      )}
    </section>
  );
}

export function ItemForm({
  draft,
  editing,
  busy,
  onChange,
  onSave,
  onToggle,
  onUnpin,
  onClose,
}: {
  draft: ItemDraft;
  editing: ScheduledItem | null;
  busy: boolean;
  onChange: (d: ItemDraft) => void;
  onSave: () => void;
  onToggle: () => void;
  // 手直しした見積もりの行を自動計算に戻す。
  onUnpin?: () => void;
  onClose: () => void;
}) {
  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) => onChange({ ...draft, [k]: v });
  const err = draftError(draft);
  return (
    <section class="m-card m-form" aria-labelledby="m-item-form">
      <h2 id="m-item-form" class="m-h2">
        {editing ? `「${editing.name}」を編集` : '予定を追加'}
      </h2>
      {editing?.origin === 'estimate' && <p class="m-sub13">金額や日付を直すと、再計算で上書きされなくなります。</p>}
      <div class="m-seg m-seg-3" role="group" aria-label="向き">
        <button type="button" aria-pressed={draft.direction === 'out'} onClick={() => onChange({ ...draft, direction: 'out', category: draft.category === 'income' ? 'other' : draft.category })}>
          支出
        </button>
        <button type="button" aria-pressed={draft.direction === 'in'} onClick={() => onChange({ ...draft, direction: 'in' as Direction, category: draft.category === 'other' ? 'income' : draft.category })}>
          収入
        </button>
      </div>
      <label class="m-field-wrap">
        <span class="m-label">名称</span>
        <input class="m-field" maxLength={TEXT_MAX} value={draft.name} onInput={(e) => set('name', e.currentTarget.value)} />
      </label>
      <div class="m-form-2">
        <label class="m-field-wrap">
          <span class="m-label">金額（円）</span>
          <input class="m-field" inputMode="numeric" value={draft.amount} onInput={(e) => set('amount', e.currentTarget.value)} />
        </label>
        <label class="m-field-wrap">
          <span class="m-label">分類</span>
          <select class="m-field" value={draft.category} onChange={(e) => set('category', e.currentTarget.value as ScheduleCategory)}>
            {categoriesFor(draft.direction).map((k) => (
              <option key={k} value={k}>
                {SCHEDULE_CATEGORY_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div class="m-form-2">
        <label class="m-field-wrap">
          <span class="m-label">周期</span>
          <select class="m-field" value={draft.recurrence} onChange={(e) => set('recurrence', e.currentTarget.value as ItemDraft['recurrence'])}>
            {RECURRENCES.map((k) => (
              <option key={k} value={k}>
                {RECURRENCE_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label class="m-field-wrap">
          <span class="m-label">何日前に知らせる（0〜{NOTIFY_MAX}）</span>
          <input class="m-field" inputMode="numeric" maxLength={3} value={draft.notify_days_before} onInput={(e) => set('notify_days_before', e.currentTarget.value)} />
        </label>
      </div>
      <div class="m-form-2">
        <label class="m-field-wrap">
          <span class="m-label">最初の支払日</span>
          <input class="m-field" type="date" value={draft.anchor_date} onInput={(e) => set('anchor_date', e.currentTarget.value)} />
        </label>
        <label class="m-field-wrap">
          <span class="m-label">終わりの日（任意）</span>
          <input class="m-field" type="date" min={draft.anchor_date} value={draft.end_date} onInput={(e) => set('end_date', e.currentTarget.value)} />
        </label>
      </div>
      {err && draft.name !== '' && <p class="m-msg">{err}</p>}
      <div class="m-grid2">
        <button type="button" class="m-btn m-btn-primary" disabled={busy || err !== null} onClick={onSave}>
          保存
        </button>
        <button type="button" class="m-btn" onClick={onClose}>
          閉じる
        </button>
      </div>
      {editing && (
        <button type="button" class={editing.active ? 'm-btn m-btn-warn' : 'm-btn'} disabled={busy} onClick={onToggle}>
          {editing.active ? '停止する' : '再開する'}
        </button>
      )}
      {editing?.origin === 'estimate' && editing.pinned === 1 && (
        <button type="button" class="m-btn" disabled={busy} onClick={onUnpin}>
          自動計算に戻す
        </button>
      )}
    </section>
  );
}

export function Schedule({
  today,
  accounts,
  addDirection,
  locked,
  onLock,
  onBack,
  onTax,
}: {
  today: string;
  accounts: Account[];
  // 開いたときに追加フォームを出す（ホーム・見通しから「収入を予定に追加」）。
  addDirection?: Direction;
  locked: boolean;
  onLock: (locked: boolean) => void;
  onBack: () => void;
  // 税・保険の見積もりの設定画面へ。
  onTax: () => void;
}) {
  const [tax, setTax] = useState<TaxSummary | null>(null);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [items, setItems] = useState<ScheduledItem[] | null>(null);
  const [upcoming, setUpcoming] = useState<Upcoming[]>([]);
  const [filter, setFilter] = useState<LedgerFilter>('');
  const [showInactive, setShowInactive] = useState(false);
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
    const [c, s, u, tp, te] = await Promise.all([
      getJson<{ candidates: Candidate[] }>('/api/recurrence_candidates?state=open'),
      getJson<{ items: ScheduledItem[] }>('/api/scheduled_items?all=1'),
      getJson<{ items: Upcoming[] }>(`/api/scheduled_items/upcoming?days=${UPCOMING_DAYS}`),
      getJson<TaxProfileResponse>('/api/tax/profile'),
      getJson<{ created_at: string | null }>('/api/tax/estimates'),
    ]);
    setTax(tp.ok ? { ...tp.data, last_run_at: te.ok ? te.data.created_at : null } : null);
    const failed = [c, s, u].find((r) => !r.ok);
    if (failed && !failed.ok) setMsg(failText(failed.status, failed.body));
    setCands(c.ok ? c.data.candidates : []);
    setItems(s.ok ? s.data.items : null);
    setUpcoming(u.ok ? u.data.items : []);
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

  const nextDue = nextDueMap(upcoming);
  return (
    <>
      <ScreenHead title="予定" locked={locked} onBack={onBack}>
        {!form && (
          <button type="button" class="m-btn m-btn-primary m-btn-round" onClick={() => setForm({ draft: emptyDraft(today), editing: null })}>
            <Icon name="plus" size={18} />
            追加
          </button>
        )}
      </ScreenHead>
      <div class="m-main">
        {msg && (
          <div class="m-msg m-row" role="status">
            <span>{msg}</span>
            {undo && (
              <button type="button" class="m-btn" disabled={busy} onClick={() => void setActive(undo, true)}>
                元に戻す
              </button>
            )}
          </div>
        )}
        {form ? (
          <ItemForm
            draft={form.draft}
            editing={form.editing}
            busy={busy}
            onChange={(draft) => setForm({ ...form, draft })}
            onSave={() => void save()}
            onToggle={() => form.editing && void setActive(form.editing, !form.editing.active)}
            onUnpin={() => {
              const it = form.editing;
              if (!it) return;
              void run(patchJson(`/api/scheduled_items/${encodeURIComponent(it.id)}`, { pinned: false }), () => `「${it.name}」を自動計算に戻しました（次の再計算で計算値になります）。`).then((ok) => ok && setForm(null));
            }}
            onClose={() => setForm(null)}
          />
        ) : (
          <>
            {tax && (
              <TaxCard
                tax={tax}
                today={today}
                busy={busy}
                onOpen={onTax}
                onRecalc={() => void run(postJson('/api/tax/recalculate', {}), (b) => runText(b as RunSummary, '再計算しました。'))}
              />
            )}
            <section class="m-col" aria-labelledby="m-sugg">
              <h2 id="m-sugg" class="m-h2 m-px4">
                明細から見つけた定期の支払い（{cands.length}）
              </h2>
              {cands.length > 0 && <p class="m-sub13 m-px4">予定にすると見通しと残す額に入ります。</p>}
              <CandidateList
                items={cands}
                accounts={accounts}
                today={today}
                busy={busy}
                onAccept={(c) =>
                  void run(postJson(`/api/recurrence_candidates/${encodeURIComponent(c.id)}/accept`, { category: guessCategory(c.description_norm) }), () => `「${candidateName(c)}」を予定にしました。`)
                }
                onDismiss={(c) => void run(postJson(`/api/recurrence_candidates/${encodeURIComponent(c.id)}/dismiss`, {}), () => '予定にしないことにしました。')}
              />
              <button
                type="button"
                class="m-link"
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
            </section>
            {items && <PeakCard peaks={peakMonths(upcoming, today)} fixed={monthlyFixed(items)} />}
            {items && (
              <Ledger
                items={items}
                nextDue={nextDue}
                today={today}
                filter={filter}
                showInactive={showInactive}
                onFilter={setFilter}
                onShowInactive={setShowInactive}
                onOpen={(it) => setForm({ draft: draftOf(it), editing: it })}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
