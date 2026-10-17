// freee の OAuth（認可コード）の最小実装（docs/freee-codex.md §3.1・§3.2 F1/F2、§5.1 T1-10）。
// - リダイレクト URI は PoC では urn:ietf:wg:oauth:2.0:oob（認可コードを画面に表示させ、ユーザーが貼る）。
//   ローカルでリダイレクトを受けるサーバーは立てない。
// - アクセストークンは 6 時間、リフレッシュトークンは 90 日・1 回限り [FR-AUTH]。
//   更新したら新しいリフレッシュトークンを先に保存してから使う。更新はロックファイルでプロセスをまたいで排他にする。
// - トークン・client_secret・認可コードはログ・例外メッセージに出さない。保存先のファイルは 0600。
import { open, readFile, rename, rm, stat, writeFile, chmod } from 'node:fs/promises';

export const AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
export const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
export const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
// 期限の 5 分前から更新する。
export const REFRESH_MARGIN_SEC = 300;
// トークンエンドポイントのタイムアウト。ロックの待ち時間はこれより長くする（更新中の他プロセスを待ち切れるように）。
export const TOKEN_TIMEOUT_MS = 30_000;
export const LOCK_WAIT_MS = 45_000;

export type ClientCredentials = { clientId: string; clientSecret: string };

export type StoredToken = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  // freee の応答の created_at（epoch 秒）。無ければ取得した時刻。
  created_at: number;
  company_id: number | null;
  scope: string;
};

export class FreeeAuthError extends Error {
  readonly status: number | null;
  // OAuth のエラーコード（invalid_grant など）。本文の他の部分は持たない。
  readonly error: string | null;
  constructor(message: string, opts: { status?: number | null; error?: string | null } = {}) {
    super(message);
    this.name = 'FreeeAuthError';
    this.status = opts.status ?? null;
    this.error = opts.error ?? null;
  }
}

export function buildAuthorizeUrl(clientId: string, redirectUri = OOB_REDIRECT_URI): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // 事業所を選ばせ、そのトークンで扱える事業所を 1 つにする [FR-AUTH]。
    prompt: 'select_company',
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

export function expiresAt(t: StoredToken): number {
  return t.created_at + t.expires_in;
}

export function needsRefresh(t: StoredToken, nowSec: number): boolean {
  return nowSec >= expiresAt(t) - REFRESH_MARGIN_SEC;
}

function toStoredToken(raw: Record<string, unknown>, nowSec: number): StoredToken {
  const s = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  if (!s('access_token') || !s('refresh_token')) throw new FreeeAuthError('トークン応答に access_token / refresh_token が無い');
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : NaN;
  if (!Number.isFinite(expiresIn)) throw new FreeeAuthError('トークン応答に expires_in が無い');
  return {
    access_token: s('access_token'),
    refresh_token: s('refresh_token'),
    token_type: s('token_type') || 'bearer',
    expires_in: expiresIn,
    created_at: typeof raw.created_at === 'number' ? raw.created_at : nowSec,
    company_id: typeof raw.company_id === 'number' ? raw.company_id : null,
    scope: s('scope'),
  };
}

async function postToken(
  params: Record<string, string>,
  opts: { fetch?: typeof fetch; nowSec?: () => number; timeoutMs?: number },
): Promise<StoredToken> {
  const doFetch = opts.fetch ?? fetch;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const secrets = [params.client_secret, params.code, params.refresh_token].filter((v): v is string => !!v);
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
    throw new FreeeAuthError(redact(`freee のトークンエンドポイントへの接続に失敗: ${msg}`));
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
    throw new FreeeAuthError(redact(`freee トークン HTTP ${res.status}${error ? ` ${error}` : ''}`), { status: res.status, error });
  }
  return toStoredToken(body, nowSec());
}

export function exchangeCode(
  creds: ClientCredentials,
  code: string,
  opts: { fetch?: typeof fetch; nowSec?: () => number; redirectUri?: string } = {},
): Promise<StoredToken> {
  return postToken(
    {
      grant_type: 'authorization_code',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: opts.redirectUri ?? OOB_REDIRECT_URI,
    },
    opts,
  );
}

export function refreshWith(
  creds: ClientCredentials,
  refreshToken: string,
  opts: { fetch?: typeof fetch; nowSec?: () => number; redirectUri?: string } = {},
): Promise<StoredToken> {
  return postToken(
    {
      grant_type: 'refresh_token',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      redirect_uri: opts.redirectUri ?? OOB_REDIRECT_URI,
    },
    opts,
  );
}

