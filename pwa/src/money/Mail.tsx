// メールの要対応の一覧（docs/cashflow.md §17、GET /api/mail/messages?state=attention）。ホームの「メールの要対応 n 件」から開く。
// 上に「今すぐ取り込む」（POST /api/mail/sync。アカウントごとに積む。10 分以内に積んでいれば積まない）。
// 行は 受信日・送信元のドメイン・件名・状態・添付の結果。新しい順で最大 100 件（それより多ければ下にその旨）。
import { useEffect, useState } from 'preact/hooks';
import { getJson, postJson } from '../api.ts';
import { dateShort, failText, MAIL_ATTENTION_URL, mailAttachmentText, mailStateText, mailSyncText, type MailMessage, type MailPage } from './model.ts';
import { ScreenHead } from './Money.tsx';

function MailRow({ m, today }: { m: MailMessage; today: string }) {
  return (
    <li>
      <div class="m-nav-row">
        <span class="m-nav-text">
          <span class="m-txn-top">
            <span class="m-txn-name">{m.subject || '件名なし'}</span>
          </span>
          <span class="m-txn-meta">
            <span>{m.received_on ? dateShort(m.received_on, today) : '日付なし'}</span>
            <span>{m.from_domain || '送信元なし'}</span>
            <span class="m-rc m-rc-waiting">{mailStateText(m)}</span>
          </span>
          {m.attachments.map((a, i) => (
            <span key={i} class="m-nav-sub">
              {mailAttachmentText(a)}
            </span>
          ))}
        </span>
      </div>
    </li>
  );
}

export function MailView({ page, today, busy, onSync }: { page: MailPage; today: string; busy: boolean; onSync: () => void }) {
  return (
    <>
      <div class="m-pills">
        <button type="button" class="m-btn" disabled={busy} onClick={onSync}>
          今すぐ取り込む
        </button>
      </div>
      <section class="m-card m-pad12 m-gap6" aria-labelledby="m-mail">
        <div class="m-row">
          <h2 id="m-mail" class="m-h2">
            要対応のメール
          </h2>
          <span class="m-sub">{page.items.length}{page.next_cursor ? '+' : ''} 件</span>
        </div>
        {page.items.length === 0 ? (
          <p class="m-empty">要対応のメールはありません。</p>
        ) : (
          <ul class="m-ledger">
            {page.items.map((m) => (
              <MailRow key={m.id} m={m} today={today} />
            ))}
          </ul>
        )}
        {page.next_cursor && <p class="m-note">新しい順に {page.items.length} 件だけ出しています。</p>}
      </section>
    </>
  );
}

export function Mail({ today, onBack }: { today: string; onBack: () => void }) {
  const [page, setPage] = useState<MailPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await getJson<MailPage>(MAIL_ATTENTION_URL);
      if (!live) return;
      if (r.ok) setPage(r.data);
      else setMsg(failText(r.status, r.body));
    })();
    return () => {
      live = false;
    };
  }, []);

  const sync = async () => {
    setBusy(true);
    const r = await postJson('/api/mail/sync', {});
    setBusy(false);
    setMsg(mailSyncText(r.status, r.body));
  };

  return (
    <>
      <ScreenHead title="メール" onBack={onBack} />
      <div class="m-main">
        {msg && (
          <p class="m-msg" role="status">
            {msg}
          </p>
        )}
        {page ? <MailView page={page} today={today} busy={busy} onSync={() => void sync()} /> : !msg && <p class="m-empty">読み込み中…</p>}
      </div>
    </>
  );
}
