// freee API の日次予算（docs/mvp-plan.md T1-15、docs/mcp.md §5.3）。
// - 上限は 1 日 3,000 回（事業所とアプリごと）[FR-OA]。用途（upload / sync / execute / auth / user）ごとに配分する。
//   upload（即アップロードと検索項目の更新 = 法定の処理）は 600 回の予約枠を持ち、他の用途はその枠に食い込めない。
// - 残りが 500 を切ったら sync を止め、200 を切ったら upload と auth（トークンの更新）だけにする。
// - 呼び出しの前に begin() で確かめて freee_calls に 1 行入れ（確認と記録を 1 トランザクションで行い、web と worker の
//   同時実行でも枠を超えない）、応答の後に finish() でステータスと X-Freee-Request-ID を書く。
// - 403（使用制限）を受けたら settings.freee_paused_until を 10 分後にし、その間は全用途を呼ばない。
// - 日の区切りは JST の暦日（F16 が分かるまで）。resetHourJst で区切りの時刻をずらせる。
import { todayInTokyo } from '../../calendar/businessDays.ts';
import { tx, type Db } from '../../db/index.ts';
import { ProviderError, type Provider } from '../types.ts';
import { getPausedUntil, setPausedUntil } from './state.ts';

export type Purpose = 'upload' | 'sync' | 'execute' | 'auth' | 'user';
export const PURPOSES: readonly Purpose[] = ['upload', 'sync', 'execute', 'auth', 'user'];

export const DAILY_LIMIT = 3000;
export const UPLOAD_RESERVE = 600;
// 用途ごとの上限。null は日次の上限（と upload の予約枠）の範囲で制限なし。
export const PURPOSE_LIMITS: Record<Purpose, number | null> = { upload: null, sync: 300, execute: 600, auth: 50, user: null };
export const STOP_SYNC_BELOW = 500;
export const LEGAL_ONLY_BELOW = 200;
export const PAUSE_MS = 10 * 60 * 1000;

export type Used = Record<Purpose, number>;

export type DenyReason =
  | 'daily_limit' // 日次の上限に達した
  | 'purpose_limit' // 用途ごとの上限に達した
  | 'sync_stopped' // 残りが STOP_SYNC_BELOW を切った
  | 'legal_only' // 残りが LEGAL_ONLY_BELOW を切った（upload と auth だけ）
  | 'upload_reserve'; // upload の予約枠に食い込む

export type Decision = { ok: true } | { ok: false; reason: DenyReason };

export type BudgetLimits = {
  daily: number;
  uploadReserve: number;
  perPurpose: Record<Purpose, number | null>;
  stopSyncBelow: number;
  legalOnlyBelow: number;
};

export const DEFAULT_LIMITS: BudgetLimits = {
  daily: DAILY_LIMIT,
  uploadReserve: UPLOAD_RESERVE,
  perPurpose: PURPOSE_LIMITS,
  stopSyncBelow: STOP_SYNC_BELOW,
  legalOnlyBelow: LEGAL_ONLY_BELOW,
};

// 次の 1 回を呼んでよいか（純関数）。used はその日の用途ごとの回数。
export function decide(purpose: Purpose, used: Used, limits: BudgetLimits = DEFAULT_LIMITS): Decision {
  const total = PURPOSES.reduce((s, p) => s + used[p], 0);
  const remaining = limits.daily - total;
  if (remaining <= 0) return { ok: false, reason: 'daily_limit' };
  const cap = limits.perPurpose[purpose];
  if (cap !== null && used[purpose] >= cap) return { ok: false, reason: 'purpose_limit' };
  // 法定の処理は残りがある限り通す。トークンの更新はそれを支えるので同じ扱い（用途の上限だけ見る）。
  if (purpose === 'upload' || purpose === 'auth') return { ok: true };
  if (remaining < limits.legalOnlyBelow) return { ok: false, reason: 'legal_only' };
  if (purpose === 'sync' && remaining < limits.stopSyncBelow) return { ok: false, reason: 'sync_stopped' };
  const reserveLeft = Math.max(0, limits.uploadReserve - used.upload);
  if (remaining - 1 < reserveLeft) return { ok: false, reason: 'upload_reserve' };
  return { ok: true };
}

// config.toml の [freee] day_boundary を resetHourJst に直す。今は "jst"（JST の 0 時）だけ（F16 が分かったら足す）。
export function resetHourJstFor(dayBoundary: 'jst'): number {
  if (dayBoundary === 'jst') return 0;
  throw new Error(`知らない day_boundary: ${String(dayBoundary)}`);
}

// 予算の日（JST の暦日。resetHourJst 時に切り替わる）。
export function budgetDay(now: Date, resetHourJst = 0): string {
  return todayInTokyo(new Date(now.getTime() - resetHourJst * 3600_000));
}

// 次に日が切り替わる時刻。
export function nextReset(now: Date, resetHourJst = 0): Date {
  const [y, m, d] = budgetDay(now, resetHourJst).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, resetHourJst - 9));
}

