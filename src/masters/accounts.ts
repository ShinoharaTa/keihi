// Gemini に見せる科目の絞り込み（docs/mvp-plan.md T2-1・T0-4、D11'）。
// 対応表は config/account-map.json（T0-4 で作る）。無ければ src/masters/default-account-map.json（仮の 24 件）。
// enum の値は freee の勘定科目 ID（文字列）、Gemini に見せる名前は同期済みのマスタの名前（K12）。
// 対応表の行は freee_account_item_id があれば ID で、無ければ freee_name の完全一致で同期済みのマスタを引く。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.ts';
import { currentMasters } from './sync.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ACCOUNT_MAP_PATH = path.join(HERE, '..', '..', 'config', 'account-map.json');
export const DEFAULT_ACCOUNT_MAP_PATH = path.join(HERE, 'default-account-map.json');

export type AccountMapEntry = {
  key: string; // keihi の候補名（A-5）
  freee_name: string;
  freee_account_item_id: number | null;
  private: boolean; // 事業主貸（私用）。税区分は対象外（transactions.md §5）
};
export type AccountMap = { version: 1; provisional: boolean; accounts: AccountMapEntry[] };

export type EnabledAccount = { id: string; name: string; key: string; private: boolean };

function fail(file: string, msg: string): never {
  throw new Error(`${file}: ${msg}`);
}

export function parseAccountMap(raw: unknown, file = 'account-map'): AccountMap {
  const o = raw as Record<string, unknown>;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) fail(file, 'オブジェクトではない');
  if (o.version !== 1) fail(file, 'version が 1 ではない');
  if (!Array.isArray(o.accounts) || o.accounts.length === 0) fail(file, 'accounts が空');
  const keys = new Set<string>();
  const accounts = o.accounts.map((a: unknown, i: number): AccountMapEntry => {
    const e = a as Record<string, unknown>;
    if (typeof e !== 'object' || e === null) fail(file, `accounts[${i}] がオブジェクトではない`);
    if (typeof e.key !== 'string' || !e.key) fail(file, `accounts[${i}].key が無い`);
    if (typeof e.freee_name !== 'string' || !e.freee_name) fail(file, `accounts[${i}].freee_name が無い`);
    const id = e.freee_account_item_id;
    if (id !== null && !(Number.isInteger(id) && (id as number) > 0)) fail(file, `accounts[${i}].freee_account_item_id が正の整数か null ではない`);
    if (typeof e.private !== 'boolean') fail(file, `accounts[${i}].private が真偽値ではない`);
    if (keys.has(e.key)) fail(file, `accounts[${i}].key が重複: ${e.key}`);
    keys.add(e.key);
    return { key: e.key, freee_name: e.freee_name, freee_account_item_id: id as number | null, private: e.private };
  });
  return { version: 1, provisional: o.provisional === true, accounts };
}

// file を指定しなければ config/account-map.json、それも無ければ仮の対応表。
export function loadAccountMap(file?: string): AccountMap {
  const f = file ?? (existsSync(ACCOUNT_MAP_PATH) ? ACCOUNT_MAP_PATH : DEFAULT_ACCOUNT_MAP_PATH);
  return parseAccountMap(JSON.parse(readFileSync(f, 'utf8')), f);
}

// 対応表の行を同期済みの勘定科目に当てる。当たらない行は missing に入れる（Gemini には見せない）。
// 同じ勘定科目に 2 行が当たったら対応表の誤りとしてエラーにする。
export function enabledAccounts(db: Db, provider: string, map: AccountMap): { accounts: EnabledAccount[]; missing: AccountMapEntry[] } {
  const masters = currentMasters(db, provider, 'account');
  const byId = new Map(masters.map((m) => [m.remoteId, m]));
  const byName = new Map<string, (typeof masters)[number][]>();
  for (const m of masters) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  const accounts: EnabledAccount[] = [];
  const missing: AccountMapEntry[] = [];
  const used = new Set<string>();
  for (const e of map.accounts) {
    let hit = e.freee_account_item_id !== null ? byId.get(String(e.freee_account_item_id)) : undefined;
    if (e.freee_account_item_id === null) {
      const c = byName.get(e.freee_name) ?? [];
      if (c.length > 1) throw new Error(`勘定科目の名前が重複していて引けない: ${e.freee_name}（ID で指定する）`);
      hit = c[0];
    }
    if (!hit) {
      missing.push(e);
      continue;
    }
    if (used.has(hit.remoteId)) throw new Error(`対応表の 2 行が同じ勘定科目 ${hit.remoteId} に当たっている: ${e.key}`);
    used.add(hit.remoteId);
    accounts.push({ id: hit.remoteId, name: hit.name, key: e.key, private: e.private });
  }
  return { accounts, missing };
}
