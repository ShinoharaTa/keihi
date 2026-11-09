// 明細の選択モードと一括の操作の純関数（docs/cashflow.md §5 の一括の上書き・取り消し、#74 PR4）。描画（Txns.tsx・BulkBar.tsx）から使い、
// テスト（test/unit/money-select.test.ts）からも直接読む。
// 選択は Set<string>（明細 id）と anchor（最後に単独で選んだ行。範囲選択の起点）。範囲・全選択は「今見えている行の順」（order）で決める。
import { applyTag, type Tag, type Txn, type TxnPage } from './model.ts';

export type Selection = { ids: ReadonlySet<string>; anchor: string | null };

export const emptySelection = (): Selection => ({ ids: new Set(), anchor: null });

// 1 件の切り替え。選んだら anchor をその行に、外したときは anchor を変えない。
export function toggleSel(s: Selection, id: string): Selection {
  const ids = new Set(s.ids);
  if (ids.has(id)) {
    ids.delete(id);
    return { ids, anchor: s.anchor };
  }
  ids.add(id);
  return { ids, anchor: id };
}

// anchor から id まで（両端を含む。順方向・逆方向どちらも）を選ぶ。anchor が無いか見えていなければ 1 件の切り替えと同じ。anchor は変えない。
export function rangeSel(s: Selection, id: string, order: readonly string[]): Selection {
  const a = s.anchor === null ? -1 : order.indexOf(s.anchor);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) return toggleSel(s, id);
  const ids = new Set(s.ids);
  for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) ids.add(x);
  return { ids, anchor: s.anchor };
}

// 見えている行をすべて選ぶ（前から選んでいた見えない行も残す）。
export function selectAll(s: Selection, order: readonly string[]): Selection {
  return { ids: new Set([...s.ids, ...order]), anchor: s.anchor };
}

export const allSelected = (s: Selection, order: readonly string[]) => order.length > 0 && order.every((id) => s.ids.has(id));

export const clearSel = emptySelection;

// 一覧を読み直した後、見えている行だけに絞る（anchor も見えていなければ外す）。何も落ちなければ同じものを返す。
export function keepVisible(s: Selection, visible: readonly string[]): Selection {
  const v = new Set(visible);
  const ids = [...s.ids].filter((id) => v.has(id));
  const anchor = s.anchor !== null && v.has(s.anchor) ? s.anchor : null;
  return ids.length === s.ids.size && anchor === s.anchor ? s : { ids: new Set(ids), anchor };
}

// 長押しを計測するのは主のポインタの主ボタン（左クリック・指 1 本目）だけ。
export const pressStarts = (e: { isPrimary: boolean; button: number }) => e.isPrimary && e.button === 0;

// Esc を拾わない場面: IME の変換中、入力欄（input・textarea・select）にいるとき。行と上の帯のチェック（checkbox）は入力欄に数えない
// （PC でチェックを入れた直後はそこにフォーカスがあり、Esc で外せないと困るため）。
export const ignoreKey = (e: { isComposing: boolean; target: unknown }) => {
  const el = typeof e.target === 'object' && e.target !== null ? (e.target as { tagName?: unknown; type?: unknown }) : null;
  if (e.isComposing) return true;
  if (el?.tagName === 'INPUT') return el.type !== 'checkbox';
  return el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT';
};

// ---- 行の操作の決め方 ----

// スマホ（wide=false）: モード外の押下は開く、長押しはモードに入ってその行を選ぶ。モード中の押下は切り替え、長押しは anchor からその行まで。
// PC（wide=true）: 行のチェックで切り替え（Shift で範囲）。行のチェック以外はモードにかかわらず開く（長押しは使わない）。
export type RowAction = 'open' | 'toggle' | 'range';
export function rowAction(x: { wide: boolean; selecting: boolean; via: 'tap' | 'long' | 'check'; shift?: boolean }): RowAction | null {
  if (x.via === 'check') return x.shift ? 'range' : 'toggle';
  if (x.wide) return x.via === 'tap' ? 'open' : null;
  if (x.via === 'long') return x.selecting ? 'range' : 'toggle';
  return x.selecting ? 'toggle' : 'open';
}

// Esc: カテゴリの一覧を開いていればそれを閉じ、無ければ選択を外す。タグ付けシートを開いている間はシートに任せる。
export function escAction(x: { key: string; sheetOpen: boolean; pickerOpen: boolean; selecting: boolean }): 'picker' | 'clear' | null {
  if (x.key !== 'Escape' || x.sheetOpen) return null;
  if (x.pickerOpen) return 'picker';
  return x.selecting ? 'clear' : null;
}

// ---- 長押し（pointerdown から 500ms。指が 10px 以上動くか離すか取り消されたら止める。スクロール中は pointercancel で止まる） ----

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP = 10;

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

// 行ごとではなく一覧で 1 つ持つ。発火した後の click（指を離したときに来る）は consumeClick() で 1 回だけ捨てる。
export function longPress(onLong: (id: string) => void, timers: Timers = realTimers) {
  let timer: unknown = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const stop = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    start = null;
  };
  return {
    down(id: string, x: number, y: number) {
      stop();
      fired = false;
      start = { x, y };
      timer = timers.set(() => {
        timer = null;
        start = null;
        fired = true;
        onLong(id);
      }, LONG_PRESS_MS);
    },
    move(x: number, y: number) {
      if (start && Math.hypot(x - start.x, y - start.y) >= LONG_PRESS_SLOP) stop();
    },
    // pointerup・pointercancel・pointerleave
    up: stop,
    consumeClick(): boolean {
      const f = fired;
      fired = false;
      return f;
    },
  };
}