// 予算が足りないので呼ばなかった。呼び出し側は retryAt 以降に延期する。
export class BudgetExceededError extends Error {
  readonly purpose: Purpose;
  readonly reason: DenyReason;
  readonly retryAt: Date;
  constructor(purpose: Purpose, reason: DenyReason, retryAt: Date) {
    super(`freee の API 予算が足りないので ${purpose} を延期する（${reason}、${retryAt.toISOString()} 以降）`);
    this.name = 'BudgetExceededError';
    this.purpose = purpose;
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

export type Usage = { day: string; used: Used; remaining: number; pausedUntil: Date | null };

export type Budget = {
  // 呼んでよければ freee_calls に 1 行入れてその id を返す。だめなら BudgetExceededError か、
  // 停止中なら ProviderError('usage_limited') を投げる（どちらも freee は呼ばない）。
  begin(purpose: Purpose, method: string, endpoint: string): number;
  // 応答のステータス（応答が無ければ null）と request_id を書く。403 なら全用途を PAUSE_MS 止める。
  finish(callId: number, status: number | null, requestId: string | null): void;
  usage(): Usage;
};

export type BudgetOptions = { db: Db; now?: () => Date; resetHourJst?: number; limits?: BudgetLimits };

export function createBudget(opts: BudgetOptions): Budget {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const resetHourJst = opts.resetHourJst ?? 0;
  if (!Number.isInteger(resetHourJst) || resetHourJst < 0 || resetHourJst > 23) throw new Error('resetHourJst は 0〜23 の整数');
  const limits = opts.limits ?? DEFAULT_LIMITS;

  function usedOn(day: string): Used {
    const used: Used = { upload: 0, sync: 0, execute: 0, auth: 0, user: 0 };
    const rows = db.prepare('SELECT purpose, COUNT(*) AS n FROM freee_calls WHERE called_on = ? GROUP BY purpose').all(day) as { purpose: Purpose; n: number }[];
    for (const r of rows) used[r.purpose] = r.n;
    return used;
  }

  return {
    begin(purpose, method, endpoint) {
      if (!PURPOSES.includes(purpose)) throw new Error(`知らない用途: ${String(purpose)}`);
      return tx(db, () => {
        const at = now();
        const paused = getPausedUntil(db);
        if (paused && paused.getTime() > at.getTime()) {
          throw new ProviderError('usage_limited', `freee の使用制限（403）で ${paused.toISOString()} まで呼び出しを止めている`);
        }
        const day = budgetDay(at, resetHourJst);
        const d = decide(purpose, usedOn(day), limits);
        if (!d.ok) throw new BudgetExceededError(purpose, d.reason, nextReset(at, resetHourJst));
        const r = db
          .prepare('INSERT INTO freee_calls (called_on, called_at, purpose, method, endpoint) VALUES (?, ?, ?, ?, ?)')
          .run(day, at.toISOString(), purpose, method, endpoint);
        return Number(r.lastInsertRowid);
      });
    },

    finish(callId, status, requestId) {
      tx(db, () => {
        db.prepare('UPDATE freee_calls SET status = ?, request_id = ? WHERE id = ?').run(status, requestId, callId);
        if (status === 403) setPausedUntil(db, new Date(now().getTime() + PAUSE_MS), now());
      });
    },

    usage() {
      const at = now();
      const day = budgetDay(at, resetHourJst);
      const used = usedOn(day);
      const paused = getPausedUntil(db);
      return {
        day,
        used,
        remaining: limits.daily - PURPOSES.reduce((s, p) => s + used[p], 0),
        pausedUntil: paused && paused.getTime() > at.getTime() ? paused : null,
      };
    },
  };
}

// Provider のメソッドごとの既定の用途。
export type ProviderMethod = Exclude<keyof Provider, 'capabilities' | 'reconcileTxn' | 'ignoreTxn'>;
export const DEFAULT_PURPOSES: Record<ProviderMethod, Purpose> = {
  uploadReceipt: 'upload',
  updateReceiptMeta: 'upload',
  findReceiptsByKey: 'upload',
  downloadReceipt: 'user',
  createExpenseDeal: 'execute',
  attachReceipts: 'execute',
  getDeal: 'execute',
  listDeals: 'sync',
  deleteDeal: 'execute',
  syncMasters: 'sync',
  listBankTxns: 'sync',
  listRules: 'sync',
  createRule: 'execute',
  deleteRule: 'execute',
};

// 予算を自分で持たない Provider（fake）を、メソッド単位で予算に通す。endpoint はメソッド名。
// freee の Provider は HTTP の 1 回ごとに予算に通すので、これで包まない（二重に数える）。
export function withBudget<P extends Provider>(provider: P, budget: Budget, purposes: Record<ProviderMethod, Purpose> = DEFAULT_PURPOSES): P {
  const wrapped = Object.create(provider) as P;
  for (const name of Object.keys(purposes) as ProviderMethod[]) {
    const fn = provider[name] as (...args: unknown[]) => Promise<unknown>;
    (wrapped as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const id = budget.begin(purposes[name], 'CALL', name);
      try {
        const out = await fn.apply(provider, args);
        budget.finish(id, 200, null);
        return out;
      } catch (e) {
        budget.finish(id, e instanceof ProviderError ? e.status : null, e instanceof ProviderError ? e.requestId : null);
        throw e;
      }
    };
  }
  return wrapped;
}

// fetch を包み、1 回ごとに予算に通す（トークンエンドポイントの呼び出しを用途 auth で数えるのに使う）。
export function budgetedFetch(budget: Budget, purpose: Purpose, endpoint: string, inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const id = budget.begin(purpose, (init?.method ?? 'GET').toUpperCase(), endpoint);
    let res: Response;
    try {
      res = await inner(input, init);
    } catch (e) {
      budget.finish(id, null, null);
      throw e;
    }
    budget.finish(id, res.status, res.headers.get('x-freee-request-id'));
    return res;
  }) as typeof fetch;
}
