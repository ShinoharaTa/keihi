// Gmail の OAuth（authorization code + PKCE。docs/ops/gmail.md、docs/cashflow.md §16）。
// - scope は gmail.readonly だけ。redirect_uri はループバック（http://127.0.0.1:8797/）だが待ち受けはしない。
//   スマホのブラウザがつながらずに止まった URL を `keihi gmail auth <id>` に貼り、code を取り出す。
// - トークンはアカウントごとに <data_dir>/gmail-token-<id>.json（0600、<data_dir>/gmail-token-<id>.lock で排他）。
//   保存とロックは freee と同じ TokenStore（src/providers/freee/auth.ts）。
// - Google のリフレッシュトークンは更新の応答に入らないことがあるので、入らなければ前のものを残す。
// - アクセストークン・リフレッシュトークン・client_secret・code はログ・例外メッセージに出さない。
// - 再認可が要るか（invalid_grant・401・トークンが無い）は settings の gmail_reauth_required_<id> = 1。
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { getSetting, setSetting } from '../../attention.ts';
import type { Db } from '../../db/index.ts';
import { TokenStore } from '../../providers/freee/auth.ts';

export const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REDIRECT_URI = 'http://127.0.0.1:8797/';
export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const REFRESH_MARGIN_SEC = 300;
export const TOKEN_TIMEOUT_MS = 30_000;
export const REAUTH_KEY_PREFIX = 'gmail_reauth_required_';

export type GmailCredentials = { clientId: string; clientSecret: string };

export type GmailToken = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  // 取得した時刻（epoch 秒）。
  created_at: number;
  scope: string;
};

// 認可が無効（invalid_grant・401・トークンが無い）。再認可が要る。
export class GmailAuthError extends Error {
  readonly status: number | null;
  readonly error: string | null;
  constructor(message: string, opts: { status?: number | null; error?: string | null } = {}) {
    super(message);
    this.name = 'GmailAuthError';
    this.status = opts.status ?? null;
    this.error = opts.error ?? null;
  }
}

// 一時的な失敗（429・5xx・ネットワーク）。ジョブの再試行に回す。
export class GmailRetryableError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'GmailRetryableError';
    this.status = status;
  }
}

export function gmailTokenPaths(dataDir: string, accountId: string): { tokenPath: string; lockPath: string } {
  return { tokenPath: path.join(dataDir, `gmail-token-${accountId}.json`), lockPath: path.join(dataDir, `gmail-token-${accountId}.lock`) };
}

export function reauthKey(accountId: string): string {
  return `${REAUTH_KEY_PREFIX}${accountId}`;
}

export function isGmailReauthRequired(db: Db, accountId: string): boolean {
  return getSetting(db, reauthKey(accountId)) === 1;
}

export function setGmailReauthRequired(db: Db, accountId: string, required: boolean, now: Date = new Date()): void {
  setSetting(db, reauthKey(accountId), required ? 1 : 0, now);
}

// ---- PKCE と認可 URL ----

export type Pkce = { verifier: string; challenge: string; state: string };

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: randomBytes(16).toString('base64url') };
}

export function buildAuthorizeUrl(clientId: string, pkce: Pkce): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    // リフレッシュトークンを毎回受け取る（再認可のときも）。
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

// 貼り付けられた文字列（止まった URL 全体か code だけ）から code を取り出す。URL に state があれば一致を確かめる。
export function parseAuthResponse(input: string, expectedState: string): string {
  const s = input.trim();
  if (!s) throw new Error('貼り付けが空');
  if (!/^https?:\/\//i.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('URL を解釈できない');
  }
  const err = u.searchParams.get('error');
  if (err) throw new Error(`認可が拒否された（${err}）`);
  const state = u.searchParams.get('state');
  if (state !== null && state !== expectedState) throw new Error('URL の state が一致しない（別の認可の URL を貼っていないか確かめる）');
  const code = u.searchParams.get('code');
  if (!code) throw new Error('URL に code が無い');
  return code;
}

// ---- トークンエンドポイント ----

