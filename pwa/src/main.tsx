// PWA のエントリ（docs/mvp-plan-v0.1.md T1-12・T1-13、mvp-plan.md T2-10・T2-11）。画面は 撮影 / 確認 / 送信待ち / 送信済み の 4 つ（下のタブで切り替え）。
// 確認のタブには確認待ちの件数（GET /api/documents/counts）を出す。5 つ目の「お金」（T111・T304）には期日の近い予定の件数（counts.upcoming、T305）を出す。バックアップが止まっていたら・freee の再認可が要るなら上に警告帯（GET /api/status）。
// 送信待ちは開いたとき・オンラインに戻ったとき・画面に戻ったとき・追加したときに再送する（iOS は Background Sync が無いため）。
import { h, render } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { getJson, sendIngest } from './api.ts';
import { Capture } from './capture/Capture.tsx';
import { todayLocal } from './capture/form.ts';
import { SentList } from './list/SentList.tsx';
import { idbStore } from './queue/idb.ts';
import { QueueList } from './queue/QueueList.tsx';
import { ReviewList } from './review/ReviewList.tsx';
import { createFlusher, type FlushReport, type QueueItem } from './queue/queue.ts';
import { backupWarning, reauthWarning, STATUS_URL, type StatusResponse } from './status.ts';
import './style.css';

type MoneyComponent = (typeof import('./money/Money.tsx'))['Money'];
type Tab = 'capture' | 'review' | 'queue' | 'sent' | 'money';
// upcoming は T305 で足す。無いサーバーでは 0 として扱う。
type Counts = { review: number; attention: number; urgent: number; upcoming?: number };

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

// タブの件数。アイコンの右上に数字のピル（0 なら出さない）。
function Pill({ n }: { n: number }) {
  return n > 0 ? <span class="tab-pill">{n > 99 ? '99+' : n}</span> : null;
}

// 下タブのアイコン（線のインライン SVG。色は currentColor）。お金タブの Icons.tsx は別チャンクなのでここに持つ。
const TAB_ICONS = {
  capture: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 9.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'],
  review: ['M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M9 12l2 2 4-4'],
  queue: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 8v4l3 2'],
  sent: ['M4 12l16-8-6 16-2-7z'],
  money: ['M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M3 10h18', 'M16 14.5h2'],
} as const;

function TabButton({ on, icon, label, n = 0, onClick }: { on: boolean; icon: keyof typeof TAB_ICONS; label: string; n?: number; onClick: () => void }) {
  return (
    <button type="button" class={on ? 'tab-on' : ''} aria-current={on ? 'page' : undefined} onClick={onClick}>
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={on ? 2 : 1.8} stroke-linecap="round" stroke-linejoin="round">
        {TAB_ICONS[icon].map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      <span>{label}</span>
      <Pill n={n} />
    </button>
  );
}

function App() {
  const notice = useMemo(shareNotice, []);
  const [tab, setTab] = useState<Tab>(notice?.toQueue ? 'queue' : 'capture');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [msg, setMsg] = useState(notice?.text ?? '');
  const [sentKey, setSentKey] = useState(0);
  const [counts, setCounts] = useState<Counts | null>(null);
  // お金タブは別チャンク（撮影タブの初回を軽くする）。初めて開いたときに読む。
  const [money, setMoney] = useState<MoneyComponent | 'error' | null>(null);
  const [backupWarn, setBackupWarn] = useState<string | null>(null);
  const [reauthWarn, setReauthWarn] = useState<string | null>(null);
  const today = todayLocal(new Date());
  const flusher = useMemo(() => createFlusher(idbStore, sendIngest), []);

  useEffect(() => {
    if (tab !== 'money' || (money !== null && money !== 'error')) return;
    import('./money/Money.tsx').then(
      (m) => setMoney(() => m.Money),
      () => setMoney('error'),
    );
  }, [tab]);

  const reloadCounts = useCallback(async () => {
    const [r, st] = await Promise.all([getJson<Counts>('/api/documents/counts'), getJson<StatusResponse>(STATUS_URL)]);
    if (r.ok) setCounts(r.data);
    if (st.ok) {
      setBackupWarn(backupWarning(st.data.backup, new Date()));
      setReauthWarn(reauthWarning(st.data));
    }
  }, []);

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
      void reloadCounts();
    } catch {
      setMsg('送信待ちを読めませんでした。');
    }
    await reload();
  }, [flusher, reload, reloadCounts]);

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
  const upcoming = counts?.upcoming ?? 0;
  return (
    <div class="app">
      {/* お金タブは画面ごとに自分のヘッダ（戻る・題）を持つ */}
      {tab !== 'money' && <header class="top">keihi</header>}
      {reauthWarn && (
        <p class="band-warn" role="alert">
          {reauthWarn}
        </p>
      )}
      {backupWarn && (
        <p class="band-warn" role="alert">
          {backupWarn}
        </p>
      )}
      {msg && (
        <p class="notice" role="status" onClick={() => setMsg('')}>
          {msg}
        </p>
      )}
      <main>
        {tab === 'capture' && <Capture today={today} onQueue={save} />}
        {tab === 'review' && <ReviewList onChanged={() => void reloadCounts()} />}
        {tab === 'queue' && <QueueList items={items} today={today} onSave={save} onRemove={remove} onRetry={() => void flush()} />}
        {tab === 'sent' && <SentList reloadKey={sentKey} />}
        {tab === 'money' && (typeof money === 'function' ? h(money, { today, onCapture: () => setTab('capture') }) : <p class="empty">{money === 'error' ? 'お金の画面を読めませんでした。電波の良い所で開き直してください。' : '読み込み中…'}</p>)}
      </main>
      <nav class="tabs" aria-label="メイン">
        <TabButton on={tab === 'capture'} icon="capture" label="撮影" onClick={() => setTab('capture')} />
        <TabButton on={tab === 'review'} icon="review" label="確認" n={counts ? counts.review + counts.attention : 0} onClick={() => setTab('review')} />
        <TabButton on={tab === 'queue'} icon="queue" label="送信待ち" n={waiting} onClick={() => setTab('queue')} />
        <TabButton on={tab === 'sent'} icon="sent" label="送信済み" onClick={() => setTab('sent')} />
        <TabButton on={tab === 'money'} icon="money" label="お金" n={upcoming} onClick={() => setTab('money')} />
      </nav>
    </div>
  );
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

const root = document.getElementById('app');
if (root) render(<App />, root);
