// upload_receipt ジョブ（docs/mvp-plan.md T1-11、legal.md R7）。取り込み直後に、確認を待たずに freee へ証憑を入れる。
// - 原本ストアのバイト列を加工せずそのまま送る（R4。送る前に sha256 を確かめる）。メタデータは空、description に照合キー
//   kh-<document_id>。検索項目（R11）は確定の後に updateReceiptMeta で入れる（T2-12）。
// - 冪等キーが無いので、2 回目以降の試行では送る前に findReceiptsByKey（GET /receipts?category=without_deal、
//   アップロード日が受領日の前日〜明日）で照合キーを探し、あればそれを採用する（タイムアウト後に実は成功していたケース）。
// - 成功したら provider_uploads を state=uploaded・remote_receipt_id にし、監査ログに残す（同じトランザクション）。
// - 再試行で直る失敗は例外を投げて再試行に回す（jobs のバックオフ）。期限（deadline_on）の 2 営業日前を過ぎた、
//   または最後の試行なら documents.status を needs_attention にする。
// - 自動では直らない失敗（4xx・大きすぎる）は needs_attention（upload_rejected）にしてジョブを終える（再スローしない。予算を使わない）。
// - 再認可待ち（auth_invalid_grant、または settings.freee_reauth_required = 1）は documents.status を変えず、
//   回数を数えずに 6 時間後へ延期する（jobs.last_error = "reauth_pending since=<ISO>: ..."）。待ちが [worker] reauth_wait_days
//   （既定 7 日）を超えたら needs_attention（upload_reauth_expired）にしてジョブを終える。再認可の後は daily が
//   wakeReauthPending で即時に起こす。
// - Provider は呼び出し側が渡す（予算を通したもの）。worker/main.ts が設定から組み立てて渡す。
import { describeError, markNeedsAttention } from '../../attention.ts';
import { appendAudit } from '../../audit.ts';
import { addDays, subtractBusinessDays, todayInTokyo, type CalendarOptions } from '../../calendar/businessDays.ts';
import { tx, type Db } from '../../db/index.ts';
import { ulid } from '../../db/ids.ts';
import { DeferJob, type Handler } from '../../jobs/worker.ts';
import { isReauthRequired } from '../../providers/freee/state.ts';
import { ProviderError, type Provider, type Receipt } from '../../providers/types.ts';
import { readObject, sha256Hex } from '../../storage/objects.ts';

export const PROVIDER = 'freee';
export const WARN_BUSINESS_DAYS = 2;
// 検索項目を入れる期限（保存から 70 日。R11、mvp-plan.md T1-3）。
export const META_DEADLINE_DAYS = 70;
export const REAUTH_PENDING = 'reauth_pending';
export const REAUTH_RETRY_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_REAUTH_WAIT_DAYS = 7;

export type DateRange = { startDate: string; endDate: string };

// fake も freee の Provider もこの形を満たす（findReceiptsByKey の期間は freee だけが使う）。
export type UploadProvider = Pick<Provider, 'capabilities' | 'uploadReceipt'> & {
  findReceiptsByKey(key: string, range?: DateRange): Promise<Receipt[]>;
};

export type UploadReceiptDeps = {
  provider: UploadProvider;
  objectsDir: string;
  calendar?: Pick<CalendarOptions, 'yearEndHolidays'>;
  // 再認可待ちの上限の日数（[worker] reauth_wait_days）。
  reauthWaitDays?: number;
};

type DocRow = {
  id: string;
  sha256: string;
  bytes: number;
  mime: string;
  orig_name: string | null;
  received_on: string;
  deadline_on: string;
  status: string;
};

type UploadRow = { id: string; state: string; attempts: number; remote_receipt_id: string | null };

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

export function matchKey(documentId: string): string {
  return `kh-${documentId}`;
}

function ensureUploadRow(db: Db, documentId: string, now: Date): UploadRow {
  db.prepare(`INSERT INTO provider_uploads (id, document_id, provider, state, created_at) VALUES (?, ?, ?, 'queued', ?) ON CONFLICT (document_id, provider) DO NOTHING`).run(
    ulid(now.getTime()),
    documentId,
    PROVIDER,
    now.toISOString(),
  );
  return db.prepare('SELECT id, state, attempts, remote_receipt_id FROM provider_uploads WHERE document_id = ? AND provider = ?').get(documentId, PROVIDER) as UploadRow;
}

// 再認可待ちの開始時刻（前の延期の note から読む）。
function reauthSince(lastError: string | null): Date | null {
  const m = new RegExp(`^${REAUTH_PENDING} since=(\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z)`).exec(lastError ?? '');
  if (!m) return null;
  const t = new Date(m[1]);
  return Number.isNaN(t.getTime()) ? null : t;
}

// 再認可の後（settings.freee_reauth_required が 1 でない）に、再認可待ちで延期中の upload_receipt を今すぐ動くようにする。起こした件数。
export function wakeReauthPending(db: Db, now: Date): number {
  if (isReauthRequired(db)) return 0;
  const iso = now.toISOString();
  return Number(
    db
      .prepare(`UPDATE jobs SET run_after = ?, updated_at = ? WHERE kind = 'upload_receipt' AND state = 'queued' AND run_after > ? AND last_error LIKE ?`)
      .run(iso, iso, iso, `${REAUTH_PENDING} %`).changes,
  );
}

