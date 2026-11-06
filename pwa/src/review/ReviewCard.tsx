// 確認カード（docs/mvp-plan.md T2-10、a2ui-review-ui.md §2.1・§3.7）。surface の固定部品だけを描画する。
// - 文字列はすべて JSX のテキストとして描画する（HTML・URL・画像の参照として扱わない）。画像は自分のサーバーのサムネイルだけ。
// - 縦 1 画面: 上にサムネイルと金額、中に日付・取引先・科目チップ・支払手段、下（親指の範囲）に確定の大ボタンと私用・重複。
// - スキャン（dataModel.integrity_checked がある）だけ「欠け・折れ・裏面を確認した」のチェックを出す（T004）。
// - 辞書や AI の第 1 候補が正しければ 1 タップ（確定）、第 2・第 3 候補は 2 タップ、修正は各行をタップして入力欄。
import { useState } from 'preact/hooks';
import { findComponent, renderableComponents, type DecisionAction } from './catalog.ts';
import {
  ACTION_LABELS,
  canApprove,
  daysLeftText,
  formatAmount,
  isUrgent,
  missingRequired,
  FIELD_LABELS,
  parseAmount,
  pickCandidate,
  TAX_LABELS,
  type CardResponse,
  type Values,
} from './model.ts';

type Props = { card: CardResponse; busy: boolean; onDecide: (action: DecisionAction, draft: Values, integrityChecked?: boolean) => void };
type Editing = 'amount' | 'date' | 'vendor' | null;

