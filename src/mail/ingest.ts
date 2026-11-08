// メール 1 通の取り込み（docs/cashflow.md §16）。
// 1. messages.get(format=full) でヘッダと添付の構造を取る → 2. messages.get(format=raw) をメール全体（.eml）として原本ストアに保存
// → 3. 添付を 1 つずつ取り（attachments.get。小さい添付は full の中に data で来る）、先頭バイトで PDF / JPEG / PNG と分かったものを
//    証憑にする（src/ingest/document.ts。kind = e_transaction、source = 'imap'、source_ref = Message-ID、
//    received_on = internalDate の JST 暦日、received_on_source = 'server'。加工しない）
// → 4. mail_messages・mail_attachments・documents・監査（mail.ingested。件名・送信元は入れない）を 1 トランザクションで記録する。
// - 添付の判定: filename があり、本文（attachmentId か data）のある part。HTML に埋め込まれた画像（Content-Disposition が inline で
//   Content-ID のある image/*。ロゴなど）は添付として扱わない。
// - [ingest] max_upload_bytes を超える添付は取らずに too_large。PDF / JPEG / PNG 以外は unsupported。
//   同じ内容の証憑が既にあれば duplicate（document_id は既存の証憑）。
// - メールの状態: 証憑にした（か既にある）添付が 1 つでもあれば ingested、無ければ too_large → unsupported → body_only の順。
// - 1 通の取得（4xx）・解析の失敗は state = error（fetch_failed / parse_failed）、attempts + 1 にして投げない（他の通を止めない）。
//   認可（GmailAuthError）と一時的な失敗（GmailRetryableError）は投げ直す（ジョブの側で扱う）。
import { appendAudit } from '../audit.ts';
import { todayInTokyo } from '../calendar/businessDays.ts';
import type { Config } from '../config.ts';
import { tx, type Db } from '../db/index.ts';
import { ulid } from '../db/ids.ts';
import { insertDocument, prepareDocument, type PreparedDocument } from '../ingest/document.ts';
import { sniffMime } from '../ingest/validate.ts';
import { putObject } from '../storage/objects.ts';
import { GmailApiError, decodeBase64Url, type GmailClient, type GmailMessage, type GmailPart } from './gmail/client.ts';

export const MAIL_PROVIDER = 'gmail_api';
export const MAX_SUBJECT_LENGTH = 1000;

export type MailState = 'ingested' | 'body_only' | 'unsupported' | 'too_large' | 'error';
export type AttachmentResult = 'ingested' | 'duplicate' | 'unsupported' | 'too_large';

export type MailIngestDeps = {
  db: Db;
  objectsDir: string;
  config: Pick<Config, 'ingest' | 'calendar' | 'deadline'>;
  now: () => Date;
};

export type AttachmentRef = {
  index: number;
  filename: string;
  declaredMime: string | null;
  size: number | null;
  attachmentId: string | null;
  data: string | null;
};

export type ParsedMessage = {
  remoteId: string;
  rfc822MessageId: string | null;
  fromDomain: string | null;
  subject: string | null;
  internalAt: Date;
  receivedOn: string;
  attachments: AttachmentRef[];
};

export class MailParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailParseError';
  }
}

export type MessageRow = { id: string; state: MailState; attempts: number };

export type IngestMessageResult = { mail_message_id: string; state: MailState; documents: number; duplicates: number };

function header(headers: { name: string; value: string }[] | undefined, name: string): string | null {
  const h = (headers ?? []).find((x) => typeof x?.name === 'string' && x.name.toLowerCase() === name);
  return typeof h?.value === 'string' ? h.value : null;
}

// From ヘッダのアドレスのドメイン（小文字）。読めなければ null。
export function fromDomainOf(from: string | null): string | null {
  if (!from) return null;
  const angle = /<([^<>]*)>\s*$/.exec(from);
  const addr = angle ? angle[1]! : from;
  const m = /@([A-Za-z0-9.-]+)\s*$/.exec(addr.trim());
  return m ? m[1]!.toLowerCase().replace(/\.$/, '') : null;
}

function isEmbeddedImage(p: GmailPart): boolean {
  const disp = header(p.headers, 'content-disposition');
  const cid = header(p.headers, 'content-id');
  return !!cid && (disp === null || /^\s*inline/i.test(disp)) && (p.mimeType ?? '').toLowerCase().startsWith('image/');
}

