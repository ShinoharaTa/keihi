// 送信待ちの一覧。draft（共有から来て種類が未入力）と rejected（サーバーが受け付けなかった）は入力し直して送る。
import { useState } from 'preact/hooks';
import { FieldsEditor } from '../capture/FieldsEditor.tsx';
import { canSend, reasonText, type Fields } from '../capture/form.ts';
import { markPending, type QueueItem } from './queue.ts';

type Props = {
  items: QueueItem[];
  today: string;
  onSave: (item: QueueItem) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRetry: () => void;
};

const STATE_TEXT = { draft: '入力待ち', pending: '送信待ち', rejected: '受け付けられなかった' } as const;

function Row({ item, today, onSave, onRemove }: { item: QueueItem } & Pick<Props, 'today' | 'onSave' | 'onRemove'>) {
  const [fields, setFields] = useState<Fields>(item.fields);
  const editable = item.state !== 'pending';
  const send = () => {
    const next = markPending(item, fields, today);
    if (next) void onSave(next);
  };
  const remove = () => {
    if (confirm('この領収書を送信待ちから消します。よろしいですか？')) void onRemove(item.id);
  };
  return (
    <li class="item">
      <div class="item-head">
        <span class={`badge badge-${item.state}`}>{STATE_TEXT[item.state]}</span>
        <span class="item-name">{item.name}</span>
      </div>
      {item.lastError && <p class="msg">{reasonText(item.lastError)}</p>}
      {editable && <FieldsEditor fields={fields} today={today} onChange={setFields} />}
      <div class="row-btns">
        {editable && (
          <button type="button" class="btn btn-primary" disabled={!canSend(fields, today)} onClick={send}>
            送信
          </button>
        )}
        <button type="button" class="btn btn-danger" onClick={remove}>
          消す
        </button>
      </div>
    </li>
  );
}

export function QueueList({ items, today, onSave, onRemove, onRetry }: Props) {
  if (items.length === 0) return <p class="empty">送信待ちはありません。</p>;
  const pending = items.filter((i) => i.state === 'pending').length;
  return (
    <section class="screen">
      {pending > 0 && (
        <button type="button" class="btn" onClick={onRetry}>
          今すぐ再送（{pending} 件）
        </button>
      )}
      <ul class="list">
        {items.map((i) => (
          <Row key={`${i.id}:${i.state}`} item={i} today={today} onSave={onSave} onRemove={onRemove} />
        ))}
      </ul>
    </section>
  );
}
