// Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）の検証（#102）。依存を足さず node:crypto だけで書く。
//   - RS256 だけを受け付ける（none・HS256 などは拒否）。トークンは 8KB まで。
//   - 鍵は https://<teamDomain>/cdn-cgi/access/certs の JWKS。1 時間キャッシュし、知らない kid は取り直す
//     （取り直しは 60 秒に 1 回まで、同時に 1 本だけ）。取得に失敗してもキャッシュの鍵は使う。鍵が 1 つも無ければ unavailable。
//   - クレーム: iss・aud・exp・nbf（時計のずれは 60 秒まで許す）。
// 失敗の種別（reason）は内部用。HTTP の応答には出さない（auth.ts）。
import { createPublicKey, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';

export const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';
const MAX_TOKEN_BYTES = 8 * 1024;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_INTERVAL_MS = 60 * 1000;
const JWKS_TIMEOUT_MS = 5000;
const CLOCK_SKEW_SEC = 60;
const B64URL = /^[A-Za-z0-9_-]+$/;

export type AccessVerifyResult =
  | { ok: true; email: string | null; commonName: string | null }
  | { ok: false; reason: string; unavailable?: boolean };

export type AccessVerifier = { verify(token: string): Promise<AccessVerifyResult> };

export type AccessVerifierOptions = {
  teamDomain: string;
  aud: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

type Json = Record<string, unknown>;

function decodeJson(part: string): Json | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

function fail(reason: string, unavailable = false): AccessVerifyResult {
  return unavailable ? { ok: false, reason, unavailable: true } : { ok: false, reason };
}

export function createAccessVerifier(opts: AccessVerifierOptions): AccessVerifier {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const iss = `https://${opts.teamDomain}`;
  const certsUrl = `${iss}/cdn-cgi/access/certs`;

  let keys = new Map<string, KeyObject>();
  let fetchedAt = -Infinity; // 最後に取得に成功した時刻（ms）
  let attemptedAt = -Infinity; // 最後に取得を試みた時刻（ms）
  let inflight: Promise<void> | null = null;

  async function load(): Promise<void> {
    const res = await doFetch(certsUrl, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`jwks status ${res.status}`);
    const body: unknown = await res.json();
    const list = body !== null && typeof body === 'object' ? (body as Json).keys : undefined;
    if (!Array.isArray(list)) throw new Error('jwks without keys');
    const next = new Map<string, KeyObject>();
    for (const jwk of list) {
      if (jwk === null || typeof jwk !== 'object') continue;
      const { kty, kid } = jwk as Json;
      if (kty !== 'RSA' || typeof kid !== 'string') continue;
      try {
        next.set(kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }));
      } catch {
        // 取り込めない鍵は使わない
      }
    }
    if (next.size === 0) throw new Error('jwks without usable keys');
    keys = next;
    fetchedAt = now().getTime();
  }

  // 取得は同時に 1 本だけ。並行のリクエストは同じ Promise を待つ。失敗は呼び出し側で握りつぶす（キャッシュを使う）。
  function refresh(): Promise<void> {
    if (inflight === null) {
      attemptedAt = now().getTime();
      inflight = load().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  async function keyFor(kid: string): Promise<KeyObject | 'kid' | 'unavailable'> {
    const t = now().getTime();
    const fresh = keys.has(kid) && t - fetchedAt < JWKS_TTL_MS;
    if (!fresh && (inflight !== null || t - attemptedAt >= JWKS_MIN_INTERVAL_MS)) {
      try {
        await refresh();
      } catch {
        // キャッシュに残っている鍵を使う
      }
    }
    const key = keys.get(kid);
    if (key !== undefined) return key;
    return keys.size === 0 ? 'unavailable' : 'kid';
  }

  async function verify(token: string): Promise<AccessVerifyResult> {
    if (typeof token !== 'string') return fail('malformed');
    if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return fail('too_large');
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return fail('malformed');
    const [h, p, s] = parts;
    const header = decodeJson(h);
    const payload = decodeJson(p);
    if (header === null || payload === null) return fail('malformed');
    if (header.alg !== 'RS256') return fail('alg');
    if (typeof header.kid !== 'string') return fail('kid');

    const key = await keyFor(header.kid);
    if (key === 'unavailable') return fail('jwks_unavailable', true);
    if (key === 'kid') return fail('kid');

    let valid = false;
    try {
      valid = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`, 'ascii'), key, Buffer.from(s, 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) return fail('signature');

    if (payload.iss !== iss) return fail('iss');
    const aud = payload.aud;
    const auds = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
    if (!auds.includes(opts.aud)) return fail('aud');
    const sec = now().getTime() / 1000;
    if (typeof payload.exp !== 'number' || !(payload.exp > sec - CLOCK_SKEW_SEC)) return fail('exp');
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !(payload.nbf <= sec + CLOCK_SKEW_SEC))) return fail('nbf');

    return {
      ok: true,
      email: typeof payload.email === 'string' && payload.email !== '' ? payload.email : null,
      commonName: typeof payload.common_name === 'string' && payload.common_name !== '' ? payload.common_name : null,
    };
  }

  return { verify };
}
