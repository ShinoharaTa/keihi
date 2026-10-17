// マスタ同期（docs/mvp-plan.md T2-1）。Provider.syncMasters() の結果を provider_master_versions に追記する。
// - 同じ remote_id で内容（キーを並べ替えた JSON の sha256）が同じならスキップ、変わっていれば新しい版を追記する。
// - 前回あって今回無いものは retired_at を入れた版を追記する。再び現れたら retired_at が NULL の版を追記する。
// - partners は Masters の型にまだ無い（src/providers/types.ts）。返ってきたときだけ同期し、無ければ既存の版に触らない。
// - walletables は type と id の組を remote_id にする（`credit_card:1`）。別名は walletable_aliases に keihi 側で付ける。
import { createHash } from 'node:crypto';
import { canonicalJson } from '../audit.ts';
import { tx, type Db } from '../db/index.ts';
import type { Masters, Provider } from '../providers/types.ts';

export type MasterKind = 'account' | 'tax' | 'partner' | 'walletable';
export const MASTER_KINDS: readonly MasterKind[] = ['account', 'tax', 'partner', 'walletable'];

export type MasterItem = { remoteId: string; name: string; data: Record<string, unknown> };

export type MasterRow = {
  id: number;
  provider: string;
  kind: MasterKind;
  remoteId: string;
  name: string;
  data: Record<string, unknown>;
  fetchedAt: string;
  retiredAt: string | null;
};

export type KindResult = { added: number; changed: number; retired: number; unchanged: number };
export type SyncResult = Partial<Record<MasterKind, KindResult>>;

type Partner = { id: number; name: string };

// キーを並べ替えた JSON（内容の比較に使う）は監査ログと同じもの（src/audit.ts）。
// 旧実装との差は「配列の中の undefined（旧: 空、新: null）」と「有限でない数（旧: null、新: 例外）」だけで、
// freee の JSON から作るマスタには現れないので data_sha256 は変わらない（test/unit/masters.test.ts）。
export { canonicalJson };

// Masters を種類ごとの MasterItem に直す。partners が無ければその種類は含めない（同期しない）。
export function itemsFromMasters(m: Masters & { partners?: Partner[] }): Partial<Record<MasterKind, MasterItem[]>> {
  const out: Partial<Record<MasterKind, MasterItem[]>> = {
    account: m.accountItems.map((a) => ({ remoteId: String(a.id), name: a.name, data: { ...a } })),
    tax: m.taxCodes.map((t) => ({ remoteId: String(t.code), name: t.name, data: { ...t } })),
    walletable: m.walletables.map((w) => ({ remoteId: walletableRemoteId(w.type, w.id), name: w.name, data: { ...w } })),
  };
  if (Array.isArray(m.partners)) out.partner = m.partners.map((p) => ({ remoteId: String(p.id), name: p.name, data: { ...p } }));
  return out;
}

export function walletableRemoteId(type: string, id: number): string {
  return `${type}:${id}`;
}

type DbRow = {
  id: number;
  provider: string;
  kind: MasterKind;
  remote_id: string;
  name: string;
  data_json: string;
  data_sha256: string;
  fetched_at: string;
  retired_at: string | null;
};

const toRow = (r: DbRow): MasterRow => ({
  id: r.id,
  provider: r.provider,
  kind: r.kind,
  remoteId: r.remote_id,
  name: r.name,
  data: JSON.parse(r.data_json) as Record<string, unknown>,
  fetchedAt: r.fetched_at,
  retiredAt: r.retired_at,
});

// (provider, kind) の各 remote_id の最新の版（廃止の版も含む）。
function latestRows(db: Db, provider: string, kind: MasterKind): DbRow[] {
  return db
    .prepare(
      `SELECT v.* FROM provider_master_versions v
       JOIN (SELECT remote_id, MAX(id) AS id FROM provider_master_versions WHERE provider = ? AND kind = ? GROUP BY remote_id) l
         ON v.id = l.id
       ORDER BY v.remote_id`,
    )
    .all(provider, kind) as DbRow[];
}

