// 送信済み一覧（GET /api/documents）とサーバーの状態（GET /api/status）。文字列はすべてテキストとして描画する。
import { useEffect, useState } from 'preact/hooks';
import { getJson } from '../api.ts';
import { KINDS } from '../capture/form.ts';

type Doc = { id: string; received_on: string; kind: string; status: string; deadline_on: string; paper_required: boolean; created_at: string };
type Status = { user: string | null; documents: { total: number }; jobs: { queued: number; running: number; failed: number } };

const kindText = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;

export function SentList({ reloadKey }: { reloadKey: number }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [d, s] = await Promise.all([getJson<{ items: Doc[] }>('/api/documents'), getJson<Status>('/api/status')]);
      if (!alive) return;
      setDocs(d.ok ? d.data.items : null);
      setStatus(s.ok ? s.data : null);
      const failed = !d.ok ? d : !s.ok ? s : null;
      setErr(failed ? `サーバーから読めませんでした（${failed.status === 0 ? '通信できない' : `HTTP ${failed.status}`}）` : '');
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  return (
    <section class="screen">
      {err && <p class="msg">{err}</p>}
      {status && (
        <dl class="status">
          <dt>ユーザー</dt>
          <dd>{status.user ?? '-'}</dd>
          <dt>取り込み済み</dt>
          <dd>{status.documents.total} 件</dd>
          <dt>処理待ち / 処理中 / 失敗</dt>
          <dd>
            {status.jobs.queued} / {status.jobs.running} / {status.jobs.failed}
          </dd>
        </dl>
      )}
      {docs && docs.length === 0 && <p class="empty">まだありません。</p>}
      {docs && docs.length > 0 && (
        <ul class="list">
          {docs.map((d) => (
            <li class="item" key={d.id}>
              <div class="item-head">
                <span class="item-name">受領 {d.received_on}</span>
                <span class="badge">{d.status}</span>
              </div>
              <p class="sub">
                {kindText(d.kind)}・期限 {d.deadline_on}
                {d.paper_required ? '・紙の原本を保管' : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
