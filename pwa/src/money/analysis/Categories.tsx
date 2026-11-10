// カテゴリの管理（#74 PR5。台帳 bank_categories。docs/cashflow.md §5）。分析の画面の「カテゴリの管理」から開き、「戻る」で分析へ。
// 分析と同じチャンク（Analysis.tsx が出す）。殻の Categories が hooks と API、描画は CategoriesView（wide を受ける。SSR のスナップショットで試す）。
// 一覧（アーカイブしていないもの。台帳の順）: 色の点・名前・標準（builtin）の印・「上へ / 下へ」・「改名」・「色」・「アーカイブ」（other には出さない）。
// 「新しく作る」（名前と 12 色）。下に「アーカイブ済み (n)」の折りたたみ（「戻す」）。改名・色・新しく作るは同じシート（PC も同じ）。
// 並べ替えは隣と sort_order を入れ替える 2 件の PATCH（ドラッグは使わない）。変えるたびに台帳を読み直す（onChanged = Money の loadCats）。
// スマホと PC で出る項目・できる操作は同じで、並べ方だけ変える（PC は 1 行、スマホは名前の下にボタンの段）。
import { useState } from 'preact/hooks';
import { postJson } from '../../api.ts';
import { CategoryForm, Dot, newCategoryDraft, type CategoryDraft } from '../CategoryForm.tsx';
import { assignable, CATEGORY_COLORS, categoryLabelError, failText, type Categories as Cats, type CategoryItem } from '../model.ts';
import { ScreenHead } from '../Money.tsx';
import { useWide } from '../useWide.ts';
import { categoryColor } from './colors.ts';
import { Sheet } from './parts.tsx';

// 入力中の操作。new は id = null。
export type CatEdit = { kind: 'new' | 'rename' | 'color'; id: string | null; draft: CategoryDraft };
const UNARCHIVABLE = 'other';

const editTitle = (e: CatEdit, cats: Cats | null) => {
  const label = cats?.items.find((c) => c.id === e.id)?.label ?? '';
  return e.kind === 'new' ? '新しいカテゴリ' : e.kind === 'rename' ? `名前を変える（${label}）` : `色を変える（${label}）`;
};

// 隣と入れ替えるときの 2 件の PATCH（同じ sort_order なら動かす側を 1 つずらす）。
export function swapOrders(items: readonly CategoryItem[], id: string, dir: -1 | 1): { id: string; sort_order: number }[] {
  const i = items.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return [];
  const a = items[i]!;
  const b = items[j]!;
  const sa = a.sort_order ?? i;
  const sb = b.sort_order ?? j;
  if (sa === sb) return [{ id: a.id, sort_order: sb + dir }];
  return [
    { id: a.id, sort_order: sb },
    { id: b.id, sort_order: sa },
  ];
}

function CatRow({
  c,
  cats,
  first,
  last,
  busy,
  onMove,
  onEdit,
  onArchive,
}: {
  c: CategoryItem;
  cats: Cats | null;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (dir: -1 | 1) => void;
  onEdit: (kind: 'rename' | 'color') => void;
  onArchive: () => void;
}) {
  return (
    <li class="m-catman-row">
      <span class="m-catman-name">
        <Dot cls={categoryColor(cats, c.id)} />
        <b>{c.label}</b>
        {c.builtin && <span class="m-badge m-catman-std">標準</span>}
      </span>
      <span class="m-catman-acts">
        <button type="button" class="m-btn" aria-label={`${c.label}を上へ`} disabled={busy || first} onClick={() => onMove(-1)}>
          上へ
        </button>
        <button type="button" class="m-btn" aria-label={`${c.label}を下へ`} disabled={busy || last} onClick={() => onMove(1)}>
          下へ
        </button>
        <button type="button" class="m-btn" disabled={busy} onClick={() => onEdit('rename')}>
          改名
        </button>
        <button type="button" class="m-btn" disabled={busy} onClick={() => onEdit('color')}>
          色
        </button>
        {c.id !== UNARCHIVABLE && (
          <button type="button" class="m-btn" disabled={busy} onClick={onArchive}>
            アーカイブ
          </button>
        )}
      </span>
    </li>
  );
}