// ---- 絞り込み結果をすべて選ぶ ----

export const BULK_MAX = 500;
export const FILTERED_PAGE = 100;

export type Collected = { kind: 'ok'; ids: string[] } | { kind: 'too_many' } | { kind: 'error'; status: number; body: unknown };

// 今の絞り込みで next_cursor をたどって id を集める。BULK_MAX を超えたら選ばない（too_many）。page は 1 ページ（limit=FILTERED_PAGE）を読む。
// 読むのは FILTERED_MAX_PAGES ページまで（読み切れなければ 500 件以内と言えないので too_many）。同じ cursor が返ってきたら止める（invalid_cursor）。
export const FILTERED_MAX_PAGES = Math.ceil(BULK_MAX / FILTERED_PAGE) + 1;
export async function collectFiltered(
  page: (cursor: string | null) => Promise<{ ok: true; data: TxnPage } | { ok: false; status: number; body: unknown }>,
): Promise<Collected> {
  const ids = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let n = 0; n < FILTERED_MAX_PAGES; n++) {
    const r = await page(cursor);
    if (!r.ok) return { kind: 'error', status: r.status, body: r.body };
    for (const t of r.data.items) ids.add(t.id);
    if (ids.size > BULK_MAX) return { kind: 'too_many' };
    const next = r.data.next_cursor;
    if (!next) return { kind: 'ok', ids: [...ids] };
    if (seen.has(next) || next === cursor) return { kind: 'error', status: 400, body: { error: 'invalid_cursor' } };
    seen.add(next);
    cursor = next;
  }
  return { kind: 'too_many' };
}

export const TOO_MANY_TEXT = `${BULK_MAX} 件までです。絞り込んでください。`;

// ---- 一括の結果（POST /api/bank_txns/bulk_tag・/revert。src/web/routes/tags.ts） ----

export type BulkTagResult = {
  batch_id: string | null;
  changed: number;
  unchanged: number;
  learned_rules: { rule: { id: string }; action: 'created' | 'hit' | 'superseded' }[];
  effective: { id: string; tag: Tag; category: string | null; tag_source: string }[];
};
export type RevertResult = { batch_id: string; revert_batch_id: string; reverted: number; skipped: number; learned_rule_ids: string[] };

// 本文: tag だけか category だけ（null は未分類）。
export type BulkChange = { tag: Tag } | { category: string | null };
export const bulkBody = (ids: Iterable<string>, change: BulkChange) => ({ ids: [...ids], ...change });

// 結果の帯。undo は戻せる一括の batch_id、rules は「消す」で消すルールの id（その一括で新しく作ったものだけ。hit・superseded は前からあるルール）。
export type BulkNotice = { text: string; undo: string | null; rules: string[]; rulesText: string };

export function bulkNotice(r: BulkTagResult): BulkNotice {
  const rules = r.learned_rules.filter((l) => l.action === 'created').map((l) => l.rule.id);
  const text = r.changed === 0 ? `変わった明細はありません（${r.unchanged} 件は変わらず）` : `${r.changed} 件を変えました${r.unchanged > 0 ? `（${r.unchanged} 件は変わらず）` : ''}`;
  return { text, undo: r.changed > 0 ? r.batch_id : null, rules, rulesText: rules.length > 0 ? `ルールを ${rules.length} 件作りました` : '' };
}

// 取り消しの結果。学習は取り消さないので、その一括で作ったルールが残っていれば「消す」を出す。
export function revertNotice(r: RevertResult): BulkNotice {
  const text = `${r.reverted} 件を元に戻しました${r.skipped > 0 ? `（${r.skipped} 件は後から変更済みのため戻せません）` : ''}`;
  const rules = r.learned_rule_ids;
  return { text, undo: null, rules, rulesText: rules.length > 0 ? `この一括で作ったルール ${rules.length} 件は残っています` : '' };
}

// 取り消しの失敗（409 の理由）。
export function revertFailText(status: number, body: unknown): string | null {
  const err = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null;
  if (status === 409 && err === 'nothing_to_revert') return 'すべて後から変更済みのため戻せません';
  if (status === 409 && err === 'already_reverted') return 'もう戻してあります';
  return null;
}

export const plainNotice = (text: string): BulkNotice => ({ text, undo: null, rules: [], rulesText: '' });

// 一括の応答の effective で行を差し替える（1 件のときの applyTag と同じく、事業でなくなったら receipt を外す）。
export function applyEffective(items: Txn[], effective: BulkTagResult['effective']): Txn[] {
  const by = new Map(effective.map((e) => [e.id, e]));
  return items.map((t) => {
    const e = by.get(t.id);
    return e ? applyTag([t], t.id, { effective: { tag: e.tag, category: e.category, source: e.tag_source } })[0]! : t;
  });
}

export const NOTICE_MS = 10_000;
