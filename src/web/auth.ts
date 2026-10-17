// 認証（docs/mvp-plan.md T1-14、docs/mvp-plan-v0.1.md T1-14・D7・§4.3、architecture.md §3.7）。
// 1 つのミドルウェアで順に確かめる。
//   1. Host が許可リスト（`127.0.0.1:<port>` と tailscale serve のホスト名）に無ければ 400（DNS rebinding 対策）。
//   2. /healthz はここで通す（中身は ok だけ）。
//   3. 変更系のメソッドで Origin があり、その host が許可リストに無ければ 403（CSRF）。Origin の無い POST（iOS ショートカット）は通す。
//   4. Tailscale-User-Login が無ければ 401、許可リストに無ければ 403。
// D7: 同じ uid のローカルプロセスは信頼境界の内側とみなすので、127.0.0.1 に直接来たヘッダも信用する。WebAuthn は MVP 外。
import type { Context, MiddlewareHandler } from 'hono';
import type { Config } from '../config.ts';

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

export function createAuth(web: Pick<Config['web'], 'allowedUsers' | 'allowedHosts'>): MiddlewareHandler {
  const hosts = new Set(web.allowedHosts.map((h) => h.toLowerCase()));
  const users = new Set(web.allowedUsers);
  return async (c: Context, next) => {
    const host = (c.req.header('Host') ?? '').toLowerCase();
    if (!hosts.has(host)) return c.json({ reason: 'invalid_host' }, 400);
    if (c.req.path === HEALTHZ_PATH) return next();

    const origin = c.req.header('Origin');
    if (origin !== undefined && !SAFE_METHODS.has(c.req.method)) {
      const oh = originHost(origin);
      if (oh === null || !hosts.has(oh)) return c.json({ reason: 'invalid_origin' }, 403);
    }

    const user = c.req.header(USER_HEADER);
    if (user === undefined || user === '') return c.json({ reason: 'unauthenticated' }, 401);
    if (!users.has(user)) return c.json({ reason: 'forbidden' }, 403);
    return next();
  };
}
