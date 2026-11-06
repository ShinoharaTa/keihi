// 確認待ち一覧と確認カード（docs/mvp-plan.md T2-10・T2-11）。
// - 確認待ちは期限の近い順（2 営業日以内は強調）。要対応（GET /api/attention）は「要対応」タブで理由と
//   「もう一度試す」（retry）・「対応済みにする」（dismiss）を出す（T4-5）。
// - 項目を押すとカード。確定したら次の確認待ちを自動で開く（a2ui-review-ui.md §3.7）。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getJson, postJson } from '../api.ts';
import type { DecisionAction } from './catalog.ts';
import { ACTION_LABELS, ATTENTION_URL, reasonText, resolveMessage, resolveUrl, type AttentionAction, type AttentionItem } from './attention.ts';
import { ReviewCard } from './ReviewCard.tsx';
import { daysLeftText, ENDPOINTS, errorText, isUrgent, requestBody, type CardResponse, type Values } from './model.ts';

export type ListItem = { id: string; received_on: string; status: string; deadline_on: string; days_left: number; needs_attention_reason: string | null };

export function ReviewList({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [view, setView] = useState<'review' | 'attention'>('review');
  const [card, setCard] = useState<CardResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async (): Promise<ListItem[]> => {
    const [r, a] = await Promise.all([
      getJson<{ items: ListItem[] }>('/api/documents?status=review'),
      getJson<{ items: AttentionItem[] }>(ATTENTION_URL),
    ]);
    if (!r.ok) setMsg(`サーバーから読めませんでした（${r.status === 0 ? '通信できない' : `HTTP ${r.status}`}）`);
    const list = r.ok ? r.data.items : [];
    setItems(r.ok ? list : null);
    setAttention(a.ok ? a.data.items : []);
    return list;
  }, []);

  const open = useCallback(async (id: string) => {
    const r = await getJson<CardResponse>(`/api/documents/${encodeURIComponent(id)}/card`);
    if (r.ok) setCard(r.data);
    else setMsg(`カードを読めませんでした（HTTP ${r.status}）`);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (action: DecisionAction, draft: Values, integrityChecked?: boolean) => {
    if (!card) return;
    setBusy(true);
    const id = card.dataModel.document_id;
    const r = await postJson(`/api/documents/${encodeURIComponent(id)}/${ENDPOINTS[action]}`, requestBody(card.card_id, card.dataModel, draft, integrityChecked));
    setBusy(false);
    if (r.status === 200) {
      setMsg('');
      setCard(null);
      onChanged();
      const next = (await load()).find((x) => x.id !== id);
      if (next) await open(next.id);
      return;
    }
    setMsg(errorText(r.status, r.body));
    if (r.status === 409) await open(id);
  };

  const resolve = async (documentId: string, action: AttentionAction) => {
    setBusy(true);
    const r = await postJson(resolveUrl(documentId), { action });
    setBusy(false);
    setMsg(resolveMessage(action, r.status));
    onChanged();
    await load();
  };

  if (card) {
    return (
      <section class="screen">
        <button type="button" class="btn" onClick={() => setCard(null)}>
          一覧へ戻る
        </button>
        {msg && <p class="msg">{msg}</p>}
        <ReviewCard key={card.card_id} card={card} busy={busy} onDecide={(a, d, ic) => void decide(a, d, ic)} />
      </section>
    );
  }

  return (
    <section class="screen">
      {msg && <p class="msg">{msg}</p>}
      <div class="seg" role="group" aria-label="一覧">
        <button type="button" class={view === 'review' ? 'seg-on' : ''} onClick={() => setView('review')}>
          確認待ち{items && items.length ? `（${items.length}）` : ''}
        </button>
        <button type="button" class={view === 'attention' ? 'seg-on' : ''} onClick={() => setView('attention')}>
          要対応{attention.length ? `（${attention.length}）` : ''}
        </button>
      </div>
      {view === 'attention' && attention.length === 0 && <p class="empty">要対応はありません。</p>}
      {view === 'attention' && attention.length > 0 && (
        <ul class="list">
          {attention.map((d) => (
            <li class="item item-warn" key={d.document_id}>
              <div class="item-head">
                <span class="item-name">受領 {d.received_on}</span>
                <span class="badge badge-rejected">要対応</span>
              </div>
              <p class="sub">{reasonText(d.reason)}</p>
              <div class="row-btns row-btns-even">
                {d.actions.map((a) => (
                  <button type="button" key={a} class={a === 'retry' ? 'btn btn-primary' : 'btn'} disabled={busy} onClick={() => void resolve(d.document_id, a)}>
                    {ACTION_LABELS[a]}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {view === 'review' && items && items.length === 0 && <p class="empty">確認待ちはありません。</p>}
      {view === 'review' && items && items.length > 0 && (
        <ul class="list">
          {items.map((d) => (
            <li key={d.id}>
              <button type="button" class="item item-btn" onClick={() => void open(d.id)}>
                <div class="item-head">
                  <span class="item-name">受領 {d.received_on}</span>
                  <span class={isUrgent(d.days_left) ? 'badge badge-rejected' : 'badge'}>{daysLeftText(d.days_left)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
