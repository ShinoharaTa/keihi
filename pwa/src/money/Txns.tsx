// 明細（モック Txns・TagSheet。GET /api/bank_txns）。日付の新しい順に 50 件ずつ、日付ごとにまとめ、「続きを読み込む」で続き（keyset cursor）。
// 上に 期間 と「未設定だけ（n）」の 1 タップ絞り込み、口座・タグ・カテゴリ・検索は折りたたむ。絞り込みを変えたら cursor を捨てて読み直す。応答は連番で古いものを捨てる。
// 行の右端のタグを押すと 事業 ⇄ 私用（未設定は事業）をその場で保存（POST /api/bank_txns/:id/tag。押した行だけ busy）。行を押すとタグ付けシート（暗幕つき）。
// シート: 事業/私用/未設定・カテゴリ 12 種・「同じ摘要にも適用（ルール化）」（POST /api/tag_rules、exact。同じ口座・同じ摘要の未設定の行にも映す）・
// 「保存して閉じる」「保存して次の未設定へ」。
// 照合（docs/cashflow.md §16）: 行の右に証憑の印（receiptMark）。シートを開いたら GET /api/bank_txns/:id/matches を読み、支出なら「証憑」の段
// （紐付いた証憑と「外す」・候補（押すと紐付け）・撮影タブへ）。紐付け/解除の後は読み直して行の印も差し替える（applyMatches）。
// 経費の一覧から来た絞り込み（side・excluded・vendor_key・receipt）は上に 1 つのピルで出し、押すと外す。描画だけの部品（TxnFilters・TxnList・TagSheet）は SSR のスナップショットで試す。
// 選択モードと一括（#74 PR4。BulkBar.tsx・selection.ts）: スマホは上の「選択」か行の長押しで入り、行を押すと切り替え、長押しで anchor からその行まで。
// PC（useWide）は行頭に常にチェック（Shift で範囲、上のチェックで見えている行をすべて、Esc で解除）。選択中は下に操作の帯、一括は
// POST /api/bank_txns/bulk_tag を 1 回。結果の帯（元に戻す・学んだルールを消す）は 10 秒で消え、その後も上の「直前の一括を元に戻す」から戻せる。
// 絞り込みを変えたら選択を捨てる。
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { deleteJson, getJson, postJson } from '../api.ts';
import { BulkBar, BulkNoticeBand, CategoryPicker, SelectBand, SelectTools } from './BulkBar.tsx';
import { Icon } from './Icons.tsx';
import {
  applyMatches,
  applyRuleLocally,
  docLine,
  expenseFilterText,
  linkedText,
  mailHintText,
  receiptMark,
  countLabel,
  applyTag,
  categoryLabel,
  dayLabel,
  emptyFilter,
  failText,
  filterCount,
  groupByDate,
  KIND_LABELS,
  nextTag,
  nextUnset,
  periodText,
  PERIOD_LABELS,
  PERIODS,
  signedYen,
  TAG_LABELS,
  TAG_ORDER,
  TEXT_MAX,
  toggleUnset,
  txnIncome,
  txnsUrl,
  txnSummary,
  UNCATEGORIZED_QUERY,
  pageCount,
  unsetPosition,
  yen,
  type Account,
  type Categories,
  type MailHint,
  type Matches,
  type Tag,
  type TagResult,
  type Txn,
  type TxnFilter,
  type TxnPage,
} from './model.ts';
import { ScreenHead } from './Money.tsx';
import {
  allSelected,
  applyEffective,
  BULK_MAX,
  bulkBody,
  bulkNotice,
  collectFiltered,
  emptySelection,
  escAction,
  FILTERED_PAGE,
  ignoreKey,
  keepVisible,
  longPress,
  NOTICE_MS,
  plainNotice,
  pressStarts,
  rangeSel,
  revertFailText,
  revertNotice,
  rowAction,
  selectAll,
  toggleSel,
  TOO_MANY_TEXT,
  type BulkChange,
  type BulkNotice,
  type BulkTagResult,
  type RevertResult,
  type RowAction,
  type Selection,
} from './selection.ts';
import { useWide } from './useWide.ts';

const HINT_KEY = 'keihi.money.tagHint';
const seenHint = () => {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
};

