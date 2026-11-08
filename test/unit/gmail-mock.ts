// Gmail API とトークンエンドポイントの fetch のモック（mail のテストで共用）。送信元は example.com / example.net の架空の値。
import { TOKEN_URL, type GmailToken } from '../../src/mail/gmail/auth.ts';
import { API_BASE, type GmailMessage, type GmailPart } from '../../src/mail/gmail/client.ts';

export type MockAttachment = { filename: string; mime: string; bytes: Uint8Array; inline?: boolean; cid?: string; inlineData?: boolean; declaredSize?: number };
export type MockMessageInput = {
  id: string;
  internalMs: number;
  from?: string;
  subject?: string;
  messageId?: string | null;
  attachments?: MockAttachment[];
  // 本文。text が null なら text/plain を入れない（既定は短い定型文）。html があれば text/html の part を足す。
  text?: string | null;
  html?: string;
};

export const pdf = (tag: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n% keihi test ${tag}\n%%EOF\n`, 'latin1'));
export const zip = (tag: string) => new Uint8Array(Buffer.from(`PK\u0003\u0004 keihi test ${tag}`, 'latin1'));
export const png = (tag: string) => new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]));

export function buildMessage(m: MockMessageInput): { full: GmailMessage; raw: Uint8Array; attachments: Map<string, Uint8Array> } {
  const headers = [
    { name: 'From', value: m.from ?? 'Billing <billing@example.com>' },
    { name: 'Subject', value: m.subject ?? '領収書のお知らせ' },
  ];
  if (m.messageId !== null) headers.push({ name: 'Message-ID', value: m.messageId ?? `<${m.id}@mail.example.com>` });
  const attachments = new Map<string, Uint8Array>();
  const parts: GmailPart[] = [];
  const text = m.text === undefined ? 'ご利用ありがとうございます' : m.text;
  if (text !== null) parts.push({ partId: '0', mimeType: 'text/plain', filename: '', headers: [], body: { size: text.length, data: Buffer.from(text).toString('base64url') } });
  if (m.html !== undefined) parts.push({ partId: '0.1', mimeType: 'text/html', filename: '', headers: [], body: { size: m.html.length, data: Buffer.from(m.html).toString('base64url') } });
  for (const [i, a] of (m.attachments ?? []).entries()) {
    const h = [{ name: 'Content-Disposition', value: `${a.inline ? 'inline' : 'attachment'}; filename="${a.filename}"` }];
    if (a.cid) h.push({ name: 'Content-ID', value: `<${a.cid}>` });
    const size = a.declaredSize ?? a.bytes.length;
    if (a.inlineData) parts.push({ partId: String(i + 1), mimeType: a.mime, filename: a.filename, headers: h, body: { size, data: Buffer.from(a.bytes).toString('base64url') } });
    else {
      const aid = `att-${m.id}-${i}`;
      attachments.set(aid, a.bytes);
      parts.push({ partId: String(i + 1), mimeType: a.mime, filename: a.filename, headers: h, body: { size, attachmentId: aid } });
    }
  }
  const full: GmailMessage = {
    id: m.id,
    threadId: m.id,
    internalDate: String(m.internalMs),
    payload: { partId: '', mimeType: 'multipart/mixed', filename: '', headers, body: { size: 0 }, parts },
  };
  const raw = new Uint8Array(Buffer.from(`From: billing@example.com\r\nSubject: test\r\nMessage-ID: <${m.id}@mail.example.com>\r\n\r\nbody ${m.id}\r\n`));
  return { full, raw, attachments };
}

export type Override = { status: number; body?: unknown } | 'network';

export function createGmailMock() {
  const messages = new Map<string, ReturnType<typeof buildMessage>>();
  // list の順（新しい順）。
  const order: string[] = [];
  const calls: { method: string; url: string; auth: string | null }[] = [];
  // パスの一部（例 '/messages/m1?format=full'）→ 返す失敗。once なら 1 回だけ。
  const overrides: { match: string; res: Override; once: boolean }[] = [];
  let tokenResponse: { status: number; body: unknown } = { status: 200, body: { access_token: 'access-NEW', expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.readonly' } };
  let pageSize = 500;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ method, url, auth });
    if (url === TOKEN_URL) return json(tokenResponse.status, tokenResponse.body);
    if (!url.startsWith(API_BASE)) return json(404, { error: { message: 'unknown' } });
    const rest = url.slice(API_BASE.length);
    const ov = overrides.find((o) => rest.includes(o.match));
    if (ov) {
      if (ov.once) overrides.splice(overrides.indexOf(ov), 1);
      if (ov.res === 'network') throw new TypeError('fetch failed');
      return json(ov.res.status, ov.res.body ?? { error: { code: ov.res.status, message: 'x' } });
    }
    const u = new URL(url);
    let m: RegExpExecArray | null;
    if (u.pathname.endsWith('/users/me/profile')) return json(200, { emailAddress: 'someone@example.com' });
    if (u.pathname.endsWith('/users/me/messages')) {
      const start = Number(u.searchParams.get('pageToken') ?? '0');
      const ids = order.slice(start, start + pageSize);
      const next = start + pageSize < order.length ? String(start + pageSize) : undefined;
      return json(200, { messages: ids.map((id) => ({ id, threadId: id })), ...(next ? { nextPageToken: next } : {}), resultSizeEstimate: ids.length });
    }
    if ((m = /\/users\/me\/messages\/([^/]+)\/attachments\/([^/?]+)$/.exec(u.pathname))) {
      const msg = messages.get(decodeURIComponent(m[1]!));
      const a = msg?.attachments.get(decodeURIComponent(m[2]!));
      if (!a) return json(404, { error: { code: 404 } });
      return json(200, { size: a.length, data: Buffer.from(a).toString('base64url') });
    }
    if ((m = /\/users\/me\/messages\/([^/]+)$/.exec(u.pathname))) {
      const msg = messages.get(decodeURIComponent(m[1]!));
      if (!msg) return json(404, { error: { code: 404 } });
      if (u.searchParams.get('format') === 'raw') return json(200, { id: msg.full.id, raw: Buffer.from(msg.raw).toString('base64url') });
      return json(200, msg.full);
    }
    return json(404, { error: { code: 404 } });
  };

  return {
    fetch,
    calls,
    // 新しいメールほど前に入れる（Gmail の list と同じ新しい順）。
    add(m: MockMessageInput) {
      const b = buildMessage(m);
      messages.set(m.id, b);
      order.push(m.id);
      order.sort((x, y) => Number(messages.get(y)!.full.internalDate) - Number(messages.get(x)!.full.internalDate));
      return b;
    },
    setFull(id: string, full: unknown) {
      messages.get(id)!.full = full as GmailMessage;
    },
    fail(match: string, res: Override, once = false) {
      overrides.push({ match, res, once });
    },
    clearFailures() {
      overrides.length = 0;
    },
    setToken(status: number, body: unknown) {
      tokenResponse = { status, body };
    },
    setPageSize(n: number) {
      pageSize = n;
    },
    apiCalls: () => calls.filter((c) => c.url.startsWith(API_BASE)),
    gets: (format: 'full' | 'raw') => calls.filter((c) => c.url.includes(`format=${format}`)),
  };
}

export function token(over: Partial<GmailToken> = {}): GmailToken {
  return {
    access_token: 'access-OLD',
    refresh_token: 'refresh-SECRET-1',
    token_type: 'Bearer',
    expires_in: 3599,
    created_at: Math.floor(Date.now() / 1000),
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    ...over,
  };
}
