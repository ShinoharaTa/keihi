// PWA のエントリ（docs/mvp-plan-v0.1.md T1-12・T1-13）。画面は 撮影 / 送信待ち / 送信済み の 3 つ（下のタブで切り替え）。
// 送信待ちは開いたとき・オンラインに戻ったとき・画面に戻ったとき・追加したときに再送する（iOS は Background Sync が無いため）。
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { sendIngest } from './api.ts';
import { Capture } from './capture/Capture.tsx';
import { todayLocal } from './capture/form.ts';
import { SentList } from './list/SentList.tsx';
import { idbStore } from './queue/idb.ts';
import { QueueList } from './queue/QueueList.tsx';
import { createFlusher, type FlushReport, type QueueItem } from './queue/queue.ts';
import './style.css';

type Tab = 'capture' | 'queue' | 'sent';

// 共有シートから戻ったときの知らせ（?share=...）。読んだら URL から消す。
function shareNotice(): { text: string; toQueue: boolean } | null {
  const q = new URLSearchParams(location.search);
  const share = q.get('share');
  if (share === null) return null;
  history.replaceState(null, '', '/');
  if (share === 'no_sw') return { text: '共有を受け取れませんでした。アプリを一度開いてから、もう一度共有してください。', toQueue: false };
  if (share === 'error') return { text: '共有されたファイルを保存できませんでした。', toQueue: false };
  const n = Number(share);
  const heic = Number(q.get('unsupported') ?? '0');
  const parts: string[] = [];
  if (n > 0) parts.push(`共有から ${n} 件を送信待ちに追加しました。種類を選んで送信してください。`);
  if (heic > 0) parts.push(`HEIC の ${heic} 件は未対応のため追加していません。`);
  if (parts.length === 0) parts.push('共有されたファイルがありませんでした。');
  return { text: parts.join(''), toQueue: n > 0 };
}

function reportText(r: FlushReport): string {
  const parts: string[] = [];
  const done = r.sent.filter((s) => s.outcome === 'done').length;
  const dup = r.sent.length - done;
  if (done) parts.push(`${done} 件を送信しました。`);
  if (dup) parts.push(`${dup} 件は送信済みでした（重複）。`);
  if (r.rejected) parts.push(`${r.rejected} 件が受け付けられませんでした（送信待ちを確認）。`);
  if (r.retryLater) parts.push(`${r.retryLater} 件は後で再送します。`);
  return parts.join('');
}

function App() {
  const notice = useMemo(shareNotice, []);
  const [tab, setTab] = useState<Tab>(notice?.toQueue ? 'queue' : 'capture');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [msg, setMsg] = useState(notice?.text ?? '');
  const [sentKey, setSentKey] = useState(0);
  const today = todayLocal(new Date());
  const flusher = useMemo(() => createFlusher(idbStore, sendIngest), []);

  const reload = useCallback(async () => {
    const all = await idbStore.list();
    setItems(all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }, []);

  const flush = useCallback(async () => {
    try {
      const r = await flusher();
      const t = reportText(r);
      if (t) setMsg(t);
      if (r.sent.length) setSentKey((k) => k + 1);
    } catch {
      setMsg('送信待ちを読めませんでした。');
    }
    await reload();
  }, [flusher, reload]);

  useEffect(() => {
    void flush();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void flush();
    };
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [flush]);

  const save = async (item: QueueItem) => {
    await idbStore.put(item);
    await reload();
    void flush();
  };
  const remove = async (id: string) => {
    await idbStore.remove(id);
    await reload();
  };

  const waiting = items.length;
  return (
    <div class="app">
      <header class="top">keihi</header>
      {msg && (
        <p class="notice" role="status" onClick={() => setMsg('')}>
          {msg}
        </p>
      )}
      <main>
        {tab === 'capture' && <Capture today={today} onQueue={save} />}
        {tab === 'queue' && <QueueList items={items} today={today} onSave={save} onRemove={remove} onRetry={() => void flush()} />}
        {tab === 'sent' && <SentList reloadKey={sentKey} />}
      </main>
      <nav class="tabs">
        <button type="button" class={tab === 'capture' ? 'tab-on' : ''} onClick={() => setTab('capture')}>
          撮影
        </button>
        <button type="button" class={tab === 'queue' ? 'tab-on' : ''} onClick={() => setTab('queue')}>
          送信待ち{waiting ? `（${waiting}）` : ''}
        </button>
        <button type="button" class={tab === 'sent' ? 'tab-on' : ''} onClick={() => setTab('sent')}>
          送信済み
        </button>
      </nav>
    </div>
  );
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

const root = document.getElementById('app');
if (root) render(<App />, root);
