// 撮影・選択画面（docs/mvp-plan-v0.1.md T1-12）。送信は必ず送信待ちキューを通す（オフラインでも失わない）。
import { useState } from 'preact/hooks';
import type { QueueItem } from '../queue/queue.ts';
import { FieldsEditor } from './FieldsEditor.tsx';
import { canSend, emptyFields, isHeic, type Fields } from './form.ts';

type Props = { today: string; onQueue: (item: QueueItem) => Promise<void> };

const HEIC_MSG = 'HEIC は未対応のため送れません。カメラの設定で JPEG（互換性優先）にして撮り直してください。';

function sizeText(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`;
}

export function Capture({ today, onQueue }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [fields, setFields] = useState<Fields>(() => emptyFields(today, 'pwa'));
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    input.value = '';
    if (f === null) return;
    if (isHeic(f.name, f.type)) {
      setFile(null);
      setMsg(HEIC_MSG);
      return;
    }
    setMsg('');
    setFile(f);
  };

  const submit = async () => {
    if (file === null || !canSend(fields, today)) return;
    setBusy(true);
    try {
      await onQueue({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        name: file.name || 'capture.jpg',
        type: file.type,
        blob: file,
        fields,
        state: 'pending',
        attempts: 0,
        lastError: null,
      });
      setFile(null);
      setFields(emptyFields(today, 'pwa'));
      setMsg('送信待ちに追加しました。');
    } catch {
      setMsg('端末に保存できませんでした。もう一度試してください。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="screen">
      <div class="pickers">
        <label class="btn btn-big">
          撮影する
          <input class="hidden" type="file" accept="image/*" capture="environment" onChange={pick} />
        </label>
        <label class="btn">
          ファイルから選ぶ
          <input class="hidden" type="file" accept="image/*,application/pdf" onChange={pick} />
        </label>
      </div>
      {file && (
        <p class="file">
          {file.name || '（名前なし）'}・{sizeText(file.size)}
        </p>
      )}
      {msg && (
        <p class="msg" role="status">
          {msg}
        </p>
      )}
      <FieldsEditor fields={fields} today={today} onChange={setFields} />
      <div class="bottom">
        <button type="button" class="btn btn-primary" disabled={busy || file === null || !canSend(fields, today)} onClick={submit}>
          送信
        </button>
      </div>
    </section>
  );
}