export function ReviewCard({ card, busy, onDecide }: Props) {
  const comps = renderableComponents(card.surface);
  const dm = card.dataModel;
  const [draft, setDraft] = useState<Values>(dm.values);
  const [editing, setEditing] = useState<Editing>(null);
  const [zoom, setZoom] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState(dm.integrity_checked ?? false);
  const isScan = dm.integrity_checked !== undefined;
  const set = (patch: Partial<Values>) => setDraft((d) => ({ ...d, ...patch }));

  const thumb = findComponent(comps, 'ReceiptThumb');
  const amount = findComponent(comps, 'AmountField');
  const date = findComponent(comps, 'DateField');
  const vendor = findComponent(comps, 'VendorField');
  const chips = findComponent(comps, 'AccountChips');
  const accountSheet = findComponent(comps, 'AccountSheet');
  const payment = findComponent(comps, 'PaymentChips');
  const bar = findComponent(comps, 'DecisionBar');
  const accountName = (id: string | null) => (id === null ? '―' : (dm.accounts.find((a) => a.id === id)?.name ?? id));
  const inChips = chips?.candidates.some((c) => c.account_id === draft.account_id) ?? false;
  const missing = missingRequired(draft);
  const filtered = dm.accounts.filter((a) => a.name.includes(query.trim()));

  return (
    <section class="card">
      <div class="card-top">
        {thumb && (
          <button type="button" class={zoom ? 'thumb thumb-zoom' : 'thumb'} onClick={() => setZoom(!zoom)} aria-label="画像を拡大">
            <img src={`/api/documents/${encodeURIComponent(thumb.document_id)}/thumbnail`} alt="領収書" />
          </button>
        )}
        <div class="card-head">
          {amount &&
            (editing === 'amount' ? (
              <input
                class="date amount-input"
                inputMode="decimal"
                autoFocus
                value={draft.amount === null ? '' : String(draft.amount)}
                onChange={(e) => {
                  set({ amount: parseAmount((e.currentTarget as HTMLInputElement).value) });
                  setEditing(null);
                }}
              />
            ) : (
              <button type="button" class="amount" onClick={() => setEditing('amount')}>
                {formatAmount(draft.amount)}
              </button>
            ))}
          {amount && amount.by_rate.length > 0 && (
            <p class="sub">{amount.by_rate.map((r) => `${TAX_LABELS[r.category]} ${formatAmount(r.amount_incl_tax)}`).join(' / ')}</p>
          )}
          <p class={isUrgent(dm.days_left) ? 'sub urgent' : 'sub'}>{daysLeftText(dm.days_left)}</p>
          {dm.warnings.includes('amount_mismatch') && <p class="sub urgent">内訳の和が合計と合いません</p>}
        </div>
      </div>

      {date && (
        <div class="row">
          <span class="label">日付</span>
          {editing === 'date' ? (
            <input
              class="date"
              type="date"
              autoFocus
              value={draft.txn_date ?? ''}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                set({ txn_date: v === '' ? null : v });
                setEditing(null);
              }}
            />
          ) : (
            <button type="button" class="row-value" onClick={() => setEditing('date')}>
              {draft.txn_date ?? '―'}
            </button>
          )}
        </div>
      )}

      {vendor && (
        <div class="row">
          <span class="label">取引先</span>
          {editing === 'vendor' ? (
            <div class="fields">
              <input class="date" value={draft.vendor ?? ''} maxLength={100} onInput={(e) => set({ vendor: (e.currentTarget as HTMLInputElement).value || null })} />
              <input
                class="date"
                placeholder="登録番号 T + 13 桁"
                value={draft.invoice_reg_no ?? ''}
                maxLength={20}
                onInput={(e) => {
                  const v = (e.currentTarget as HTMLInputElement).value.trim();
                  set({ invoice_reg_no: v === '' ? null : v, qualified_invoice: v !== '' });
                }}
              />
              <button type="button" class="btn" onClick={() => setEditing(null)}>
                閉じる
              </button>
            </div>
          ) : (
            <button type="button" class="row-value" onClick={() => setEditing('vendor')}>
              {draft.vendor ?? '―'}
              {draft.invoice_reg_no ? `（${draft.invoice_reg_no}）` : ''}
            </button>
          )}
        </div>
      )}

      {chips && (
        <div class="chips" role="group" aria-label="科目">
          {chips.candidates.map((c) => (
            <button type="button" key={c.account_id} class={draft.account_id === c.account_id ? 'chip seg-on' : 'chip'} onClick={() => setDraft(pickCandidate(draft, c))}>
              {c.name}
            </button>
          ))}
          {accountSheet && (
            <button type="button" class={!inChips && draft.account_id !== null ? 'chip seg-on' : 'chip'} onClick={() => setSheet(true)}>
              {!inChips && draft.account_id !== null ? accountName(draft.account_id) : '他の科目…'}
            </button>
          )}
        </div>
      )}

      {payment && (
        <div class="chips" role="group" aria-label="支払手段">
          {payment.options.map((o) => (
            <button type="button" key={o.id} class={draft.payment === o.id ? 'chip seg-on' : 'chip'} onClick={() => set({ payment: o.id })}>
              {o.label}
            </button>
          ))}
        </div>
      )}

      {sheet && accountSheet && (
        <div class="sheet" role="dialog" aria-label="科目を選ぶ">
          <input class="date" placeholder="科目を検索" autoFocus value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
          <ul class="list sheet-list">
            {filtered.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  class="btn"
                  onClick={() => {
                    set({ account_id: a.id, tax_id: a.private ? 'out_of_scope' : draft.tax_id });
                    setSheet(false);
                    setQuery('');
                  }}
                >
                  {a.name}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" class="btn" onClick={() => setSheet(false)}>
            閉じる
          </button>
        </div>
      )}

      {isScan && (
        <label class="toggle">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked((e.currentTarget as HTMLInputElement).checked)} />
          <span>欠け・折れ・裏面を確認した</span>
        </label>
      )}

      {bar && (
        <div class="bottom decision">
          {missing.length > 0 && bar.actions.includes('approve') && <p class="sub">未入力: {missing.map((f) => FIELD_LABELS[f]).join('・')}</p>}
          {bar.actions.includes('approve') && (
            <button type="button" class="btn btn-primary btn-big" disabled={busy || !canApprove(draft)} onClick={() => onDecide('approve', draft, isScan ? checked : undefined)}>
              {ACTION_LABELS.approve}
            </button>
          )}
          <div class="row-btns row-btns-even">
            {bar.actions
              .filter((a) => a !== 'approve')
              .map((a) => (
                <button type="button" key={a} class="btn" disabled={busy} onClick={() => onDecide(a, draft)}>
                  {ACTION_LABELS[a]}
                </button>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}
