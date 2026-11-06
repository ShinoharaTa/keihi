// 共有シート（Android の Web Share Target。docs/mvp-plan-v0.1.md T1-13）で受けたファイルを送信待ちキューに積む。
// service worker から呼ぶ。種類（R1）は推測せず draft として積み、画面で選ばせてから送る。HEIC は積まない。
import { emptyFields, isHeic, todayLocal } from '../capture/form.ts';
import type { QueueItem, QueueStore } from './queue.ts';

export const SHARE_PATH = '/share-target';
export const SHARE_FILES_FIELD = 'files';

export async function acceptShare(
  fd: FormData,
  store: QueueStore,
  opts: { now: Date; newId: () => string },
): Promise<{ queued: number; unsupported: number }> {
  let queued = 0;
  let unsupported = 0;
  const today = todayLocal(opts.now);
  for (const [i, v] of fd.getAll(SHARE_FILES_FIELD).entries()) {
    if (typeof v === 'string' || v.size === 0) continue;
    if (isHeic(v.name, v.type)) {
      unsupported++;
      continue;
    }
    const item: QueueItem = {
      id: opts.newId(),
      // 同じ時刻でも共有された順に並ぶようにする。
      createdAt: new Date(opts.now.getTime() + i).toISOString(),
      name: v.name || 'shared',
      type: v.type,
      blob: v,
      fields: emptyFields(today, 'share'),
      state: 'draft',
      attempts: 0,
      lastError: null,
    };
    await store.put(item);
    queued++;
  }
  return { queued, unsupported };
}

// 共有の後に開く画面の URL。
export function shareRedirect(r: { queued: number; unsupported: number } | null): string {
  if (r === null) return '/?share=error';
  return `/?share=${r.queued}&unsupported=${r.unsupported}`;
}
