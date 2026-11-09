// 明細の選択モードと一括の操作の描画だけの部品（#74 PR4。docs/cashflow.md §5）。hooks は使わず、幅は wide で受ける（判定は Txns.tsx の useWide）。
// スマホ（wide=false）と PC（wide=true）で出る数値・できる操作は同じで、並べ方だけ変える。
// - SelectBand: 上の帯。スマホは画面のヘッダの代わりに「n 件選択中 ・ すべて選択 ・ 完了」。PC は一覧の上の行で、チェック（見えている行をすべて）・件数・完了。
// - SelectTools: 一覧の上の小さな段。「絞り込み結果をすべて選択（n 件）」・その案内（500 件を超えた等）・「直前の一括を元に戻す」。
// - BulkBar: 選択中に画面の下（下タブのすぐ上）に固定する操作の帯。「n 件」/ 事業・私用・未設定 /「カテゴリ ▾」/「選択を外す」。
// - CategoryPicker: カテゴリ（固定 13 種 + 未分類）。スマホはボトムシート、PC は「カテゴリ ▾」の上の小さなポップオーバー。
// - BulkNoticeBand: 結果の帯。「n 件を変えました（m 件は変わらず）・元に戻す」「ルールを k 件作りました・消す」。
import type { ComponentChildren } from 'preact';
import { Icon } from './Icons.tsx';
import { categoryLabel, TAG_LABELS, TAG_ORDER, type Categories, type Tag } from './model.ts';
import type { BulkNotice } from './selection.ts';

export function SelectBand({
  wide,
  count,
  allChecked,
  onAll,
  onDone,
}: {
  wide: boolean;
  count: number;
  // 見えている行がすべて選ばれている（PC のチェックの状態）
  allChecked: boolean;
  onAll: () => void;
  onDone: () => void;
}) {
  if (!wide)
    return (
      <header class="m-head m-head-flat m-selhead">
        <h1 aria-live="polite">{count} 件選択中</h1>
        <button type="button" class="m-btn" onClick={onAll}>
          すべて選択
        </button>
        <button type="button" class="m-btn m-btn-primary" onClick={onDone}>
          完了
        </button>
      </header>
    );
  return (
    <div class="m-selrow">
      <span class="m-checkwrap" onClick={onAll}>
        <input type="checkbox" class="m-check" checked={allChecked} aria-label="すべて選択（見えている行）" />
      </span>
      <span class="m-selrow-text" aria-live="polite">
        {count > 0 ? `${count} 件選択中` : 'すべて選択'}
      </span>
      {count > 0 && (
        <button type="button" class="m-btn" onClick={onDone}>
          完了
        </button>
      )}
    </div>
  );
}

export function SelectTools({
  filtered,
  busy,
  notice,
  undoLast,
  onFiltered,
  onUndoLast,
}: {
  // 「絞り込み結果をすべて選択（n 件）」の n（null なら出さない。続きが無ければ見えている行の全選択と同じなので出さない）
  filtered: string | null;
  busy: boolean;
  notice: string;
  undoLast: boolean;
  onFiltered: () => void;
  onUndoLast: () => void;
}) {
  return (
    <div class="m-seltools">
      {filtered !== null && (
        <button type="button" class="m-btn" disabled={busy} onClick={onFiltered}>
          絞り込み結果をすべて選択（{filtered} 件）
        </button>
      )}
      {undoLast && (
        <button type="button" class="m-btn" disabled={busy} onClick={onUndoLast}>
          直前の一括を元に戻す
        </button>
      )}
      {notice && (
        <p class="m-msg" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

export function BulkBar({
  wide,
  count,
  busy,
  picker,
  onTag,
  onPicker,
  onClear,
  children,
}: {
  wide: boolean;
  count: number;
  busy: boolean;
  // カテゴリの一覧を開いている（PC のポップオーバーは children で「カテゴリ ▾」の上に出す）
  picker: boolean;
  onTag: (t: Tag) => void;
  onPicker: (open: boolean) => void;
  onClear: () => void;
  children?: ComponentChildren;
}) {
  return (
    <div class={wide ? 'm-bulkbar m-bulkbar-wide' : 'm-bulkbar'} role="toolbar" aria-label="選択した明細の操作">
      <span class="m-bulk-count">{count} 件</span>
      <div class="m-bulk-tags" role="group" aria-label="タグ">
        {TAG_ORDER.map((t) => (
          <button type="button" key={t} class="m-btn" disabled={busy} onClick={() => onTag(t)}>
            {TAG_LABELS[t]}
          </button>
        ))}
      </div>
      <span class="m-bulk-catwrap">
        <button type="button" class="m-btn m-bulk-cat" aria-expanded={picker} aria-haspopup="dialog" disabled={busy} onClick={() => onPicker(!picker)}>
          カテゴリ ▾
        </button>
        {children}
      </span>
      <button type="button" class="m-btn m-bulk-clear" disabled={busy} onClick={onClear}>
        選択を外す
      </button>
    </div>
  );
}

export function CategoryPicker({
  wide,
  count,
  cats,
  onPick,
  onClose,
}: {
  wide: boolean;
  count: number;
  cats: Categories | null;
  onPick: (category: string | null) => void;
  onClose: () => void;
}) {
  const grid = (
    <div class="m-catgrid">
      {(cats?.items ?? []).map((c) => (
        <button type="button" key={c.id} onClick={() => onPick(c.id)}>
          {c.label}
        </button>
      ))}
      <button type="button" onClick={() => onPick(null)}>
        {categoryLabel(cats, null)}
      </button>
    </div>
  );
  if (wide)
    return (
      <>
        <div class="m-pop-catch" onClick={onClose} />
        <div class="m-pop" role="dialog" aria-label={`カテゴリを変える（${count} 件）`}>
          {grid}
        </div>
      </>
    );
  return (
    <>
      <div class="m-scrim" onClick={onClose} />
      <section class="m-sheet" role="dialog" aria-modal="true" aria-labelledby="m-catpick-title">
        <div class="m-grip" aria-hidden="true">
          <span />
        </div>
        <div class="m-sheet-head">
          <h2 id="m-catpick-title">カテゴリを変える（{count} 件）</h2>
          <button type="button" class="m-icon" aria-label="閉じる" onClick={onClose}>
            <Icon name="close" size={22} />
          </button>
        </div>
        <div class="m-sheet-body">{grid}</div>
      </section>
    </>
  );
}

export function BulkNoticeBand({
  wide,
  notice,
  busy,
  onUndo,
  onDeleteRules,
}: {
  wide: boolean;
  notice: BulkNotice;
  busy: boolean;
  onUndo: (batchId: string) => void;
  onDeleteRules: (ids: string[]) => void;
}) {
  return (
    <div class={wide ? 'm-bulknote m-bulknote-wide' : 'm-bulknote'} role="status">
      <p>
        <span>{notice.text}</span>
        {notice.undo !== null && (
          <button type="button" class="m-bulknote-act" disabled={busy} onClick={() => onUndo(notice.undo!)}>
            元に戻す
          </button>
        )}
      </p>
      {notice.rules.length > 0 && (
        <p>
          <span>{notice.rulesText}</span>
          <button type="button" class="m-bulknote-act" disabled={busy} onClick={() => onDeleteRules(notice.rules)}>
            消す
          </button>
        </p>
      )}
    </div>
  );
}
