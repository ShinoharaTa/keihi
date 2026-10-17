// 証憑の照合（docs/mvp-plan.md T5-6）。月 1 回、keihi が freee に上げた証憑を downloadReceipt で取り、手元の原本と比べる。
// - 対象: provider_uploads が uploaded で remote_receipt_id のあるもの。前回の照合（audit の receipt.remote_verified）が
//   古い順（未照合が先）に、1 回 limit 件（既定 200）まで。
// - 1 秒 3 回以内: 呼び出しの開始を minIntervalMs（既定 334ms）以上あける（freee の client にも同じ制限があるが、ここでも守る）。
// - 予算: 呼び出し側が downloadReceipt を用途 sync で予算に通した Provider を渡す。BudgetExceededError を受けたらそこで止める。
// - mode（[backup] remote_verify_mode。F6 が未確認なので既定は download_only）:
//   sha256        手元の原本を読み直して sha256 を出し、documents.sha256 とダウンロードしたものの sha256 の両方と比べる。
//                 違えば documents.status を needs_attention にする（remote_sha256_mismatch / local_object_corrupt）。
//   download_only ダウンロードできて空でないことだけを確かめる。sha256 が一致したかは audit に記録するだけ（F6 の材料）。
// - 自動では直らない取得の失敗（4xx。消された・見つからない等）は needs_attention（remote_download_failed）。
//   再認可が要る・再試行で直る失敗（429・403 の使用制限・5xx・タイムアウト）は、そこで止めて次回に回す。
// - 月 1 回の実行は daily（worker/handlers/daily.ts）から呼ぶ。
import { appendAudit } from '../audit.ts';
import { tx, type Db } from '../db/index.ts';
import { BudgetExceededError } from '../providers/freee/budget.ts';
import { ProviderError, type Provider } from '../providers/types.ts';
import { readObject, sha256Hex } from '../storage/objects.ts';
import type { RemoteVerifyMode } from './settings.ts';

export const PROVIDER = 'freee';
export const DEFAULT_LIMIT = 200;
export const MIN_INTERVAL_MS = 334;

export type RemoteVerifyItem = {
  documentId: string;
  remoteReceiptId: number;
  result: 'match' | 'mismatch' | 'downloaded' | 'local_corrupt' | 'empty' | 'failed';
  remoteSha256: string | null;
};

export type RemoteVerifyResult = {
  mode: RemoteVerifyMode;
  checked: number;
  ok: number;
  attention: number;
  // 途中で止めた理由（budget / freee_reauth_required / rate_limited などの ProviderError の kind）。最後までなら null。
  stopped: string | null;
  items: RemoteVerifyItem[];
};

export type RemoteVerifyDeps = {
  db: Db;
  provider: Pick<Provider, 'downloadReceipt'>;
  objectsDir: string;
  mode: RemoteVerifyMode;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  limit?: number;
  minIntervalMs?: number;
};

type Target = { id: string; sha256: string; remote_receipt_id: string };

export function selectTargets(db: Db, limit: number): Target[] {
  return db
    .prepare(
      `WITH v AS (
         SELECT entity_id, MAX(ts) AS last FROM audit_log WHERE action = 'receipt.remote_verified' AND entity = 'document' GROUP BY entity_id
       )
       SELECT d.id, d.sha256, pu.remote_receipt_id
       FROM provider_uploads pu JOIN documents d ON d.id = pu.document_id LEFT JOIN v ON v.entity_id = d.id
       WHERE pu.provider = ? AND pu.state = 'uploaded' AND pu.remote_receipt_id IS NOT NULL
       ORDER BY v.last IS NOT NULL, v.last, pu.uploaded_at, d.id
       LIMIT ?`,
    )
    .all(PROVIDER, limit) as Target[];
}