// 現在有効なマスタ（最新の版が廃止でないもの）。remote_id の順。
export function currentMasters(db: Db, provider: string, kind: MasterKind): MasterRow[] {
  return latestRows(db, provider, kind).filter((r) => r.retired_at === null).map(toRow);
}

// 1 種類分を追記する。fetchedAt は今回の同期の時刻。
export function applyMasterItems(db: Db, provider: string, kind: MasterKind, items: MasterItem[], fetchedAt: string): KindResult {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.remoteId)) throw new Error(`マスタの remote_id が重複している: ${kind} ${it.remoteId}`);
    seen.add(it.remoteId);
  }
  const res: KindResult = { added: 0, changed: 0, retired: 0, unchanged: 0 };
  const insert = db.prepare(
    `INSERT INTO provider_master_versions (provider, kind, remote_id, name, data_json, data_sha256, fetched_at, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const latest = new Map(latestRows(db, provider, kind).map((r) => [r.remote_id, r]));
  for (const it of items) {
    const json = canonicalJson(it.data);
    const sha = createHash('sha256').update(json).digest('hex');
    const prev = latest.get(it.remoteId);
    if (prev && prev.retired_at === null && prev.data_sha256 === sha && prev.name === it.name) {
      res.unchanged++;
      continue;
    }
    insert.run(provider, kind, it.remoteId, it.name, json, sha, fetchedAt, null);
    if (prev && prev.retired_at === null) res.changed++;
    else res.added++;
  }
  for (const prev of latest.values()) {
    if (prev.retired_at !== null || seen.has(prev.remote_id)) continue;
    insert.run(provider, kind, prev.remote_id, prev.name, prev.data_json, prev.data_sha256, fetchedAt, fetchedAt);
    res.retired++;
  }
  return res;
}

// Provider からマスタを取得して保存する。全種類を 1 つのトランザクションで追記する。
export async function syncMasters(db: Db, provider: Provider, opts: { providerName: string; now?: () => Date }): Promise<SyncResult> {
  const masters = await provider.syncMasters();
  const fetchedAt = (opts.now ?? (() => new Date()))().toISOString();
  const byKind = itemsFromMasters(masters as Masters & { partners?: Partner[] });
  return tx(db, () => {
    const out: SyncResult = {};
    for (const kind of MASTER_KINDS) {
      const items = byKind[kind];
      if (items) out[kind] = applyMasterItems(db, opts.providerName, kind, items, fetchedAt);
    }
    return out;
  });
}

// ---- 口座・カードの別名 ----

export type WalletableWithAlias = MasterRow & { alias: string | null };

// alias が null なら別名を外す。存在しない（または廃止された）口座には付けない。
export function setWalletableAlias(db: Db, provider: string, remoteId: string, alias: string | null, now: Date = new Date()): void {
  if (alias === null) {
    db.prepare('DELETE FROM walletable_aliases WHERE provider = ? AND remote_id = ?').run(provider, remoteId);
    return;
  }
  const a = alias.trim();
  if (!a) throw new Error('別名が空');
  if (!currentMasters(db, provider, 'walletable').some((w) => w.remoteId === remoteId)) {
    throw new Error(`口座・カードが無い: ${remoteId}`);
  }
  db.prepare(
    `INSERT INTO walletable_aliases (provider, remote_id, alias, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (provider, remote_id) DO UPDATE SET alias = excluded.alias, updated_at = excluded.updated_at`,
  ).run(provider, remoteId, a, now.toISOString());
}

export function listWalletables(db: Db, provider: string): WalletableWithAlias[] {
  const aliases = new Map(
    (db.prepare('SELECT remote_id, alias FROM walletable_aliases WHERE provider = ?').all(provider) as { remote_id: string; alias: string }[]).map(
      (r) => [r.remote_id, r.alias],
    ),
  );
  return currentMasters(db, provider, 'walletable').map((w) => ({ ...w, alias: aliases.get(w.remoteId) ?? null }));
}
