// 送信待ちキュー（docs/mvp-plan-v0.1.md T1-12・T1-13）。保存先（IndexedDB）は QueueStore に抽象化し、
// ここは純粋なロジックだけにする（node:test で単体テストする）。
// - 状態: draft（種類などが未入力。共有シートから来たもの）/ pending（送信待ち）/ rejected（サーバーが受け付けなかった）。
// - 送信は POST /api/documents（src/web/routes/ingest.ts の multipart）。201 と 409（重複 = 既に届いている）でキューから消す。
// - 通信できない・5xx・401/403（Tailscale の切断など）・408・429 は残して次の機会に再送する。
// - それ以外の 4xx は rejected にして残す（領収書を黙って捨てない）。消すのは利用者だけ。
import { canSend, type Fields } from '../capture/form.ts';

export type QueueState = 'draft' | 'pending' | 'rejected';

export type QueueItem = {
  id: string;
  createdAt: string; // ISO8601
  name: string;
  type: string;
  blob: Blob;
  fields: Fields;
  state: QueueState;
  attempts: number;
  lastError: string | null;
};

export interface QueueStore {
  list(): Promise<QueueItem[]>;
  put(item: QueueItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export const INGEST_URL = '/api/documents';

// 送信関数。通信自体に失敗したら throw する（fetch と同じ）。
export type Send = (body: FormData) => Promise<{ status: number; body: unknown }>;

export type Outcome = 'done' | 'duplicate' | 'retry' | 'rejected';

export function classify(status: number): Outcome {
  if (status === 200 || status === 201) return 'done';
  if (status === 409) return 'duplicate';
  if (status === 401 || status === 403 || status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'rejected';
  return 'retry';
}

export function toFormData(item: QueueItem): FormData {
  const f = item.fields;
  const fd = new FormData();
  fd.append('file', item.blob, item.name);
  if (f.kind !== null) fd.append('kind', f.kind);
  if (f.kind === 'scan' && f.sizePreset !== null) fd.append('size_preset', f.sizePreset);
  fd.append('received_on', f.receivedOn);
  fd.append('no_ai', f.noAi ? 'true' : 'false');
  fd.append('force', f.force ? 'true' : 'false');
  fd.append('source', f.source);
  return fd;
}

function reasonOf(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null && typeof (body as { reason?: unknown }).reason === 'string') {
    return (body as { reason: string }).reason;
  }
  return `http_${status}`;
}

export type SentInfo = { itemId: string; name: string; outcome: 'done' | 'duplicate'; body: unknown };
export type FlushReport = { sent: SentInfo[]; rejected: number; retryLater: number };

// pending を古い順に送る。通信できない・再送対象の応答を受けたら、そこで止める（残りも同じ結果になるため）。
export async function flush(store: QueueStore, send: Send): Promise<FlushReport> {
  const report: FlushReport = { sent: [], rejected: 0, retryLater: 0 };
  const items = (await store.list()).filter((i) => i.state === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let res: { status: number; body: unknown };
    try {
      res = await send(toFormData(item));
    } catch {
      await store.put({ ...item, attempts: item.attempts + 1, lastError: 'network' });
      report.retryLater = items.length - i;
      return report;
    }
    const outcome = classify(res.status);
    if (outcome === 'done' || outcome === 'duplicate') {
      await store.remove(item.id);
      report.sent.push({ itemId: item.id, name: item.name, outcome, body: res.body });
    } else if (outcome === 'rejected') {
      await store.put({ ...item, state: 'rejected', attempts: item.attempts + 1, lastError: reasonOf(res.status, res.body) });
      report.rejected++;
    } else {
      await store.put({ ...item, attempts: item.attempts + 1, lastError: reasonOf(res.status, res.body) });
      report.retryLater = items.length - i;
      return report;
    }
  }
  return report;
}

// draft / rejected を入力し直して pending に戻す。入力が足りなければ null（呼び出し側は送信ボタンを disabled にしている）。
export function markPending(item: QueueItem, fields: Fields, today: string): QueueItem | null {
  if (!canSend(fields, today)) return null;
  return { ...item, fields, state: 'pending', lastError: null };
}

// 同じ画面・タブから flush が重ならないようにする。重なった呼び出しは実行中のものを待つ。
export function createFlusher(store: QueueStore, send: Send): () => Promise<FlushReport> {
  let running: Promise<FlushReport> | null = null;
  return () => {
    if (running) return running;
    running = flush(store, send).finally(() => {
      running = null;
    });
    return running;
  };
}
