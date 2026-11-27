// 認証（docs/mvp-plan.md T1-14、docs/mvp-plan-v0.1.md T1-14・D7・§4.3、architecture.md §3.7）。
// 1 つのミドルウェアで順に確かめる。
//   1. Host が許可リスト（`127.0.0.1:<port>` と tailscale serve のホスト名）に無ければ 400（DNS rebinding 対策）。
//   2. /healthz はここで通す（中身は ok だけ）。
//   3. 変更系のメソッドで Origin があり、その host が許可リストに無ければ 403（CSRF）。Origin の無い POST（iOS ショートカット）は通す。
//   4. tailscale: Tailscale-User-Login が無ければ 401、許可リストに無ければ 403。
//      cloudflare_access（#102）: Tailscale-User-Login は見ない。Cf-Access-Jwt-Assertion が無ければ 401 unauthenticated、
//      検証に失敗したら 401 invalid_token、JWKS が取れず検証できなければ 503 auth_unavailable。
//      email が allowed_users に（小文字で比べる）、email が無く common_name が access_service_tokens にあれば通す。それ以外は 403。
//      none: 利用者を確かめない。Tailscale-User-Login も Cf-Access-Jwt-Assertion も見ず、allowed_users の 1 件を利用者として通す
//      （VPN・LAN の内側だけで届く構成向け。1・3 の検査は残る）。
//   通したら c.set('user', …)。ルートは userOf(c) で読む。
// D7: 同じ uid のローカルプロセスは信頼境界の内側とみなすので、127.0.0.1 に直接来たヘッダも信用する。WebAuthn は MVP 外。
import type { Context, MiddlewareHandler } from 'hono';
import { ACCESS_HEADER, createAccessVerifier } from './access.ts';

// 認証を通った利用者（監査ログの user）。ルートは userOf(c) で読む。
declare module 'hono' {
  interface ContextVariableMap {
    user: string;
  }
}

export const USER_HEADER = 'Tailscale-User-Login';
export const HEALTHZ_PATH = '/healthz';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

export type AuthConfig = {
  allowedUsers: string[];
  allowedHosts: string[];
  auth?: 'tailscale' | 'cloudflare_access' | 'none';
  accessTeamDomain?: string | null;
  accessAud?: string | null;
  accessServiceTokens?: string[];
};

export type AuthLogger = { warn(msg: string, fields?: Record<string, unknown>): void };

export type AuthDeps = { fetch?: typeof fetch; now?: () => Date; log?: AuthLogger };

const silent: AuthLogger = { warn: () => {} };

export function createAuth(web: AuthConfig, deps: AuthDeps = {}): MiddlewareHandler {
  const hosts = new Set(web.allowedHosts.map((h) => h.toLowerCase()));
  const users = new Set(web.allowedUsers);
  const log = deps.log ?? silent;
  let access: ((c: Context) => Promise<Response | string>) | null = null;
  if (web.auth === 'none' && web.allowedUsers.length !== 1) throw new Error('none には allowed_users がちょうど 1 件要る');
  const fixedUser = web.auth === 'none' ? web.allowedUsers[0] : null;
  if (web.auth === 'cloudflare_access') {
    if (!web.accessTeamDomain || !web.accessAud) throw new Error('cloudflare_access には access_team_domain と access_aud が要る');
    const verifier = createAccessVerifier({ teamDomain: web.accessTeamDomain, aud: web.accessAud, fetch: deps.fetch, now: deps.now });
    const emails = new Set(web.allowedUsers.map((u) => u.toLowerCase()));
    const services = new Set(web.accessServiceTokens ?? []);
    // 通すなら利用者（user に入れる値）、止めるなら応答を返す。トークンは log に出さない。
    access = async (c) => {
      const token = c.req.header(ACCESS_HEADER);
      if (token === undefined || token === '') return c.json({ reason: 'unauthenticated' }, 401);
      const r = await verifier.verify(token);
      if (!r.ok) {
        log.warn('access token rejected', { reason: r.reason });
        return r.unavailable ? c.json({ reason: 'auth_unavailable' }, 503) : c.json({ reason: 'invalid_token' }, 401);
      }
      if (r.email !== null) return emails.has(r.email.toLowerCase()) ? r.email : c.json({ reason: 'forbidden' }, 403);
      if (r.commonName !== null && services.has(r.commonName)) return `service:${r.commonName}`;
      return c.json({ reason: 'forbidden' }, 403);
    };
  }
  return async (c: Context, next) => {
    const host = (c.req.header('Host') ?? '').toLowerCase();
    if (!hosts.has(host)) return c.json({ reason: 'invalid_host' }, 400);
    if (c.req.path === HEALTHZ_PATH) return next();

    const origin = c.req.header('Origin');
    if (origin !== undefined && !SAFE_METHODS.has(c.req.method)) {
      const oh = originHost(origin);
      if (oh === null || !hosts.has(oh)) return c.json({ reason: 'invalid_origin' }, 403);
    }

    if (fixedUser !== null) {
      c.set('user', fixedUser);
      return next();
    }

    if (access !== null) {
      const r = await access(c);
      if (typeof r !== 'string') return r;
      c.set('user', r);
      return next();
    }

    const user = c.req.header(USER_HEADER);
    if (user === undefined || user === '') return c.json({ reason: 'unauthenticated' }, 401);
    if (!users.has(user)) return c.json({ reason: 'forbidden' }, 403);
    c.set('user', user);
    return next();
  };
}

// ルートが監査ログに書く利用者。ヘッダへのフォールバックは認証を素通しにしているテスト用。
export function userOf(c: Context): string | null {
  return c.get('user') ?? c.req.header(USER_HEADER) ?? null;
}