function markNeedsAttention(db: Db, documentId: string, reason: string, detail: Record<string, unknown>, now: Date): void {
  tx(db, () => {
    const cur = db.prepare('SELECT status FROM documents WHERE id = ?').get(documentId) as { status: string };
    if (cur.status === 'needs_attention') return;
    db.prepare(`UPDATE documents SET status = 'needs_attention' WHERE id = ?`).run(documentId);
    appendAudit(db, { actor: 'backup', action: 'document.needs_attention', entity: 'document', entityId: documentId, payload: { reason, from: cur.status, ...detail } }, now);
  });
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function verifyRemoteReceipts(deps: RemoteVerifyDeps): Promise<RemoteVerifyResult> {
  const { db, provider, objectsDir, mode } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const minInterval = deps.minIntervalMs ?? MIN_INTERVAL_MS;
  if (mode !== 'sha256' && mode !== 'download_only') throw new Error(`remote_verify_mode が不正: ${String(mode)}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > DEFAULT_LIMIT) throw new Error(`limit は 1〜${DEFAULT_LIMIT}`);

  const res: RemoteVerifyResult = { mode, checked: 0, ok: 0, attention: 0, stopped: null, items: [] };
  let lastStart: number | null = null;

  for (const t of selectTargets(db, limit)) {
    const remoteId = Number(t.remote_receipt_id);
    if (lastStart !== null) {
      const wait = lastStart + minInterval - now().getTime();
      if (wait > 0) await sleep(wait);
    }
    lastStart = now().getTime();
    let bytes: Buffer;
    try {
      bytes = (await provider.downloadReceipt(remoteId)).bytes;
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        res.stopped = 'budget';
        break;
      }
      if (e instanceof ProviderError && (e.retryable || e.kind === 'auth_invalid_grant')) {
        res.stopped = e.kind === 'auth_invalid_grant' ? 'freee_reauth_required' : e.kind;
        break;
      }
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const at = now();
      res.checked++;
      res.attention++;
      res.items.push({ documentId: t.id, remoteReceiptId: remoteId, result: 'failed', remoteSha256: null });
      appendAudit(db, { actor: 'backup', action: 'receipt.remote_verify_failed', entity: 'document', entityId: t.id, payload: { provider: PROVIDER, remote_receipt_id: remoteId, mode, error: msg } }, at);
      markNeedsAttention(db, t.id, 'remote_download_failed', { remote_receipt_id: remoteId, error: msg }, at);
      continue;
    }

    const at = now();
    const remoteSha = sha256Hex(bytes);
    let result: RemoteVerifyItem['result'];
    let reason: string | null = null;
    if (mode === 'sha256') {
      let localSha: string | null = null;
      try {
        localSha = sha256Hex(await readObject(objectsDir, t.sha256));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (localSha !== t.sha256) {
        result = 'local_corrupt';
        reason = 'local_object_corrupt';
      } else if (remoteSha !== t.sha256) {
        result = 'mismatch';
        reason = 'remote_sha256_mismatch';
      } else result = 'match';
    } else if (bytes.length === 0) {
      result = 'empty';
      reason = 'remote_download_empty';
    } else result = 'downloaded';

    res.checked++;
    res.items.push({ documentId: t.id, remoteReceiptId: remoteId, result, remoteSha256: remoteSha });
    appendAudit(
      db,
      {
        actor: 'backup',
        action: 'receipt.remote_verified',
        entity: 'document',
        entityId: t.id,
        payload: { provider: PROVIDER, remote_receipt_id: remoteId, mode, result, sha256: t.sha256, remote_sha256: remoteSha, remote_bytes: bytes.length, sha256_match: remoteSha === t.sha256 },
      },
      at,
    );
    if (reason) {
      res.attention++;
      markNeedsAttention(db, t.id, reason, { remote_receipt_id: remoteId, sha256: t.sha256, remote_sha256: remoteSha }, at);
    } else res.ok++;
  }

  appendAudit(
    db,
    { actor: 'backup', action: 'backup.remote_verify', entity: 'backup', entityId: null, payload: { provider: PROVIDER, mode, checked: res.checked, ok: res.ok, attention: res.attention, stopped: res.stopped } },
    now(),
  );
  return res;
}
