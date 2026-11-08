// Gmail API（REST、読み取り専用）の最小のクライアント。npm の依存は足さず fetch で直接呼ぶ。
//   users.messages.list / users.messages.get（format=full・raw）/ users.messages.attachments.get / users.getProfile
// - 401 は 1 回だけトークンを強制更新して呼び直し、それでも 401 なら GmailAuthError（再認可が要る）。
// - 429・5xx・ネットワークの失敗と、403 の rateLimitExceeded / userRateLimitExceeded は GmailRetryableError（ジョブの再試行）。
// - それ以外の 4xx は GmailApiError（1 通の取得の失敗として扱う。src/mail/ingest.ts）。
// - アクセストークンは例外メッセージに出さない。本文も出さない（HTTP の状態とエラーの reason だけ）。
import { GmailAuthError, GmailRetryableError, type GmailTokenProvider } from './auth.ts';

export const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const API_TIMEOUT_MS = 60_000;

export class GmailApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GmailApiError';
    this.status = status;
  }
}

export type GmailHeader = { name: string; value: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
};
export type GmailMessage = { id: string; threadId?: string; internalDate?: string; payload?: GmailPart };
export type GmailListPage = { messages?: { id: string; threadId?: string }[]; nextPageToken?: string };

export type GmailClient = {
  listMessages(q: string, opts?: { pageToken?: string; maxResults?: number }): Promise<GmailListPage>;
  getFull(id: string): Promise<GmailMessage>;
  getRaw(id: string): Promise<Uint8Array>;
  getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array>;
  getProfile(): Promise<{ emailAddress: string }>;
};

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

function reasonOf(body: unknown): string | null {
  const e = (body as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
  const r = e?.errors?.[0]?.reason;
  if (typeof r === 'string') return r;
  return typeof e?.status === 'string' ? e.status : null;
}

export function decodeBase64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function createGmailClient(opts: { tokens: GmailTokenProvider; fetch?: typeof fetch; timeoutMs?: number }): GmailClient {
  const doFetch = opts.fetch ?? fetch;
  const call = async (pathAndQuery: string): Promise<unknown> => {
    const label = pathAndQuery.split('?')[0]!.replace(/\/messages\/[^/]+/, '/messages/:id').replace(/\/attachments\/[^/]+/, '/attachments/:id');
    let force = false;
    for (let i = 0; i < 2; i++) {
      const token = await opts.tokens.get({ force });
      let res: Response;
      try {
        res = await doFetch(`${API_BASE}${pathAndQuery}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(opts.timeoutMs ?? API_TIMEOUT_MS),
        });
      } catch (e) {
        throw new GmailRetryableError(`Gmail ${label} への接続に失敗: ${e instanceof Error ? e.name : String(e)}`);
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // 本文は出さない
      }
      if (res.ok) {
        if (body === null) throw new GmailApiError(`Gmail ${label} の応答が JSON でない`, res.status);
        return body;
      }
      const reason = reasonOf(body);
      const msg = `Gmail ${label} HTTP ${res.status}${reason ? ` ${reason}` : ''}`;
      if (res.status === 401) {
        if (!force) {
          force = true;
          continue;
        }
        throw new GmailAuthError(msg, { status: 401 });
      }
      if (res.status === 429 || res.status >= 500 || (res.status === 403 && reason !== null && RATE_REASONS.has(reason))) throw new GmailRetryableError(msg, res.status);
      throw new GmailApiError(msg, res.status);
    }
    throw new GmailAuthError('Gmail の認可が通らない', { status: 401 });
  };
  const enc = encodeURIComponent;
  return {
    async listMessages(q, o = {}) {
      const p = new URLSearchParams({ q, maxResults: String(o.maxResults ?? 500) });
      if (o.pageToken) p.set('pageToken', o.pageToken);
      return (await call(`/messages?${p.toString()}`)) as GmailListPage;
    },
    async getFull(id) {
      return (await call(`/messages/${enc(id)}?format=full`)) as GmailMessage;
    },
    async getRaw(id) {
      const r = (await call(`/messages/${enc(id)}?format=raw`)) as { raw?: unknown };
      if (typeof r.raw !== 'string') throw new GmailApiError('Gmail messages.get(raw) の応答に raw が無い', 200);
      return decodeBase64Url(r.raw);
    },
    async getAttachment(messageId, attachmentId) {
      const r = (await call(`/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`)) as { data?: unknown };
      if (typeof r.data !== 'string') throw new GmailApiError('Gmail attachments.get の応答に data が無い', 200);
      return decodeBase64Url(r.data);
    },
    async getProfile() {
      const r = (await call('/profile')) as { emailAddress?: unknown };
      if (typeof r.emailAddress !== 'string') throw new GmailApiError('Gmail getProfile の応答に emailAddress が無い', 200);
      return { emailAddress: r.emailAddress };
    },
  };
}
