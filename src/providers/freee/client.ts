// freee 会計 API の最小クライアント（docs/freee-codex.md §3.2）。fetch を直接使う。SDK は使わない。
// - 1 つのクライアントは 1 つの事業所だけを扱う。company_id が違うリクエストは送る前に拒否する。
// - readOnly のクライアント（本番事業所の F15 用）は GET 以外を送る前に拒否する。
// - HTTP のエラーは例外にせず、ステータスをそのまま返す（PoC で記録するため）。
// - アクセストークンは Authorization ヘッダでだけ送り、URL・ログ・例外メッセージには出さない。
import type { TokenProvider } from './auth.ts';

export const DEFAULT_API_BASE = 'https://api.freee.co.jp';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type Query = Record<string, string | number | boolean | undefined>;

export type RequestOptions = {
  query?: Query;
  json?: Record<string, unknown>;
  form?: FormData;
  // 応答をバイト列で受け取る（/receipts/{id}/download）。
  binary?: boolean;
};

export type ApiResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  requestId: string | null;
  json: unknown;
  bytes: Buffer | null;
};

export class FreeeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreeeGuardError';
  }
}

export type FreeeClient = {
  readonly companyId: number;
  readonly readOnly: boolean;
  request(method: Method, path: string, opts?: RequestOptions): Promise<ApiResponse>;
};

function companyIdOf(opts: RequestOptions): unknown[] {
  const out: unknown[] = [];
  if (opts.query && 'company_id' in opts.query) out.push(opts.query.company_id);
  if (opts.json && 'company_id' in opts.json) out.push(opts.json.company_id);
  if (opts.form?.has('company_id')) out.push(opts.form.get('company_id'));
  return out;
}

// 送る前の検査。違反したら fetch を呼ばずに例外にする。
export function guardRequest(client: { companyId: number; readOnly: boolean }, method: Method, path: string, opts: RequestOptions): void {
  if (!path.startsWith('/api/1/')) throw new FreeeGuardError(`想定外のパス: ${path}`);
  if (client.readOnly && method !== 'GET') {
    throw new FreeeGuardError(`読み取り専用のクライアントで ${method} ${path} は送らない`);
  }
  const ids = companyIdOf(opts);
  if (method !== 'GET' && ids.length === 0) throw new FreeeGuardError(`${method} ${path} に company_id が無い`);
  for (const id of ids) {
    if (String(id) !== String(client.companyId)) {
      throw new FreeeGuardError(`company_id ${String(id)} は、このクライアントの事業所（${client.companyId}）と違う`);
    }
  }
}

export function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return `${baseUrl}${path}${s ? `?${s}` : ''}`;
}

export function createFreeeClient(opts: {
  tokens: TokenProvider;
  companyId: number;
  readOnly?: boolean;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): FreeeClient {
  const doFetch = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? DEFAULT_API_BASE;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const self = { companyId: opts.companyId, readOnly: opts.readOnly ?? false };

  async function send(method: Method, path: string, o: RequestOptions, token: string): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: o.binary ? '*/*' : 'application/json' };
    let body: BodyInit | undefined;
    if (o.json) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.json);
    } else if (o.form) {
      body = o.form; // multipart の境界は fetch が付ける
    }
    try {
      return await doFetch(buildUrl(baseUrl, path, o.query), { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new Error(`freee への接続に失敗: ${method} ${path}: ${msg.split(token).join('***')}`);
    }
  }

  return {
    ...self,
    async request(method, path, o = {}) {
      guardRequest(self, method, path, o);
      let token = await opts.tokens.get();
      let res = await send(method, path, o, token);
      if (res.status === 401) {
        // 期限切れなどで弾かれたら 1 回だけ更新して送り直す。
        await res.body?.cancel();
        token = await opts.tokens.get({ force: true, rejected: token });
        res = await send(method, path, o, token);
      }
      const requestId = res.headers.get('x-freee-request-id');
      let json: unknown = null;
      let bytes: Buffer | null = null;
      if (o.binary && res.ok) {
        bytes = Buffer.from(await res.arrayBuffer());
      } else {
        const text = await res.text();
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
      }
      return { status: res.status, ok: res.ok, headers: res.headers, requestId, json, bytes };
    },
  };
}
