// freee 会計 API の最小クライアント（docs/freee-codex.md §3.2）。fetch を直接使う。SDK は使わない。
// - 1 つのクライアントは 1 つの事業所だけを扱う。company_id が違うリクエストは送る前に拒否する。
// - readOnly のクライアント（本番事業所の F15 用）は GET 以外を送る前に拒否する。
// - HTTP のエラーは例外にせず、ステータスをそのまま返す（PoC で記録するため）。
// - アクセストークンは Authorization ヘッダでだけ送り、URL・ログ・例外メッセージには出さない。
// - keihi 本体（provider.ts）は budget（T1-15）・serial（1 本ずつ）・downloadLimit（/receipts/{id}/download は 1 秒 3 回）を付けて使う。
//   PoC は付けない（F6 で上限を超えたときの応答を見るため）。
import type { TokenProvider } from './auth.ts';
import type { Purpose } from './budget.ts';

export const DEFAULT_API_BASE = 'https://api.freee.co.jp';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type Query = Record<string, string | number | boolean | undefined>;

export type RequestOptions = {
  query?: Query;
  json?: Record<string, unknown>;
  form?: FormData;
  // 応答をバイト列で受け取る（/receipts/{id}/download）。
  binary?: boolean;
  // 予算の用途。budget を付けたクライアントでは必須。
  purpose?: Purpose;
};

// HTTP の 1 回ごとに予算を確かめて記録する（budget.ts の Budget の一部）。
export type CallBudget = {
  begin(purpose: Purpose, method: string, endpoint: string): number;
  finish(callId: number, status: number | null, requestId: string | null): void;
};

export type RateLimit = { max: number; windowMs: number };
export const DOWNLOAD_LIMIT: RateLimit = { max: 3, windowMs: 1000 };
const DOWNLOAD_PATH = /^\/api\/1\/receipts\/\d+\/download$/;

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

// 応答が来なかった（接続できない・タイムアウト）。timeout は「実は届いている」ことがある。
export class FreeeNetworkError extends Error {
  readonly timeout: boolean;
  constructor(message: string, timeout: boolean) {
    super(message);
    this.name = 'FreeeNetworkError';
    this.timeout = timeout;
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
  budget?: CallBudget;
  // true なら request を 1 本ずつ順に送る（前の応答を待ってから次を送る）。
  serial?: boolean;
  downloadLimit?: RateLimit;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): FreeeClient {
  const doFetch = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? DEFAULT_API_BASE;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const self = { companyId: opts.companyId, readOnly: opts.readOnly ?? false };
  const downloads: number[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  // 直近 windowMs に max 回送っていれば、いちばん古いものが窓から出るまで待つ。
  async function waitDownloadSlot(limit: RateLimit): Promise<void> {
    for (;;) {
      const t = nowMs();
      while (downloads.length && t - downloads[0] >= limit.windowMs) downloads.shift();
      if (downloads.length < limit.max) {
        downloads.push(t);
        return;
      }
      await sleep(limit.windowMs - (t - downloads[0]));
    }
  }

  async function send(method: Method, path: string, o: RequestOptions, token: string): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: o.binary ? '*/*' : 'application/json' };
    let body: BodyInit | undefined;
    if (o.json) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.json);
    } else if (o.form) {
      body = o.form; // multipart の境界は fetch が付ける
    }
    if (opts.downloadLimit && method === 'GET' && DOWNLOAD_PATH.test(path)) await waitDownloadSlot(opts.downloadLimit);
    const callId = opts.budget ? opts.budget.begin(o.purpose!, method, path) : null;
    let res: Response;
    try {
      res = await doFetch(buildUrl(baseUrl, path, o.query), { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (callId !== null) opts.budget!.finish(callId, null, null);
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new FreeeNetworkError(`freee への接続に失敗: ${method} ${path}: ${msg.split(token).join('***')}`, timeout);
    }
    if (callId !== null) opts.budget!.finish(callId, res.status, res.headers.get('x-freee-request-id'));
    return res;
  }

  async function doRequest(method: Method, path: string, o: RequestOptions): Promise<ApiResponse> {
    guardRequest(self, method, path, o);
    if (opts.budget && !o.purpose) throw new FreeeGuardError(`${method} ${path} に予算の用途（purpose）が無い`);
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
  }

  return {
    ...self,
    request(method, path, o = {}) {
      if (!opts.serial) return doRequest(method, path, o);
      const p = chain.then(() => doRequest(method, path, o));
      chain = p.catch(() => {});
      return p;
    },
  };
}
