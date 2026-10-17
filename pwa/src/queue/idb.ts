// 送信待ちキューの IndexedDB 実装（画面と service worker の両方から使う）。
import type { QueueItem, QueueStore } from './queue.ts';

const DB_NAME = 'keihi';
const DB_VERSION = 1;
const STORE = 'queue';

function open(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB_NAME, DB_VERSION);
  r.onupgradeneeded = () => {
    if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' });
  };
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    const t = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    const r = fn(t.objectStore(STORE));
    await done;
    return r.result;
  } finally {
    db.close();
  }
}

export const idbStore: QueueStore = {
  list: () => withStore('readonly', (s) => s.getAll() as IDBRequest<QueueItem[]>),
  put: async (item) => {
    await withStore('readwrite', (s) => s.put(item));
  },
  remove: async (id) => {
    await withStore('readwrite', (s) => s.delete(id));
  },
};
