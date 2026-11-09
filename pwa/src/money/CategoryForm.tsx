// カテゴリの名前と色の入力（描画だけ。hooks は使わない）。一括の「新しく作る…」（BulkBar.tsx の CategoryPicker）と
// カテゴリの管理（analysis/Categories.tsx）の「新しく作る」「改名」「色」で使う。label・color のどちらかだけ出すこともできる（null で隠す）。
// 色は 12 色（style.css の k-0〜k-11）から 1 つ。送信は POST / PATCH /api/categories（呼ぶ側）。
import { CATEGORY_COLORS, CATEGORY_LABEL_MAX } from './model.ts';

export type CategoryDraft = { label: string; color: number; error: string };
export const newCategoryDraft = (color = 0): CategoryDraft => ({ label: '', color, error: '' });

// 色の点（明細の TagSheet・一括の CategoryPicker・カテゴリの管理の行）。cls は colors.ts の categoryColor。
export const Dot = ({ cls }: { cls: string }) => <span class={`m-dot ${cls}`} aria-hidden="true" />;

export function CategoryForm({
  idp,
  draft,
  showLabel = true,
  showColor = true,
  busy,
  submitLabel,
  onDraft,
  onSubmit,
  onCancel,
}: {
  // id の接頭辞（同じ画面に 2 つ出しても重ならないように）
  idp: string;
  draft: CategoryDraft;
  showLabel?: boolean;
  showColor?: boolean;
  busy: boolean;
  submitLabel: string;
  onDraft: (d: CategoryDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      class="m-catform"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {showLabel && (
        <label class="m-field-wrap" for={`${idp}-label`}>
          <span class="m-label">名前（{CATEGORY_LABEL_MAX} 字まで）</span>
          <input
            id={`${idp}-label`}
            class="m-field"
            maxLength={CATEGORY_LABEL_MAX}
            placeholder="例: ペット"
            value={draft.label}
            onInput={(e) => onDraft({ ...draft, label: e.currentTarget.value, error: '' })}
          />
        </label>
      )}
      {showColor && (
        <fieldset class="m-fs m-fs-sm">
          <legend>色</legend>
          <div class="m-colors">
            {Array.from({ length: CATEGORY_COLORS }, (_, i) => (
              <button type="button" key={i} class={`k-${i}`} aria-label={`色 ${i + 1}`} aria-pressed={draft.color === i} onClick={() => onDraft({ ...draft, color: i, error: '' })} />
            ))}
          </div>
        </fieldset>
      )}
      {draft.error && (
        <p class="m-msg" role="alert">
          {draft.error}
        </p>
      )}
      <div class="m-grid2">
        <button type="button" class="m-btn" disabled={busy} onClick={onCancel}>
          やめる
        </button>
        <button type="submit" class="m-btn m-btn-primary" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