function toToken(raw: Record<string, unknown>, nowSec: number, prevRefresh: string | null): GmailToken {
  const s = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const refresh = s('refresh_token') || prevRefresh;
  if (!s('access_token')) throw new GmailAuthError('トークン応答に access_token が無い');
  if (!refresh) throw new GmailAuthError('トークン応答に refresh_token が無い（prompt=consent で認可し直す）');
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : NaN;
  if (!Number.isFinite(expiresIn)) throw new GmailAuthError('トークン応答に expires_in が無い');
  return { access_token: s('access_token'), refresh_token: refresh, token_type: s('token_type') || 'Bearer', expires_in: expiresIn, created_at: nowSec, scope: s('scope') };
}

async function postToken(
  params: Record<string, string>,
  prevRefresh: string | null,
  opts: { fetch?: typeof fetch; nowSec?: () => number; timeoutMs?: number },
): Promise<GmailToken> {
  const doFetch = opts.fetch ?? fetch;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const secrets = [params.client_secret, params.code, params.refresh_token, params.code_verifier].filter((v): v is string => !!v);
  const redact = (s: string) => secrets.reduce((acc, v) => acc.split(v).join('***'), s);
  let res: Response;
  try {
    res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TOKEN_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new GmailRetryableError(redact(`Google のトークンエンドポイントへの接続に失敗: ${msg}`));
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 本文は出さない
  }
  if (!res.ok) {
    const error = typeof body.error === 'string' ? body.error : null;
    const msg = redact(`Google トークン HTTP ${res.status}${error ? ` ${error}` : ''}`);
    if (res.status === 429 || res.status >= 500) throw new GmailRetryableError(msg, res.status);
    throw new GmailAuthError(msg, { status: res.status, error });
  }
  return toToken(body, nowSec(), prevRefresh);
}

export function exchangeCode(
  creds: GmailCredentials,
  code: string,
  verifier: string,
  opts: { fetch?: typeof fetch; nowSec?: () => number } = {},
): Promise<GmailToken> {
  return postToken(
    { grant_type: 'authorization_code', client_id: creds.clientId, client_secret: creds.clientSecret, code, code_verifier: verifier, redirect_uri: REDIRECT_URI },
    null,
    opts,
  );
}

export function refreshWith(creds: GmailCredentials, refreshToken: string, opts: { fetch?: typeof fetch; nowSec?: () => number } = {}): Promise<GmailToken> {
  return postToken({ grant_type: 'refresh_token', client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: refreshToken }, refreshToken, opts);
}

export function needsRefresh(t: GmailToken, nowSec: number): boolean {
  return nowSec >= t.created_at + t.expires_in - REFRESH_MARGIN_SEC;
}

export type GmailTokenProvider = {
  // 有効なアクセストークンを返す。force は 401 を受けたときの強制更新。
  get(opts?: { force?: boolean }): Promise<string>;
};

export function createGmailTokenProvider(opts: {
  store: TokenStore<GmailToken>;
  creds: GmailCredentials;
  fetch?: typeof fetch;
  nowSec?: () => number;
}): GmailTokenProvider {
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  let cache: GmailToken | null = null;
  return {
    async get({ force = false } = {}) {
      if (!force && cache && !needsRefresh(cache, nowSec())) return cache.access_token;
      const rejected = cache?.access_token ?? null;
      const cur = await opts.store.read();
      if (!cur) throw new GmailAuthError(`${opts.store.path} が無い。keihi gmail auth で認可する`);
      cache = cur;
      if (!force && !needsRefresh(cur, nowSec())) return cur.access_token;
      return opts.store.withLock(async () => {
        // ロックを取る間に他のプロセスが更新していれば、それを使う。
        const t = await opts.store.read();
        if (!t) throw new GmailAuthError(`${opts.store.path} が無い`);
        const stillBad = force ? t.access_token === (rejected ?? cur.access_token) : needsRefresh(t, nowSec());
        if (!stillBad) {
          cache = t;
          return t.access_token;
        }
        const next = await refreshWith(opts.creds, t.refresh_token, { fetch: opts.fetch, nowSec });
        await opts.store.write(next);
        cache = next;
        return next.access_token;
      });
    },
  };
}