export function createUploadReceiptHandler(getDeps: () => UploadReceiptDeps): Handler {
  return async (job, ctx) => {
    const { db } = ctx;
    const now = ctx.now();
    const deps = getDeps();
    if (!job.ref_id) throw new Error('upload_receipt に document_id が無い');
    const doc = db.prepare('SELECT id, sha256, bytes, mime, orig_name, received_on, deadline_on, status FROM documents WHERE id = ?').get(job.ref_id) as DocRow | undefined;
    if (!doc) throw new Error(`document ${job.ref_id} が無い`);
    const up = tx(db, () => ensureUploadRow(db, doc.id, now));
    if (up.state === 'uploaded') return; // 済み（ジョブの重複）

    const today = todayInTokyo(now);
    const key = matchKey(doc.id);
    const isLastAttempt = job.attempts + 1 >= job.max_attempts;
    try {
      // freee の Provider も同じ判定で呼ばずに返すが、原本を読む前に止める。
      if (isReauthRequired(db)) throw new ProviderError('auth_invalid_grant', 'freee の再認可が要る（keihi freee auth）。呼び出さない');
      if (doc.bytes > deps.provider.capabilities().maxReceiptBytes) {
        throw new ProviderError('client', `freee の上限（${deps.provider.capabilities().maxReceiptBytes}B）を超える: ${doc.bytes}B`);
      }
      const bytes = await readObject(deps.objectsDir, doc.sha256);
      if (sha256Hex(bytes) !== doc.sha256) throw new Error(`原本の sha256 が記録と一致しない（${doc.id}）。送らない`);

      // 2 回目以降は、前の試行が実は届いていないかを先に確かめる。
      let remote: Receipt | null = null;
      let adopted = false;
      if (up.attempts > 0) {
        const hits = await deps.provider.findReceiptsByKey(key, { startDate: addDays(doc.received_on, -1), endDate: addDays(today, 1) });
        if (hits.length) {
          remote = hits.reduce((a, b) => (b.id < a.id ? b : a));
          adopted = true;
          if (hits.length > 1) {
            appendAudit(db, { actor: 'worker', action: 'receipt.duplicate_found', entity: 'document', entityId: doc.id, payload: { provider: PROVIDER, key, remote_receipt_ids: hits.map((h) => h.id) } }, now);
          }
        }
      }
      if (!remote) {
        // 送る前に試行を数えておく（応答の前に落ちても、次は照合から始める）。
        db.prepare('UPDATE provider_uploads SET attempts = attempts + 1 WHERE id = ?').run(up.id);
        remote = await deps.provider.uploadReceipt({
          bytes,
          fileName: doc.orig_name || `${doc.id}.${EXT[doc.mime] ?? 'bin'}`,
          mime: doc.mime,
          key,
        });
      }
      const at = now.toISOString();
      tx(db, () => {
        db.prepare(
          `UPDATE provider_uploads SET state = 'uploaded', remote_receipt_id = ?, uploaded_at = ?, meta_deadline_on = ?, last_error = NULL, next_retry_at = NULL WHERE id = ?`,
        ).run(String(remote.id), at, addDays(today, META_DEADLINE_DAYS), up.id);
        appendAudit(
          db,
          {
            actor: 'worker',
            action: adopted ? 'receipt.upload_adopted' : 'receipt.uploaded',
            entity: 'document',
            entityId: doc.id,
            payload: { provider: PROVIDER, remote_receipt_id: remote.id, key, sha256: doc.sha256, bytes: doc.bytes, mime: doc.mime },
          },
          now,
        );
      });
    } catch (e) {
      const msg = describeError(e).slice(0, 1000);
      db.prepare(`UPDATE provider_uploads SET last_error = ? WHERE id = ?`).run(msg, up.id);
      const warnOn = subtractBusinessDays(doc.deadline_on, WARN_BUSINESS_DAYS, deps.calendar);
      const detail = { deadline_on: doc.deadline_on, warn_on: warnOn, error: msg };
      if (e instanceof ProviderError && e.kind === 'auth_invalid_grant') {
        const since = reauthSince(job.last_error) ?? now;
        const waitDays = deps.reauthWaitDays ?? DEFAULT_REAUTH_WAIT_DAYS;
        if (now.getTime() - since.getTime() >= waitDays * 86_400_000) {
          markNeedsAttention(db, doc.id, 'upload_reauth_expired', { ...detail, reauth_pending_since: since.toISOString() }, { now });
          return;
        }
        throw new DeferJob(new Date(now.getTime() + REAUTH_RETRY_MS), `${REAUTH_PENDING} since=${since.toISOString()}: ${msg}`);
      }
      if (e instanceof ProviderError && !e.retryable) {
        markNeedsAttention(db, doc.id, 'upload_rejected', detail, { now });
        return;
      }
      const reason = today >= warnOn ? 'upload_deadline_near' : isLastAttempt ? 'upload_retries_exhausted' : null;
      if (reason) markNeedsAttention(db, doc.id, reason, detail, { now });
      throw e;
    }
  };
}
