// needs_attention と settings の共通ヘルパ（worker のハンドラと backup の照合が使う）。
// - markNeedsAttention: documents.status を needs_attention にし、監査ログ（document.needs_attention、payload に reason / from）に残す。
//   既に needs_attention なら何もしない（最初の理由を残す）。
// - clearNeedsAttention: needs_attention のときだけ nextStatus に戻し、監査ログ（document.needs_attention_cleared）に残す。
// - getSetting / setSetting: settings 表（value_json は JSON）。JSON として読めない値は undefined（providers/freee/state.ts と同じ）。
import { appendAudit } from './audit.ts';
import { tx, type Db } from './db/index.ts';
import { BudgetExceededError } from './providers/freee/budget.ts';
import { ProviderError } from './providers/types.ts';

export type AttentionOptions = { now?: Date; actor?: string };

export function describeError(e: unknown): string {
  if (e instanceof ProviderError) return `${e.kind}: ${e.message}`;
  if (e instanceof BudgetExceededError) return `budget: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// 変えたら true。
export function markNeedsAttention(db: Db, documentId: string, reason: string, detail: Record<string, unknown> = {}, opts: AttentionOptions = {}): boolean {
  const now = opts.now ?? new Date();
  return tx(db, () => {
    const cur = db.prepare('SELECT status FROM documents WHERE id = ?').get(documentId) as { status: string } | undefined;
    if (!cur) throw new Error(`document ${documentId} が無い`);
    if (cur.status === 'needs_attention') return false;
    db.prepare(`UPDATE documents SET status = 'needs_attention' WHERE id = ?`).run(documentId);
    appendAudit(db, { actor: opts.actor ?? 'worker', action: 'document.needs_attention', entity: 'document', entityId: documentId, payload: { reason, from: cur.status, ...detail } }, now);
    return true;
  });
}

// 直近の document.needs_attention の reason（無ければ null）。
export function lastAttentionReason(db: Db, documentId: string): string | null {
  const r = db
    .prepare(
      `SELECT json_extract(payload_json, '$.reason') AS reason FROM audit_log WHERE entity = 'document' AND entity_id = ? AND action = 'document.needs_attention' ORDER BY seq DESC LIMIT 1`,
    )
    .get(documentId) as { reason: unknown } | undefined;
  return typeof r?.reason === 'string' ? r.reason : null;
}

// 変えたら true。
export function clearNeedsAttention(db: Db, documentId: string, nextStatus: string, opts: AttentionOptions & { detail?: Record<string, unknown> } = {}): boolean {
  const now = opts.now ?? new Date();
  return tx(db, () => {
    const cur = db.prepare('SELECT status FROM documents WHERE id = ?').get(documentId) as { status: string } | undefined;
    if (!cur) throw new Error(`document ${documentId} が無い`);
    if (cur.status !== 'needs_attention') return false;
    const reason = lastAttentionReason(db, documentId);
    db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(nextStatus, documentId);
    appendAudit(
      db,
      { actor: opts.actor ?? 'worker', action: 'document.needs_attention_cleared', entity: 'document', entityId: documentId, payload: { reason, to: nextStatus, ...(opts.detail ?? {}) } },
      now,
    );
    return true;
  });
}

export function getSetting(db: Db, key: string): unknown {
  const r = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  if (!r) return undefined;
  try {
    return JSON.parse(r.value_json) as unknown;
  } catch {
    return undefined;
  }
}

export function setSetting(db: Db, key: string, value: unknown, now: Date = new Date()): void {
  db.prepare(
    'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(value), now.toISOString());
}