export function parseGmailMessage(m: GmailMessage): ParsedMessage {
  if (!m || typeof m.id !== 'string' || !m.id) throw new MailParseError('id が無い');
  if (typeof m.internalDate !== 'string' || !/^\d{1,16}$/.test(m.internalDate)) throw new MailParseError('internalDate が無い');
  const internalAt = new Date(Number(m.internalDate));
  if (Number.isNaN(internalAt.getTime())) throw new MailParseError('internalDate を読めない');
  const payload = m.payload;
  if (!payload || typeof payload !== 'object') throw new MailParseError('payload が無い');
  const attachments: AttachmentRef[] = [];
  const walk = (p: GmailPart, depth: number) => {
    if (depth > 20) throw new MailParseError('part の入れ子が深すぎる');
    const filename = typeof p.filename === 'string' ? p.filename : '';
    const body = p.body ?? {};
    const attachmentId = typeof body.attachmentId === 'string' && body.attachmentId ? body.attachmentId : null;
    const data = typeof body.data === 'string' ? body.data : null;
    if (filename && (attachmentId || data !== null) && !isEmbeddedImage(p)) {
      attachments.push({
        index: attachments.length,
        filename: filename.slice(0, 500),
        declaredMime: typeof p.mimeType === 'string' ? p.mimeType.slice(0, 200) : null,
        size: typeof body.size === 'number' && Number.isSafeInteger(body.size) ? body.size : null,
        attachmentId,
        data,
      });
    }
    if (p.parts !== undefined) {
      if (!Array.isArray(p.parts)) throw new MailParseError('parts が配列でない');
      for (const c of p.parts) walk(c, depth + 1);
    }
  };
  walk(payload, 0);
  const subject = header(payload.headers, 'subject');
  return {
    remoteId: m.id,
    rfc822MessageId: header(payload.headers, 'message-id')?.trim().slice(0, 998) || null,
    fromDomain: fromDomainOf(header(payload.headers, 'from')),
    subject: subject === null ? null : subject.slice(0, MAX_SUBJECT_LENGTH),
    internalAt,
    receivedOn: todayInTokyo(internalAt),
    attachments,
  };
}

export function findMessage(db: Db, accountId: string, remoteId: string): MessageRow | null {
  return (
    (db.prepare('SELECT id, state, attempts FROM mail_messages WHERE account_id = ? AND provider = ? AND remote_id = ?').get(accountId, MAIL_PROVIDER, remoteId) as
      | MessageRow
      | undefined) ?? null
  );
}

// 1 通の失敗を記録する（新しい行は attempts = 1、既にある error の行は attempts + 1）。
function recordError(db: Db, accountId: string, remoteId: string, reason: 'fetch_failed' | 'parse_failed', parsed: ParsedMessage | null, now: Date): IngestMessageResult {
  const iso = now.toISOString();
  return tx(db, () => {
    const cur = findMessage(db, accountId, remoteId);
    let id: string;
    let attempts: number;
    if (cur) {
      id = cur.id;
      attempts = cur.attempts + 1;
      db.prepare(`UPDATE mail_messages SET state = 'error', error_reason = ?, attempts = ?, updated_at = ? WHERE id = ?`).run(reason, attempts, iso, id);
    } else {
      id = ulid(now.getTime());
      attempts = 1;
      db.prepare(
        `INSERT INTO mail_messages (id, account_id, provider, remote_id, rfc822_message_id, from_domain, subject, internal_at, received_on,
           state, error_reason, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'error', ?, 1, ?, ?)`,
      ).run(
        id, accountId, MAIL_PROVIDER, remoteId, parsed?.rfc822MessageId ?? null, parsed?.fromDomain ?? null, parsed?.subject ?? null,
        parsed ? parsed.internalAt.toISOString() : null, parsed?.receivedOn ?? null, reason, iso, iso,
      );
    }
    appendAudit(db, { actor: 'worker', action: 'mail.failed', entity: 'mail_message', entityId: id, payload: { account_id: accountId, reason, attempts } }, now);
    return { mail_message_id: id, state: 'error' as const, documents: 0, duplicates: 0 };
  });
}

type PlannedAttachment = {
  ref: AttachmentRef;
  bytes: number | null;
  mime: string | null;
  sha256: string | null;
  result: AttachmentResult;
  documentId: string | null;
  prepared: PreparedDocument | null;
};