export function TxnFilters({
  f,
  q,
  expanded,
  unsetCount,
  accounts,
  cats,
  onChange,
  onQ,
  onExpand,
}: {
  f: TxnFilter;
  q: string;
  expanded: boolean;
  unsetCount: string;
  accounts: Account[];
  cats: Categories | null;
  onChange: (f: TxnFilter) => void;
  onQ: (q: string) => void;
  onExpand: (v: boolean) => void;
}) {
  const more = [f.accountId, f.tag && f.tag !== 'unset' ? f.tag : '', f.category, f.q.trim()].filter((x) => x !== '').length;
  const month = f.period === 'month' ? f.month : f.period === 'year' ? '直近 12 か月' : f.period === 'range' ? f.rangeLabel : undefined;
  const exp = expenseFilterText(f);
  return (
    <div class="m-filters">
      <div class={month ? 'm-seg m-seg-5' : 'm-seg m-seg-4'} role="group" aria-label="期間">
        {PERIODS.map((p) => (
          <button type="button" key={p} aria-pressed={f.period === p} onClick={() => onChange({ ...f, period: p, month: undefined })}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
        {month && (
          <button type="button" aria-pressed="true">
            {month}
          </button>
        )}
      </div>
      <div class="m-pills">
        {exp && (
          <button type="button" class="m-pill" aria-pressed="true" aria-label={`${exp}。押すと外す`} onClick={() => onChange({ ...f, side: undefined, excluded: undefined, vendorKey: undefined, vendorLabel: undefined, receipt: undefined, pillLabel: undefined })}>
            {exp}
            <Icon name="close" size={16} />
          </button>
        )}
        <button type="button" class="m-pill m-pill-dashed" aria-pressed={f.tag === 'unset'} onClick={() => onChange(toggleUnset(f))}>
          未設定だけ{unsetCount ? `（${unsetCount}）` : ''}
        </button>
        <button type="button" class="m-pill" aria-expanded={expanded} aria-controls="m-txn-more" onClick={() => onExpand(!expanded)}>
          <Icon name="filter" size={18} />
          口座・カテゴリ・検索{more ? `（${more}）` : ''}
        </button>
      </div>
      {expanded && (
        <div class="m-filter-more" id="m-txn-more">
          <select class="m-field" aria-label="口座" value={f.accountId} onChange={(e) => onChange({ ...f, accountId: e.currentTarget.value })}>
            <option value="">口座: 全部</option>
            {accounts.filter((a) => a.active).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select class="m-field" aria-label="カテゴリ" value={f.category} onChange={(e) => onChange({ ...f, category: e.currentTarget.value })}>
            <option value="">カテゴリ: 全部</option>
            <option value={UNCATEGORIZED_QUERY}>{categoryLabel(cats, null)}</option>
            {(cats?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <select class="m-field" aria-label="タグ" value={f.tag} onChange={(e) => onChange({ ...f, tag: e.currentTarget.value as TxnFilter['tag'] })}>
            <option value="">タグ: 全部</option>
            {TAG_ORDER.map((t) => (
              <option key={t} value={t}>
                {TAG_LABELS[t]}
              </option>
            ))}
          </select>
          <form
            class="m-search"
            onSubmit={(e) => {
              e.preventDefault();
              onChange({ ...f, q });
            }}
          >
            <input class="m-field" type="search" placeholder="摘要で検索" aria-label="摘要で検索" maxLength={TEXT_MAX} value={q} onInput={(e) => onQ(e.currentTarget.value)} />
            <button type="submit" class="m-btn">
              検索
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

const TAG_NEXT_LABEL = (t: Tag) => `タグ: ${TAG_LABELS[t]}。押すと${TAG_LABELS[nextTag(t)]}に切り替え`;

// 選択モード（#74 PR4）。wide は PC 幅（行頭に常にチェック）、selecting は選択中（スマホは行頭にチェックを出し、右端のタグを隠す）。
export type ListSelect = { wide: boolean; selecting: boolean; ids: ReadonlySet<string> };
// 長押しの配線（スマホだけ。selection.ts の longPress）。
export type RowPress = { down: (id: string, x: number, y: number) => void; move: (x: number, y: number) => void; up: () => void };

function TxnRow({
  t,
  cats,
  busy,
  sel,
  press,
  onOpen,
  onToggle,
  onCheck,
}: {
  t: Txn;
  cats: Categories | null;
  busy: boolean;
  sel?: ListSelect;
  press?: RowPress;
  onOpen: (t: Txn) => void;
  onToggle: (t: Txn) => void;
  onCheck?: (t: Txn, shift: boolean) => void;
}) {
  const mark = receiptMark(t);
  const check = sel !== undefined && (sel.wide || sel.selecting);
  const on = sel?.ids.has(t.id) === true;
  const cls = `${t.excluded ? 'm-txn m-txn-ex' : 'm-txn'}${check ? ' m-txn-sel' : ''}${on ? ' m-txn-on' : ''}`;
  return (
    <li class={cls}>
      {check && (
        <span class="m-checkwrap" onClick={(e) => onCheck?.(t, e.shiftKey)}>
          <input type="checkbox" class="m-check" checked={on} aria-label={`選ぶ: ${t.description}`} />
        </span>
      )}
      <button
        type="button"
        class="m-txn-main"
        onClick={() => onOpen(t)}
        onPointerDown={press ? (e) => pressStarts(e) && press.down(t.id, e.clientX, e.clientY) : undefined}
        onPointerMove={press ? (e) => press.move(e.clientX, e.clientY) : undefined}
        onPointerUp={press?.up}
        onPointerCancel={press?.up}
        onPointerLeave={press?.up}
        onContextMenu={press ? (e) => e.preventDefault() : undefined}
      >
        <span class="m-txn-top">
          <span class="m-txn-name">{t.description}</span>
          {t.excluded ? (
            <span class="m-amt m-amt-ex">{yen(t.amount)}</span>
          ) : (
            <span class={t.side === 'expense' ? 'm-amt m-amt-out' : 'm-amt m-amt-in'}>{signedYen(t.side, t.amount)}</span>
          )}
        </span>
        <span class="m-txn-meta">
          <span>{t.account_name}</span>
          {t.excluded ? (
            <span class="m-cat m-cat-ex">集計外{t.transfer_kind ? ` · ${KIND_LABELS[t.transfer_kind]}` : ''}</span>
          ) : (
            <span class="m-cat">{categoryLabel(cats, t.category)}</span>
          )}
          {t.tag_source === 'rule' && <span>ルール</span>}
          {mark && <span class={`m-rc m-rc-${mark.kind}`}>{mark.label}</span>}
        </span>
      </button>
      {sel && !sel.wide && sel.selecting ? null : t.excluded ? (
        <span class="m-tagspace" />
      ) : (
        <button type="button" class="m-tagbtn" aria-label={TAG_NEXT_LABEL(t.tag)} disabled={busy} onClick={() => onToggle(t)}>
          <span class={`m-tag m-tag-${t.tag}`}>{TAG_LABELS[t.tag]}</span>
        </button>
      )}
    </li>
  );
}

export function TxnList({
  items,
  f,
  today,
  more,
  cats,
  busyIds,
  hint,
  onHint,
  sel,
  press,
  onOpen,
  onToggle,
  onCheck,
}: {
  items: Txn[];
  f: TxnFilter;
  today: string;
  more: boolean;
  cats: Categories | null;
  busyIds: string[];
  hint: boolean;
  // 選択モード（無ければ今までどおりの一覧）
  sel?: ListSelect;
  press?: RowPress;
  onHint: () => void;
  onOpen: (t: Txn) => void;
  onToggle: (t: Txn) => void;
  onCheck?: (t: Txn, shift: boolean) => void;
}) {
  const sum = txnSummary(items);
  return (
    <>
      <div class="m-sumline">
        <span>
          {periodText(f, today)} · {sum.count}
          {more ? '+' : ''} 件
        </span>
        <span>
          支出 <b>{yen(sum.expense)}</b> · 収入 <b>{yen(txnIncome(items))}</b>
          {more ? '（読み込んだ分）' : ''}
        </span>
      </div>
      {hint && (
        <div class="m-hint">
          <Icon name="info" size={18} />
          <span>右端のタグを押すと事業/私用が切り替わります。行を押すとカテゴリも選べます。</span>
          <button type="button" class="m-icon" aria-label="ヒントを閉じる" onClick={onHint}>
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      {groupByDate(items).map((g) => (
        <section key={g.date} aria-labelledby={`m-d-${g.date}`}>
          <div class="m-dayhead">
            <h2 id={`m-d-${g.date}`}>{dayLabel(g.date, today)}</h2>
            <span>{g.net > 0 ? `+${yen(g.net)}` : yen(g.net)}</span>
          </div>
          <ul class="m-txns">
            {g.items.map((t) => (
              <TxnRow key={t.id} t={t} cats={cats} busy={busyIds.includes(t.id)} sel={sel} press={press} onOpen={onOpen} onToggle={onToggle} onCheck={onCheck} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function DocRow({ d }: { d: Matches['links'][number]['document'] }) {
  return (
    <span class="m-doc-main">
      {d.thumbnail_url ? <img class="m-doc-thumb" src={d.thumbnail_url} alt="" loading="lazy" /> : <span class="m-doc-thumb">PDF</span>}
      <span>{docLine(d)}</span>
    </span>
  );
}

// シートの「証憑」の段。紐付いた証憑（外す）→ 候補（押すと紐付け）→ 注文の確認メールの手がかり（mail_hint）→ 撮影タブへ。
function ReceiptSection({
  matches,
  mailHint,
  busy,
  onLink,
  onUnlink,
  onCapture,
}: {
  matches: Matches | 'error' | null;
  mailHint?: MailHint | null;
  busy: boolean;
  onLink?: (documentId: string) => void;
  onUnlink?: (documentId: string) => void;
  onCapture?: () => void;
}) {
  const m = matches && matches !== 'error' ? matches : null;
  return (
    <fieldset class="m-fs">
      <legend>証憑</legend>
      {matches === null && <p class="m-sub13">読み込み中…</p>}
      {matches === 'error' && <p class="m-sub13">証憑を読めませんでした。</p>}
      {m &&
        m.links.map((l) => (
          <div key={l.document_id} class="m-doc">
            <DocRow d={l.document} />
            <button type="button" class="m-btn" disabled={busy} onClick={() => onUnlink?.(l.document_id)}>
              外す
            </button>
          </div>
        ))}
      {m && m.candidates.length > 0 && <span class="m-sub13">候補（押すと紐付けます）</span>}
      {m &&
        m.candidates.map((c) => (
          <button type="button" key={c.document_id} class="m-doc m-doc-cand" disabled={busy} onClick={() => onLink?.(c.document_id)}>
            <DocRow d={c.document} />
            <Icon name="plus" size={18} />
          </button>
        ))}
      {m && m.links.length === 0 && m.candidates.length === 0 && <p class="m-sub13">紐付いた証憑も候補もありません。</p>}
      {mailHint && <p class="m-sub13">{mailHintText(mailHint)}</p>}
      {onCapture && (
        <button type="button" class="m-btn m-btn-start" onClick={onCapture}>
          領収書を撮る・共有で入れる
        </button>
      )}
    </fieldset>
  );
}

export type SheetDraft = { tag: Tag; category: string | null; rule: boolean };

export function TagSheet({
  txn,
  draft,
  pos,
  cats,
  saving,
  error,
  matches,
  matchBusy,
  onDraft,
  onSave,
  onClose,
  onLink,
  onUnlink,
  onCapture,
}: {
  txn: Txn;
  draft: SheetDraft;
  pos: { index: number; total: number };
  cats: Categories | null;
  saving: boolean;
  error: string;
  // 照合（undefined なら「証憑」の段を出さない。null は読み込み中）。
  matches?: Matches | 'error' | null;
  matchBusy?: boolean;
  onDraft: (d: SheetDraft) => void;
  onSave: (next: boolean) => void;
  onClose: () => void;
  onLink?: (documentId: string) => void;
  onUnlink?: (documentId: string) => void;
  onCapture?: () => void;
}) {
  const canRule = draft.tag !== 'unset';
  const what = `${TAG_LABELS[draft.tag]}${draft.category ? ` · ${categoryLabel(cats, draft.category)}` : ''}`;
  return (
    <>
      <div class="m-scrim" onClick={onClose} />
      <section
        class="m-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="m-sheet-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div class="m-grip" aria-hidden="true">
          <span />
        </div>
        <div class="m-sheet-head">
          <h2 id="m-sheet-title">タグを付ける</h2>
          {pos.index > 0 && (
            <span class="m-sub13">
              未設定 {pos.index} / {pos.total}
            </span>
          )}
          <button type="button" class="m-icon" aria-label="閉じる" onClick={onClose}>
            <Icon name="close" size={22} />
          </button>
        </div>
        <div class="m-sheet-body">
          <div class="m-sheet-txn">
            <div>
              <b>{txn.description}</b>
              <span class="m-sub13">
                {dayLabel(txn.txn_date, '')} · {txn.account_name}
              </span>
            </div>
            <span class={txn.side === 'expense' ? 'm-sheet-amt m-amt-out' : 'm-sheet-amt m-amt-in'}>{signedYen(txn.side, txn.amount)}</span>
          </div>
          <fieldset class="m-fs">
            <legend>事業 / 私用</legend>
            <div class="m-seg m-seg-3 m-seg-lg m-seg-tag">
              {TAG_ORDER.map((t) => (
                <button type="button" key={t} class={t} aria-pressed={draft.tag === t} onClick={() => onDraft({ ...draft, tag: t, rule: t === 'unset' ? false : draft.rule })}>
                  {TAG_LABELS[t]}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset class="m-fs">
            <legend>カテゴリ</legend>
            <div class="m-catgrid">
              {(cats?.items ?? []).map((c) => (
                <button type="button" key={c.id} aria-pressed={draft.category === c.id} onClick={() => onDraft({ ...draft, category: draft.category === c.id ? null : c.id })}>
                  {c.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label class="m-switchrow m-switchrow-box">
            <span>
              <b>同じ摘要にも適用（ルール化）</b>
              <span class="m-sub13">
                {canRule ? `${txn.account_name} の「${txn.description}」すべて（未設定の明細と、これから来る明細）を ${what} にします。` : '未設定のままではルールにできません。'}
              </span>
            </span>
            <input type="checkbox" role="switch" checked={draft.rule} disabled={!canRule} onChange={(e) => onDraft({ ...draft, rule: e.currentTarget.checked })} />
            <span class="m-knob" aria-hidden="true" />
          </label>
          {matches !== undefined && (
            <ReceiptSection matches={matches} mailHint={txn.mail_hint} busy={matchBusy === true} onLink={onLink} onUnlink={onUnlink} onCapture={onCapture} />
          )}
          {error && <p class="m-msg">{error}</p>}
        </div>
        <div class="m-sheet-foot">
          <button type="button" class="m-btn m-btn-big" disabled={saving} onClick={() => onSave(false)}>
            保存して閉じる
          </button>
          <button type="button" class="m-btn m-btn-big m-btn-primary" disabled={saving} onClick={() => onSave(true)}>
            保存して次の未設定へ
            <Icon name="next" size={18} />
          </button>
        </div>
      </section>
    </>
  );
}

const draftOfTxn = (t: Txn): SheetDraft => ({ tag: t.tag, category: t.category, rule: false });

export function Txns({
  today,
  accounts,
  cats,
  initial,
  onBack,
  onCapture,
}: {
  today: string;
  accounts: Account[];
  cats: Categories | null;
  initial?: Partial<TxnFilter>;
  onBack: () => void;
  onCapture?: () => void;
}) {
  const [filter, setFilter] = useState<TxnFilter>(() => ({ ...emptyFilter(), ...initial }));
  const [q, setQ] = useState(filter.q);
  const [expanded, setExpanded] = useState(() => filterCount({ ...filter, tag: filter.tag === 'unset' ? '' : filter.tag }) > 0);
  const [items, setItems] = useState<Txn[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unsetCount, setUnsetCount] = useState('');
  const [open, setOpen] = useState<{ txn: Txn; draft: SheetDraft } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [hint, setHint] = useState(() => !seenHint());
  const [sheetErr, setSheetErr] = useState('');
  const [msg, setMsg] = useState('');
  const [matches, setMatches] = useState<Matches | 'error' | null>(null);
  const [matchBusy, setMatchBusy] = useState(false);
  const seq = useRef(0);
  const countSeq = useRef(0);
  const matchSeq = useRef(0);
  const wide = useWide();
  const [sel, setSel] = useState<Selection>(emptySelection);
  const [mode, setMode] = useState(false);
  const [picker, setPicker] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState<BulkNotice | null>(null);
  const [lastBatch, setLastBatch] = useState<string | null>(null);
  const [selMsg, setSelMsg] = useState('');
  const [collecting, setCollecting] = useState(false);
  const collectSeq = useRef(0);

  const load = useCallback(
    async (f: TxnFilter, after: string | null) => {
      const n = ++seq.current;
      setLoading(true);
      const r = await getJson<TxnPage>(txnsUrl(f, today, after));
      if (n !== seq.current) return; // 新しい読み込みが後から始まった
      setLoading(false);
      if (!r.ok) {
        setMsg(failText(r.status, r.body));
        // 続きの読み込みの失敗は cursor を残す（「続きを読み込む」をもう一度押せる）。
        if (!after) {
          setCursor(null);
          setItems([]);
        }
        return;
      }
      setMsg('');
      setItems((cur) => (after && cur ? [...cur, ...r.data.items] : r.data.items));
      setCursor(r.data.next_cursor);
      return r.data.items;
    },
    [today],
  );

  useEffect(() => {
    setCursor(null);
    void load(filter, null);
  }, [filter, load]);

  // 「未設定だけ（n）」の n: タグ以外の絞り込みはそのままで、未設定の件数（上限 100 件）。
  useEffect(() => {
    const n = ++countSeq.current;
    void (async () => {
      const r = await getJson<TxnPage>(txnsUrl({ ...filter, tag: 'unset', receipt: undefined }, today, null, 100));
      if (n !== countSeq.current) return;
      setUnsetCount(r.ok ? countLabel(pageCount(r.data, 100)) : '');
    })();
  }, [filter.period, filter.month, filter.range, filter.accountId, filter.category, filter.q, filter.side, filter.excluded, filter.vendorKey, today]);

  // 開いた明細の照合を読む（支出だけ）。読み終える前に別の明細を開いたら古い応答を捨てる。
  const loadMatches = async (t: Txn): Promise<Matches | null> => {
    const n = ++matchSeq.current;
    const r = await getJson<Matches>(`/api/bank_txns/${encodeURIComponent(t.id)}/matches`);
    if (n !== matchSeq.current) return null;
    setMatches(r.ok ? r.data : 'error');
    return r.ok ? r.data : null;
  };

  const openTxn = (t: Txn | null) => {
    setSheetErr('');
    setOpen(t ? { txn: t, draft: draftOfTxn(t) } : null);
    matchSeq.current++;
    setMatches(null);
    if (t && t.side === 'expense') void loadMatches(t);
  };

  // 紐付け（documentId と linked = true）・解除（false）。終わったら照合を読み直し、行の印を差し替える。
  const changeMatch = async (documentId: string, linked: boolean) => {
    if (!open || matchBusy) return;
    const { txn } = open;
    const base = `/api/bank_txns/${encodeURIComponent(txn.id)}/matches`;
    setMatchBusy(true);
    const r = linked ? await postJson(base, { document_id: documentId }) : await postJson(`${base}/${encodeURIComponent(documentId)}/unlink`, {});
    setMatchBusy(false);
    if (r.status !== (linked ? 201 : 200)) {
      setSheetErr(failText(r.status, r.body));
      return;
    }
    setSheetErr(linked ? linkedText((r.body as { warnings?: string[] }).warnings ?? []) : '');
    const m = await loadMatches(txn);
    if (m) setItems((cur) => (cur ? cur.map((t) => (t.id === txn.id ? applyMatches(t, m) : t)) : cur));
  };

  const toggle = async (t: Txn) => {
    if (busyIds.includes(t.id)) return;
    setBusyIds((b) => [...b, t.id]);
    const r = await postJson(`/api/bank_txns/${encodeURIComponent(t.id)}/tag`, { tag: nextTag(t.tag), category: t.category });
    setBusyIds((b) => b.filter((x) => x !== t.id));
    if (r.status !== 200) {
      setMsg(failText(r.status, r.body));
      return;
    }
    setItems((cur) => (cur ? applyTag(cur, t.id, r.body as TagResult) : cur));
  };

  const save = async (next: boolean) => {
    if (!open || !items) return;
    const { txn, draft } = open;
    setSaving(true);
    const r = await postJson(`/api/bank_txns/${encodeURIComponent(txn.id)}/tag`, { tag: draft.tag, category: draft.category });
    if (r.status !== 200) {
      setSaving(false);
      setSheetErr(failText(r.status, r.body));
      return;
    }
    const result = r.body as TagResult;
    let ruled = false;
    if (draft.rule && draft.tag !== 'unset') {
      const rr = await postJson('/api/tag_rules', { account_id: txn.account_id, pattern: txn.description, match: 'exact', tag: draft.tag, category: draft.category });
      if (rr.status === 201) ruled = true;
      else setMsg(`タグは保存しましたが、ルールは作れませんでした。${failText(rr.status, rr.body)}`);
    }
    // 待っている間に続きを読み込んでいても消さないよう、その時点の一覧（cur）に当てる。
    const apply = (xs: Txn[]) => {
      const tagged = applyTag(xs, txn.id, result);
      return ruled ? applyRuleLocally(tagged, txn, draft.tag, draft.category) : tagged;
    };
    setSaving(false);
    setItems((cur) => (cur ? apply(cur) : cur));
    if (!next) return openTxn(null);
    const out = apply(items);
    const nx = nextUnset(out, txn.id) ?? out.find((t) => t.tag === 'unset' && !t.excluded && t.id !== txn.id) ?? null;
    if (!nx) setMsg('読み込んだ分の未設定はこれで終わりです。');
    openTxn(nx);
  };

  const closeHint = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // 保存できなくても閉じるだけ
    }
  };

  // ---- 選択モードと一括の操作（#74 PR4）。スマホは「選択」か長押しで入り、PC は行頭のチェックを 1 つ入れると入る。 ----
  const selecting = wide ? sel.ids.size > 0 : mode || sel.ids.size > 0;
  const order = useMemo(() => (items ? groupByDate(items).flatMap((g) => g.items.map((t) => t.id)) : []), [items]);
  // 選択を変えたら結果の帯は消す（「次の操作」）。
  const changeSel = (s: Selection) => {
    setSel(s);
    setNotice(null);
    setSelMsg('');
  };
  const endSelect = () => {
    collectSeq.current++;
    setCollecting(false);
    setSel(emptySelection());
    setMode(false);
    setPicker(false);
    setSelMsg('');
  };
  // 絞り込みを変えたら選択を捨てる（見えない行を選んだまま一括にしない）。
  const changeFilter = (f: TxnFilter) => {
    endSelect();
    setFilter(f);
  };
  const act = (t: Txn, a: RowAction | null) => {
    if (a === 'open') openTxn(t);
    else if (a === 'toggle') changeSel(toggleSel(sel, t.id));
    else if (a === 'range') changeSel(rangeSel(sel, t.id, order));
  };
  const onLong = useRef<(id: string) => void>(() => {});
  onLong.current = (id) => {
    const t = items?.find((x) => x.id === id);
    if (!t) return;
    if (!selecting) setMode(true);
    act(t, rowAction({ wide, selecting, via: 'long' }));
  };
  const pressRef = useRef<ReturnType<typeof longPress> | null>(null);
  const press = (pressRef.current ??= longPress((id) => onLong.current(id)));
  useEffect(() => () => press.up(), []); // 離れたら長押しのタイマーを止める
  // 一括の後に 1 ページ目から読み直し、選択を見えている行だけに絞る（絞り込みを変えたら選択を捨てるのと揃える）。
  const reload = async () => {
    const xs = await load(filter, null);
    if (xs) setSel((s) => keepVisible(s, xs.map((t) => t.id)));
  };
  const onRow = (t: Txn) => {
    if (!wide && press.consumeClick()) return; // 長押しの後に来る click
    act(t, rowAction({ wide, selecting, via: 'tap' }));
  };
  const onAll = () => changeSel(wide && allSelected(sel, order) ? emptySelection() : selectAll(sel, order));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ignoreKey(e)) return;
      const a = escAction({ key: e.key, sheetOpen: open !== null, pickerOpen: picker, selecting });
      if (a === 'picker') setPicker(false);
      else if (a === 'clear') endSelect();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, picker, selecting]);

  // 結果の帯は 10 秒で消す（消えた後も「直前の一括を元に戻す」から戻せる）。
  useEffect(() => {
    if (!notice) return;
    const h = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(h);
  }, [notice]);

  const selectFiltered = async () => {
    const n = ++collectSeq.current;
    setCollecting(true);
    setSelMsg('');
    const r = await collectFiltered((c) => getJson<TxnPage>(txnsUrl(filter, today, c, FILTERED_PAGE)));
    if (n !== collectSeq.current) return; // 途中で絞り込みを変えた・選択をやめた
    setCollecting(false);
    if (r.kind === 'too_many') return setSelMsg(TOO_MANY_TEXT);
    if (r.kind === 'error') return setSelMsg(failText(r.status, r.body));
    setNotice(null);
    setSel((s) => ({ ids: new Set(r.ids), anchor: s.anchor }));
  };

  // 一括（tag だけか category だけ）。確定前の確認は出さない。選択はそのまま残す（続けてカテゴリも変えられる）。
  const runBulk = async (change: BulkChange) => {
    if (bulkBusy || collecting || sel.ids.size === 0) return;
    setPicker(false);
    if (sel.ids.size > BULK_MAX) return setNotice(plainNotice(TOO_MANY_TEXT));
    setBulkBusy(true);
    setNotice(null);
    const r = await postJson('/api/bank_txns/bulk_tag', bulkBody(sel.ids, change));
    setBulkBusy(false);
    if (r.status !== 200) return setNotice(plainNotice(failText(r.status, r.body)));
    const res = r.body as BulkTagResult;
    const n = bulkNotice(res);
    setNotice(n);
    if (n.undo) setLastBatch(n.undo);
    // ルールを学んだら同じ摘要の他の行も変わりうるので読み直す。それ以外は応答の effective で行だけ差し替える。
    if (res.learned_rules.length > 0) void reload();
    else setItems((cur) => (cur ? applyEffective(cur, res.effective) : cur));
  };

  const revert = async (batchId: string) => {
    if (bulkBusy) return;
    setBulkBusy(true);
    setNotice(null);
    const r = await postJson(`/api/bank_txns/bulk_tag/${encodeURIComponent(batchId)}/revert`, {});
    setBulkBusy(false);
    if (r.status === 200) {
      setLastBatch((b) => (b === batchId ? null : b));
      setNotice(revertNotice(r.body as RevertResult));
      void reload();
      return;
    }
    const known = revertFailText(r.status, r.body);
    // 409（戻せない・戻してある）と 404（無い一括）はもう戻せないので「直前の一括を元に戻す」を消す。
    if (known || r.status === 404) setLastBatch((b) => (b === batchId ? null : b));
    setNotice(plainNotice(known ?? failText(r.status, r.body)));
  };

  const deleteRules = async (ids: string[]) => {
    if (bulkBusy) return;
    setBulkBusy(true);
    let done = 0;
    let fail = '';
    for (const id of ids) {
      const r = await deleteJson(`/api/tag_rules/${encodeURIComponent(id)}`);
      if (r.status === 200 || r.status === 404) done++; // 404 はもう無い
      else fail = failText(r.status, r.body);
    }
    setBulkBusy(false);
    setNotice(plainNotice(fail ? `ルールを消せませんでした。${fail}` : `ルールを ${done} 件消しました`));
    void reload();
  };

  const dock = sel.ids.size > 0 || notice !== null;
  const undoLast = lastBatch !== null && notice?.undo !== lastBatch;
  const filtered = (wide || selecting) && cursor !== null && items ? countLabel({ n: items.length, more: true }) : null;

  return (
    <>
      {!wide && selecting ? (
        <SelectBand wide={false} count={sel.ids.size} allChecked={allSelected(sel, order)} onAll={onAll} onDone={endSelect} />
      ) : (
        <ScreenHead title="明細" flat onBack={onBack}>
          {!wide && items && items.length > 0 && (
            <button type="button" class="m-btn m-head-act" onClick={() => setMode(true)}>
              選択
            </button>
          )}
        </ScreenHead>
      )}
      <TxnFilters
        f={filter}
        q={q}
        expanded={expanded}
        unsetCount={unsetCount}
        accounts={accounts}
        cats={cats}
        onChange={changeFilter}
        onQ={setQ}
        onExpand={setExpanded}
      />
      <div class={dock ? 'm-main m-main-flush m-main-dock' : 'm-main m-main-flush'}>
        {(filtered !== null || undoLast || selMsg) && (
          <SelectTools filtered={filtered} busy={collecting || bulkBusy} notice={selMsg} undoLast={undoLast} onFiltered={() => void selectFiltered()} onUndoLast={() => lastBatch && void revert(lastBatch)} />
        )}
        {wide && items && items.length > 0 && <SelectBand wide count={sel.ids.size} allChecked={allSelected(sel, order)} onAll={onAll} onDone={endSelect} />}
        {msg && <p class="m-msg m-inline-msg">{msg}</p>}
        {items && items.length === 0 && <p class="m-empty">明細はありません。</p>}
        {items && items.length > 0 && (
          <TxnList
            items={items}
            f={filter}
            today={today}
            more={cursor !== null}
            cats={cats}
            busyIds={busyIds}
            hint={hint}
            sel={{ wide, selecting, ids: sel.ids }}
            press={wide ? undefined : press}
            onHint={closeHint}
            onOpen={onRow}
            onToggle={(t) => void toggle(t)}
            onCheck={(t, shift) => act(t, rowAction({ wide, selecting, via: 'check', shift }))}
          />
        )}
        {!items && <p class="m-empty">読み込み中…</p>}
        {cursor && (
          <div class="m-more">
            <button type="button" class="m-btn m-btn-round" disabled={loading} onClick={() => void load(filter, cursor)}>
              続きを読み込む
            </button>
          </div>
        )}
      </div>
      {dock && (
        <div class="m-dock">
          {notice && <BulkNoticeBand wide={wide} notice={notice} busy={bulkBusy} onUndo={(id) => void revert(id)} onDeleteRules={(ids) => void deleteRules(ids)} />}
          {sel.ids.size > 0 && (
            <BulkBar wide={wide} count={sel.ids.size} busy={bulkBusy || collecting} picker={picker} onTag={(tag) => void runBulk({ tag })} onPicker={setPicker} onClear={endSelect}>
              {picker && wide && <CategoryPicker wide count={sel.ids.size} cats={cats} onPick={(category) => void runBulk({ category })} onClose={() => setPicker(false)} />}
            </BulkBar>
          )}
        </div>
      )}
      {picker && !wide && sel.ids.size > 0 && <CategoryPicker wide={false} count={sel.ids.size} cats={cats} onPick={(category) => void runBulk({ category })} onClose={() => setPicker(false)} />}
      {open && (
        <TagSheet
          txn={open.txn}
          draft={open.draft}
          pos={unsetPosition(items ?? [], open.txn.id)}
          cats={cats}
          saving={saving}
          error={sheetErr}
          matches={open.txn.side === 'expense' ? matches : undefined}
          matchBusy={matchBusy}
          onDraft={(draft) => setOpen({ ...open, draft })}
          onSave={(n) => void save(n)}
          onClose={() => openTxn(null)}
          onLink={(id) => void changeMatch(id, true)}
          onUnlink={(id) => void changeMatch(id, false)}
          onCapture={onCapture}
        />
      )}
    </>
  );
}
