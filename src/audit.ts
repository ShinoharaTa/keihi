// 監査ログのハッシュチェーン（docs/mvp-plan-v0.1.md T1-4、architecture.md §3.4、R15）。
// hash = sha256(prev_hash || canonical_json({seq, ts, actor, action, entity, entity_id, payload_json}))。先頭の prev_hash は 0 が 64 個。
// audit_log はトリガで UPDATE / DELETE を拒否している（0001_init.sql）。ここは改ざんの検出を受け持つ。
//
//   node src/audit.ts verify [--db /path/to.db]   # 壊れていれば最初の seq を表示して終了コード 1
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { openDb, tx, type Db } from './db/index.ts';

export const GENESIS_HASH = '0'.repeat(64);

export type AuditInput = {
  actor: string;
  action: string;
  entity: string;
  entityId?: string | null;
  payload?: unknown;
};

// キーを辞書順に並べた空白なしの JSON。undefined のキーは落とす。
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('有限でない数は監査ログに入れられない');
    if (typeof v === 'bigint') return v.toString();
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

type Row = {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  payload_json: string;
  prev_hash: string;
  hash: string;
};

export function rowHash(prevHash: string, r: Omit<Row, 'prev_hash' | 'hash'>): string {
  const body = canonicalJson({ seq: r.seq, ts: r.ts, actor: r.actor, action: r.action, entity: r.entity, entity_id: r.entity_id, payload_json: r.payload_json });
  return createHash('sha256').update(prevHash).update(body).digest('hex');
}

// 1 行追加する。呼び出し側のトランザクションの中で呼べば、その操作と同時に確定する。
export function appendAudit(db: Db, input: AuditInput, now: Date = new Date()): { seq: number; hash: string } {
  return tx(db, () => {
    const last = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
    const r = {
      seq: (last?.seq ?? 0) + 1,
      ts: now.toISOString(),
      actor: input.actor,
      action: input.action,
      entity: input.entity,
      entity_id: input.entityId ?? null,
      payload_json: canonicalJson(input.payload ?? {}),
    };
    const prev = last?.hash ?? GENESIS_HASH;
    const hash = rowHash(prev, r);
    db.prepare(
      'INSERT INTO audit_log (seq, ts, actor, action, entity, entity_id, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(r.seq, r.ts, r.actor, r.action, r.entity, r.entity_id, r.payload_json, prev, hash);
    return { seq: r.seq, hash };
  });
}

export type VerifyResult = { ok: true; count: number; lastHash: string } | { ok: false; seq: number; reason: string };

// 先頭から順に検証し、最初に壊れている seq を返す。
export function verifyAudit(db: Db): VerifyResult {
  let prev = GENESIS_HASH;
  let expected = 1;
  for (const r of db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate() as Iterable<Row>) {
    if (r.seq !== expected) return { ok: false, seq: expected, reason: `seq ${expected} が欠けている` };
    if (r.prev_hash !== prev) return { ok: false, seq: r.seq, reason: 'prev_hash が直前の行の hash と一致しない' };
    if (rowHash(prev, r) !== r.hash) return { ok: false, seq: r.seq, reason: 'hash が内容と一致しない' };
    prev = r.hash;
    expected++;
  }
  return { ok: true, count: expected - 1, lastHash: prev };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { db: { type: 'string' } } });
  if (positionals[0] !== 'verify') {
    console.error('使い方: node src/audit.ts verify [--db /path/to.db]');
    process.exit(2);
  }
  let file = values.db;
  if (!file) {
    const { loadConfig } = await import('./config.ts');
    file = loadConfig().dbPath;
  }
  const db = openDb(file);
  try {
    const r = verifyAudit(db);
    if (r.ok) console.log(`audit verify: ok（${r.count} 行）`);
    else {
      console.error(`audit verify: seq ${r.seq} で失敗: ${r.reason}`);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}