// ---- 保存（0600）とロック ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// シグナル 0 で存在だけ確かめる。EPERM は他ユーザーのプロセスが居るということなので生きている扱い。
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class TokenStore {
  readonly path: string;
  readonly lockPath: string;
  constructor(file: string) {
    this.path = file;
    this.lockPath = `${file}.lock`;
  }

  async read(): Promise<StoredToken | null> {
    let st;
    try {
      st = await stat(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    if (!st.isFile()) throw new Error(`${this.path} が通常のファイルではない`);
    const mode = st.mode & 0o777;
    if (mode !== 0o600) throw new Error(`${this.path} のパーミッションが 0600 ではない（現在 0${mode.toString(8)}）`);
    return JSON.parse(await readFile(this.path, 'utf8')) as StoredToken;
  }

  // 一時ファイルに 0600 で書いて rename する（途中で落ちても古い方か新しい方のどちらかが残る）。
  async write(t: StoredToken): Promise<void> {
    const tmp = `${this.path}.tmp-${process.pid}`;
    await rm(tmp, { force: true });
    await writeFile(tmp, JSON.stringify(t, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  // ロックファイルの保持者。読めない・中身が壊れていれば null。
  private async readHolder(): Promise<{ raw: string; pid: number | null; at: string | null } | null> {
    let raw: string;
    try {
      raw = await readFile(this.lockPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    try {
      const j = JSON.parse(raw) as { pid?: unknown; at?: unknown };
      const pid = typeof j.pid === 'number' && Number.isInteger(j.pid) && j.pid > 0 ? j.pid : null;
      return { raw, pid, at: typeof j.at === 'string' ? j.at : null };
    } catch {
      return { raw, pid: null, at: null };
    }
  }

  // O_EXCL のロックファイルで排他にする。中身は保持者の pid と取得時刻。
  // 保持者の pid が生きていなければ stale として消して取り直す。保持者が分からないロックは自動では消さない。
  async withLock<T>(fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
    const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
    let fh;
    for (;;) {
      try {
        fh = await open(this.lockPath, 'wx', 0o600);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const holder = await this.readHolder();
        if (holder === null) continue; // 読む間に消えた
        if (holder.pid !== null && !isAlive(holder.pid)) {
          // 読み直して同じ中身のときだけ消す（他のプロセスが先に回収して取り直したロックは消さない）。
          const again = await this.readHolder();
          if (again?.raw === holder.raw) await rm(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          if (holder.pid !== null) {
            throw new Error(`${this.lockPath} を pid ${holder.pid}（${holder.at ?? '時刻不明'}）が持っている。終わってから実行し直す`);
          }
          throw new Error(`${this.lockPath} が残っている（保持者が分からない）。他の更新が動いていないことを確かめてから消す`);
        }
        await sleep(100);
      }
    }
    try {
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
      } finally {
        await fh.close();
      }
      return await fn();
    } finally {
      await rm(this.lockPath, { force: true });
    }
  }
}

export type TokenProvider = {
  // 有効なアクセストークンを返す。force は 401 を受けたときの強制更新。
  get(opts?: { force?: boolean; rejected?: string }): Promise<string>;
};

export function createTokenProvider(opts: {
  store: TokenStore;
  creds: ClientCredentials;
  fetch?: typeof fetch;
  nowSec?: () => number;
}): TokenProvider {
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  // 読んだトークンを持っておき、期限が近いか強制更新のときだけファイルを読み直す。
  let cache: StoredToken | null = null;
  return {
    async get({ force = false, rejected } = {}) {
      if (!force && cache && !needsRefresh(cache, nowSec())) return cache.access_token;
      const prev = cache;
      const cur = await opts.store.read();
      if (!cur) throw new Error(`${opts.store.path} が無い。tools/poc/freee-auth.ts で認可する`);
      cache = cur;
      if (!force && !needsRefresh(cur, nowSec())) return cur.access_token;
      return opts.store.withLock(async () => {
        // ロックを取る間に他のプロセスが更新していれば、それを使う（リフレッシュトークンは 1 回限り）。
        const t = await opts.store.read();
        if (!t) throw new Error(`${opts.store.path} が無い`);
        const stillBad = force ? t.access_token === (rejected ?? prev?.access_token ?? cur.access_token) : needsRefresh(t, nowSec());
        if (!stillBad) {
          cache = t;
          return t.access_token;
        }
        const next = await refreshWith(opts.creds, t.refresh_token, { fetch: opts.fetch, nowSec });
        if (next.company_id === null) next.company_id = t.company_id;
        await opts.store.write(next);
        cache = next;
        return next.access_token;
      });
    },
  };
}