// 1 通を取り込む。既に取り込んだ（error 以外の）メールは呼び出し側で飛ばす。
export async function ingestMessage(deps: MailIngestDeps, client: GmailClient, accountId: string, remoteId: string): Promise<IngestMessageResult> {
  const { db } = deps;
  const maxBytes = deps.config.ingest.maxBytes;
  const fetchFailed = (e: unknown, parsed: ParsedMessage | null) => {
    if (e instanceof GmailApiError) return recordError(db, accountId, remoteId, 'fetch_failed', parsed, deps.now());
    if (e instanceof MailParseError) return recordError(db, accountId, remoteId, 'parse_failed', parsed, deps.now());
    throw e;
  };

  let parsed: ParsedMessage;
  try {
    parsed = parseGmailMessage(await client.getFull(remoteId));
    if (parsed.remoteId !== remoteId) throw new MailParseError('応答の id が違う');
  } catch (e) {
    return fetchFailed(e, null);
  }

  let rawKey: string;
  let rawSha: string;
  const planned: PlannedAttachment[] = [];
  try {
    const raw = await client.getRaw(remoteId);
    if (raw.length === 0) throw new MailParseError('raw が空');
    const stored = await putObject(deps.objectsDir, raw);
    rawKey = stored.key;
    rawSha = stored.sha256;

    for (const ref of parsed.attachments) {
      const base = { ref, mime: ref.declaredMime, sha256: null, documentId: null, prepared: null };
      if (ref.size !== null && ref.size > maxBytes) {
        planned.push({ ...base, bytes: ref.size, result: 'too_large' });
        continue;
      }
      const bytes = ref.data !== null ? decodeBase64Url(ref.data) : await client.getAttachment(remoteId, ref.attachmentId!);
      if (bytes.length > maxBytes) {
        planned.push({ ...base, bytes: bytes.length, result: 'too_large' });
        continue;
      }
      const sniffed = sniffMime(bytes);
      if (!sniffed) {
        planned.push({ ...base, bytes: bytes.length, result: 'unsupported' });
        continue;
      }
      const r = await prepareDocument(deps, {
        bytes, origName: ref.filename, kind: 'e_transaction', sizePreset: null, receivedOn: parsed.receivedOn, receivedOnSource: 'server',
        noAi: false, force: false, source: 'imap', sourceRef: parsed.rfc822MessageId, actor: 'worker',
      });
      if (r.ok) planned.push({ ...base, bytes: bytes.length, mime: sniffed, sha256: r.prepared.sha256, result: 'ingested', prepared: r.prepared });
      else if (r.status === 409) planned.push({ ...base, bytes: bytes.length, mime: sniffed, sha256: r.body.sha256, result: 'duplicate', documentId: r.body.id });
      // e_transaction で MIME を確かめた後なので、ここには来ない。
      else throw new MailParseError(`添付を取り込めない: ${r.body.reason}`);
    }
  } catch (e) {
    return fetchFailed(e, parsed);
  }

  const at = deps.now();
  const iso = at.toISOString();
  return tx(db, () => {
    let documents = 0;
    let duplicates = 0;
    for (const p of planned) {
      if (!p.prepared) continue;
      const r = insertDocument(db, p.prepared, at);
      if (r.ok) {
        p.documentId = r.id;
        documents++;
      } else {
        // 同じメールの中で同じ添付が 2 回出た、または他の取り込みが先に入れた。
        p.result = 'duplicate';
        p.documentId = r.body.id;
      }
    }
    duplicates = planned.filter((p) => p.result === 'duplicate').length;
    const has = (r: AttachmentResult) => planned.some((p) => p.result === r);
    const state: MailState = has('ingested') || has('duplicate') ? 'ingested' : has('too_large') ? 'too_large' : has('unsupported') ? 'unsupported' : 'body_only';

    const cur = findMessage(db, accountId, remoteId);
    let id: string;
    if (cur) {
      // 取り直し（error の行）。中身の列は NULL のものだけ埋まる（0010_mail.sql のトリガ）。
      id = cur.id;
      db.prepare(
        `UPDATE mail_messages SET rfc822_message_id = COALESCE(rfc822_message_id, ?), from_domain = COALESCE(from_domain, ?), subject = COALESCE(subject, ?),
           internal_at = COALESCE(internal_at, ?), received_on = COALESCE(received_on, ?), raw_sha256 = ?, raw_storage_key = ?,
           state = ?, error_reason = NULL, updated_at = ? WHERE id = ?`,
      ).run(parsed.rfc822MessageId, parsed.fromDomain, parsed.subject, parsed.internalAt.toISOString(), parsed.receivedOn, rawSha, rawKey, state, iso, id);
    } else {
      id = ulid(at.getTime());
      db.prepare(
        `INSERT INTO mail_messages (id, account_id, provider, remote_id, rfc822_message_id, from_domain, subject, internal_at, received_on,
           raw_sha256, raw_storage_key, state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        id, accountId, MAIL_PROVIDER, remoteId, parsed.rfc822MessageId, parsed.fromDomain, parsed.subject, parsed.internalAt.toISOString(),
        parsed.receivedOn, rawSha, rawKey, state, iso, iso,
      );
    }
    const ins = db.prepare(
      `INSERT INTO mail_attachments (id, mail_message_id, part_index, filename, mime, bytes, sha256, document_id, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of planned) ins.run(ulid(at.getTime()), id, p.ref.index, p.ref.filename, p.mime, p.bytes, p.sha256, p.documentId, p.result, iso);
    appendAudit(
      db,
      {
        actor: 'worker',
        action: 'mail.ingested',
        entity: 'mail_message',
        entityId: id,
        payload: { account_id: accountId, state, attachments: planned.length, documents, duplicates },
      },
      at,
    );
    return { mail_message_id: id, state, documents, duplicates };
  });
}