export function CategoriesView({
  wide,
  cats,
  busy,
  msg,
  edit,
  archivedOpen,
  onNew,
  onEdit,
  onDraft,
  onSubmit,
  onCancel,
  onMove,
  onArchive,
  onUnarchive,
  onArchivedOpen,
}: {
  wide: boolean;
  cats: Cats | null;
  busy: boolean;
  msg: string;
  edit: CatEdit | null;
  archivedOpen: boolean;
  onNew: () => void;
  onEdit: (id: string, kind: 'rename' | 'color') => void;
  onDraft: (d: CategoryDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onArchivedOpen: (open: boolean) => void;
}) {
  const active = assignable(cats);
  const archived = (cats?.items ?? []).filter((c) => c.archived);
  return (
    <div class={wide ? 'm-main m-catman m-catman-wide' : 'm-main m-catman'}>
      {msg && (
        <p class="m-msg" role="status">
          {msg}
        </p>
      )}
      {!cats && <p class="m-empty">読み込み中…</p>}
      {cats && (
        <section class="m-card" aria-labelledby="m-catman-h">
          <div class="m-row m-pad12">
            <h2 id="m-catman-h" class="m-h2">
              使っているカテゴリ（{active.length}）
            </h2>
            <button type="button" class="m-btn m-btn-primary" disabled={busy} onClick={onNew}>
              新しく作る
            </button>
          </div>
          <ul class="m-catman-list">
            {active.map((c, i) => (
              <CatRow
                key={c.id}
                c={c}
                cats={cats}
                first={i === 0}
                last={i === active.length - 1}
                busy={busy}
                onMove={(dir) => onMove(c.id, dir)}
                onEdit={(kind) => onEdit(c.id, kind)}
                onArchive={() => onArchive(c.id)}
              />
            ))}
          </ul>
        </section>
      )}
      {cats && archived.length > 0 && (
        <section class="m-card">
          <button type="button" class="m-catman-fold" aria-expanded={archivedOpen} aria-controls="m-catman-archived" onClick={() => onArchivedOpen(!archivedOpen)}>
            アーカイブ済み ({archived.length})
          </button>
          {archivedOpen && (
            <ul class="m-catman-list" id="m-catman-archived">
              {archived.map((c) => (
                <li key={c.id} class="m-catman-row">
                  <span class="m-catman-name">
                    <Dot cls={categoryColor(cats, c.id)} />
                    <b>{c.label}</b>
                    {c.builtin && <span class="m-badge m-catman-std">標準</span>}
                  </span>
                  <span class="m-catman-acts">
                    <button type="button" class="m-btn" disabled={busy} onClick={() => onUnarchive(c.id)}>
                      戻す
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <p class="m-sub13 m-pad12">アーカイブしたカテゴリは新しく付けられなくなります。付いている明細・集計はそのままです。</p>
      {edit && (
        <Sheet id="m-catman-edit" title={editTitle(edit, cats)} onClose={onCancel}>
          <CategoryForm
            idp="m-catman-form"
            draft={edit.draft}
            showLabel={edit.kind !== 'color'}
            showColor={edit.kind !== 'rename'}
            busy={busy}
            submitLabel={edit.kind === 'new' ? '作る' : '変える'}
            onDraft={onDraft}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        </Sheet>
      )}
    </div>
  );
}

export function Categories({ cats, onChanged, onBack }: { cats: Cats | null; onChanged: () => Promise<void>; onBack: () => void }) {
  const wide = useWide();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState<CatEdit | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  // 書いて台帳を読み直す。失敗したら最初の失敗の理由を返す（''は成功）。
  const write = async (calls: { url: string; body: unknown; method?: 'POST' | 'PATCH' }[]): Promise<string> => {
    setBusy(true);
    setMsg('');
    let fail = '';
    for (const c of calls) {
      const r = await postJson(c.url, c.body, c.method ?? 'POST');
      if (r.status !== 200 && r.status !== 201) {
        fail = failText(r.status, r.body);
        break;
      }
    }
    await onChanged();
    setBusy(false);
    return fail;
  };
  const url = (id: string, tail = '') => `/api/categories/${encodeURIComponent(id)}${tail}`;

  const submit = async () => {
    if (!edit || busy) return;
    const d = edit.draft;
    if (edit.kind !== 'color') {
      const bad = categoryLabelError(d.label);
      if (bad) return setEdit({ ...edit, draft: { ...d, error: bad } });
    }
    const call =
      edit.kind === 'new'
        ? { url: '/api/categories', body: { label: d.label.trim(), color: d.color } }
        : { url: url(edit.id!), method: 'PATCH' as const, body: edit.kind === 'rename' ? { label: d.label.trim() } : { color: d.color } };
    const fail = await write([call]);
    if (fail) setEdit({ ...edit, draft: { ...d, error: fail } });
    else setEdit(null);
  };

  const run = async (calls: Parameters<typeof write>[0]) => {
    if (busy || calls.length === 0) return;
    const fail = await write(calls);
    if (fail) setMsg(fail);
  };

  return (
    <>
      <ScreenHead title="カテゴリの管理" backLabel="分析に戻る" onBack={onBack} />
      <CategoriesView
        wide={wide}
        cats={cats}
        busy={busy}
        msg={msg}
        edit={edit}
        archivedOpen={archivedOpen}
        onNew={() => setEdit({ kind: 'new', id: null, draft: newCategoryDraft(assignable(cats).length % CATEGORY_COLORS) })}
        onEdit={(id, kind) => {
          const c = cats?.items.find((x) => x.id === id);
          if (c) setEdit({ kind, id, draft: { label: c.label, color: c.color ?? 0, error: '' } });
        }}
        onDraft={(draft) => edit && setEdit({ ...edit, draft })}
        onSubmit={() => void submit()}
        onCancel={() => setEdit(null)}
        onMove={(id, dir) => void run(swapOrders(assignable(cats), id, dir).map((p) => ({ url: url(p.id), method: 'PATCH', body: { sort_order: p.sort_order } })))}
        onArchive={(id) => void run([{ url: url(id, '/archive'), body: {} }])}
        onUnarchive={(id) => void run([{ url: url(id, '/unarchive'), body: {} }])}
        onArchivedOpen={setArchivedOpen}
      />
    </>
  );
}
