// extract ジョブ（docs/mvp-plan.md T2-6、mvp-plan-v0.1.md T2-6、classification-ocr.md、a2ui-review-ui.md §3.3）。
// documents → 原本 → deriveForAi → Gemini → validate.ts → extractions / classifications / ai_turns → documents.status = needs_review。
// - no_ai（D12）の文書は Gemini を呼ばず、空の抽出を 1 行入れて needs_review にする（外部呼び出し 0 回）。
// - Gemini の呼び出しは成否にかかわらず ai_turns に 1 行（応答本文の原文、7 年保存。U6）。
// - 429・5xx・接続失敗は例外を投げてジョブの再試行に回す。スキーマ違反（JSON でない・検証の拒否）は 1 回だけ再要求し、
//   それでも駄目なら needs_attention（ai_schema_invalid）。その他の 4xx は needs_attention（ai_request_rejected）。
// - 辞書（vendor_rules）に当たれば classifications(source=rule) を gemini より先に書く（第 1 候補）。
// - 送る文脈は科目・税率の区分の一覧と辞書の集計だけ（画像は 1 回だけ送る）。
// - 行の形（他の担当と合わせたもの）:
//   extractions: 文書ごとに 1 行追加。tax_by_rate_json は [{category: '10'|'8r'|'exempt'|'na', amount_incl_tax, tax}]。
//     raw_json は検証済みの GeminiResponse 全体 + ai_turn_id。
//   classifications: source 'rule' | 'gemini'、candidates_json は [{account_id, tax_id（税率の区分）, confidence, reason?}] を確信度順。
// - Gemini の抽出が成功したら明細 ⇔ 証憑の照合を動かす（src/bank/match.ts の runMatchingSafe。失敗しても抽出は失敗にしない）。
import { appendAudit } from '../../audit.ts';
import { runMatchingSafe, type MatchWindows } from '../../bank/match.ts';
import { extractReceipt, GeminiError, type Gemini, type GenerateResult } from '../../ai/gemini/client.ts';
import { buildDictionaryContext, type DictionarySummary } from '../../ai/gemini/prompt.ts';
import { TAX_CATEGORIES, type GeminiResponse } from '../../ai/gemini/schema.ts';
import { validateGeminiResponse, type ValidationWarning } from '../../ai/validate.ts';
import { tx, type Db } from '../../db/index.ts';
import { ulid } from '../../db/ids.ts';
import type { Handler } from '../../jobs/worker.ts';
import { enabledAccounts, loadAccountMap, type EnabledAccount } from '../../masters/accounts.ts';
import type { TaxCategory } from '../../masters/tax-map.ts';
import { readObject, sha256Hex } from '../../storage/objects.ts';
import { lookupVendor, type VendorHit } from '../../vendors/dictionary.ts';
import { PROVIDER } from './uploadReceipt.ts';

export const REVIEW_STATUS = 'needs_review';
// スキーマ違反のときの呼び出しの回数（最初の 1 回 + 再要求 1 回）。
export const SCHEMA_TRIES = 2;

// tax_by_rate_json の区分の表記（確認カード・取引の担当と合わせた短い形）。
export const TAX_ROW_CODE: Record<TaxCategory, string> = {
  taxable_10: '10',
  taxable_8_reduced: '8r',
  non_taxable: 'exempt',
  out_of_scope: 'na',
};

export type ExtractDeps = {
  // no_ai の文書では呼ばない（Gemini の設定が無くても no_ai は通る）。
  gemini: () => Gemini;
  objectsDir: string;
  // Gemini に見せる科目。既定は enabled_accounts（対応表 + 同期済みの freee の勘定科目）。
  accounts?: (db: Db) => EnabledAccount[];
  // 照合の日付の幅（[bank]。省略時は既定値）。
  matchWindows?: MatchWindows;
};

export type Candidate = { account_id: string; tax_id: string | null; confidence: number | null; reason?: string };

type DocRow = { id: string; sha256: string; no_ai: number; status: string };

const EMPTY_RESPONSE: GeminiResponse = {
  extraction: { txn_date: null, amount_total: null, tax_by_rate: [], vendor_name: null, invoice_reg_no: null, payment_hint: null, description: null, confidence: 0 },
  account_candidates: [],
  questions: [],
};

function defaultAccounts(db: Db): EnabledAccount[] {
  return enabledAccounts(db, PROVIDER, loadAccountMap()).accounts;
}

function insertAiTurn(
  db: Db,
  documentId: string,
  g: Gemini,
  r: { modelVersion?: string | null; requestSha256: string | null; responseBody: string | null; tokensIn: number | null; tokensOut: number | null; latencyMs: number | null },
  now: Date,
): string {
  const id = ulid(now.getTime());
  const { seq } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ai_turns WHERE document_id = ?').get(documentId) as { seq: number };
  db.prepare(
    `INSERT INTO ai_turns (id, document_id, seq, role, model, model_ver, thinking_level, request_sha256, response_json, tokens_in, tokens_out, latency_ms, created_at)
     VALUES (?, ?, ?, 'ai', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, documentId, seq, g.model, r.modelVersion ?? null, g.thinkingLevel, r.requestSha256, r.responseBody, r.tokensIn, r.tokensOut, r.latencyMs, now.toISOString());
  return id;
}

function turnOfResult(r: GenerateResult) {
  return { modelVersion: r.modelVersion, requestSha256: r.requestSha256, responseBody: r.responseBody, tokensIn: r.usage.tokensIn, tokensOut: r.usage.tokensOut, latencyMs: r.latencyMs };
}

function turnOfError(e: GeminiError) {
  return { requestSha256: e.requestSha256, responseBody: e.responseBody, tokensIn: e.usage?.tokensIn ?? null, tokensOut: e.usage?.tokensOut ?? null, latencyMs: e.latencyMs };
}

// 辞書の集計（確定の件数の多い順。Gemini に見せる科目に当たるものだけ）。
function dictionarySummary(db: Db, accounts: readonly EnabledAccount[]): DictionarySummary[] {
  const ids = new Set(accounts.map((a) => a.id));
  const rows = db
    .prepare('SELECT vendor_norm, account_id, tax_id, hit_count FROM vendor_rules WHERE account_id IS NOT NULL ORDER BY hit_count DESC, vendor_norm LIMIT 50')
    .all() as { vendor_norm: string; account_id: string; tax_id: string | null; hit_count: number }[];
  return rows
    .filter((r) => ids.has(r.account_id))
    .slice(0, 5)
    .map((r) => ({ vendorNorm: r.vendor_norm, accountId: r.account_id, taxCategory: r.tax_id, hitCount: r.hit_count }));
}

const byConfidence = (a: Candidate, b: Candidate) => (b.confidence ?? 0) - (a.confidence ?? 0);

function ruleCandidate(hit: VendorHit, accounts: readonly EnabledAccount[]): Candidate | null {
  if (!hit.accountId || !accounts.some((a) => a.id === hit.accountId)) return null;
  const tax = hit.taxCategory !== null && (TAX_CATEGORIES as readonly string[]).includes(hit.taxCategory) ? hit.taxCategory : null;
  return { account_id: hit.accountId, tax_id: tax, confidence: hit.confidence, reason: hit.matchedBy === 'invoice_reg_no' ? '辞書（登録番号）' : '辞書（取引先名）' };
}

function setStatus(db: Db, doc: DocRow, to: string, reason: string | null, detail: Record<string, unknown>, now: Date): void {
  const cur = db.prepare('SELECT status FROM documents WHERE id = ?').get(doc.id) as { status: string };
  // 要対応は抽出で上書きしない（取り込み・アップロードの問題が先に立っていることがある）。
  if (cur.status === 'needs_attention' || cur.status === to) return;
  if (to === REVIEW_STATUS && cur.status !== 'received') return;
  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(to, doc.id);
  appendAudit(
    db,
    { actor: 'worker', action: to === 'needs_attention' ? 'document.needs_attention' : 'document.needs_review', entity: 'document', entityId: doc.id, payload: { from: cur.status, ...(reason ? { reason } : {}), ...detail } },
    now,
  );
}

function insertExtraction(db: Db, docId: string, engine: string, engineVer: string | null, v: GeminiResponse, aiTurnId: string | null, now: Date): string {
  const id = ulid(now.getTime());
  const ex = v.extraction;
  const rows = ex.tax_by_rate.map((r) => ({ category: TAX_ROW_CODE[r.category], amount_incl_tax: r.amount_incl_tax, tax: r.tax }));
  db.prepare(
    `INSERT INTO extractions (id, document_id, engine, engine_ver, raw_json, txn_date, amount_total, tax_by_rate_json, vendor_name, invoice_reg_no, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, docId, engine, engineVer, JSON.stringify({ ...v, ai_turn_id: aiTurnId }), ex.txn_date, ex.amount_total, JSON.stringify(rows), ex.vendor_name, ex.invoice_reg_no, ex.confidence, now.toISOString());
  return id;
}

function insertClassification(db: Db, extractionId: string, source: 'rule' | 'gemini', modelVer: string | null, candidates: Candidate[], now: Date): string {
  const id = ulid(now.getTime());
  db.prepare('INSERT INTO classifications (id, extraction_id, source, model_ver, candidates_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    extractionId,
    source,
    modelVer,
    JSON.stringify([...candidates].sort(byConfidence)),
    now.toISOString(),
  );
  return id;
}

export function createExtractHandler(getDeps: () => ExtractDeps): Handler {
  return async (job, ctx) => {
    const { db } = ctx;
    const now = ctx.now();
    if (!job.ref_id) throw new Error('extract に document_id が無い');
    const doc = db.prepare('SELECT id, sha256, no_ai, status FROM documents WHERE id = ?').get(job.ref_id) as DocRow | undefined;
    if (!doc) throw new Error(`document ${job.ref_id} が無い`);
    if (db.prepare('SELECT 1 FROM extractions WHERE document_id = ? LIMIT 1').get(doc.id)) return; // 済み（ジョブの重複）
    const deps = getDeps();

    if (doc.no_ai === 1) {
      tx(db, () => {
        const extractionId = insertExtraction(db, doc.id, 'none', null, EMPTY_RESPONSE, null, now);
        appendAudit(db, { actor: 'worker', action: 'document.extracted', entity: 'document', entityId: doc.id, payload: { extraction_id: extractionId, engine: 'none', no_ai: true } }, now);
        setStatus(db, doc, REVIEW_STATUS, null, { no_ai: true }, now);
      });
      return;
    }

    const isLastAttempt = job.attempts + 1 >= job.max_attempts;
    try {
      const accounts = (deps.accounts ?? defaultAccounts)(db);
      if (accounts.length === 0) throw new Error('Gemini に見せる科目が 0 件（freee のマスタ同期と対応表を確かめる）');
      const original = await readObject(deps.objectsDir, doc.sha256);
      if (sha256Hex(original) !== doc.sha256) throw new Error(`原本の sha256 が記録と一致しない（${doc.id}）。送らない`);
      const gemini = deps.gemini();
      const context = buildDictionaryContext(dictionarySummary(db, accounts));

      let accepted: { value: GeminiResponse; warnings: ValidationWarning[]; turnId: string; modelVersion: string | null } | null = null;
      const rejected: { ai_turn_id: string; errors: string[] }[] = [];
      for (let i = 0; i < SCHEMA_TRIES && !accepted; i++) {
        let r: GenerateResult;
        try {
          r = await extractReceipt(gemini, { original, accounts, context });
        } catch (e) {
          if (!(e instanceof GeminiError)) throw e;
          const turnId = insertAiTurn(db, doc.id, gemini, turnOfError(e), now);
          if (e.retryable) throw e;
          if (e.malformed) {
            rejected.push({ ai_turn_id: turnId, errors: [`${e.code}: ${e.message}`] });
            continue;
          }
          tx(db, () => setStatus(db, doc, 'needs_attention', 'ai_request_rejected', { ai_turn_id: turnId, status: e.status }, now));
          return;
        }
        const turnId = insertAiTurn(db, doc.id, gemini, turnOfResult(r), now);
        const v = validateGeminiResponse(r.json, { accounts });
        if (v.ok) accepted = { value: v.value, warnings: v.warnings, turnId, modelVersion: r.modelVersion };
        else rejected.push({ ai_turn_id: turnId, errors: v.errors.slice(0, 20) });
      }
      if (!accepted) {
        tx(db, () => setStatus(db, doc, 'needs_attention', 'ai_schema_invalid', { rejected }, now));
        return;
      }

      const a = accepted;
      const ex = a.value.extraction;
      const hit = lookupVendor(db, { name: ex.vendor_name, invoiceRegNo: ex.invoice_reg_no });
      const rule = hit ? ruleCandidate(hit, accounts) : null;
      tx(db, () => {
        const extractionId = insertExtraction(db, doc.id, 'gemini', a.modelVersion, a.value, a.turnId, now);
        // 辞書を第 1 候補にする（rule の行を先に書く。id は同じミリ秒では順序を持たないので、読む側は source = 'rule' を優先する）。
        const ruleId = rule ? insertClassification(db, extractionId, 'rule', null, [rule], now) : null;
        const aiCandidates: Candidate[] = a.value.account_candidates.map((c) => ({ account_id: c.account_id, tax_id: c.tax_id, confidence: c.confidence, reason: c.reason }));
        const geminiId = insertClassification(db, extractionId, 'gemini', a.modelVersion, aiCandidates, now);
        appendAudit(
          db,
          {
            actor: 'worker',
            action: 'document.extracted',
            entity: 'document',
            entityId: doc.id,
            payload: {
              extraction_id: extractionId,
              engine: 'gemini',
              ai_turn_id: a.turnId,
              classification_ids: ruleId ? [ruleId, geminiId] : [geminiId],
              dictionary: hit ? { vendor_norm: hit.vendorNorm, matched_by: hit.matchedBy, used: rule !== null } : null,
              warnings: a.warnings,
              rejected_before: rejected.length,
            },
          },
          now,
        );
        setStatus(db, doc, REVIEW_STATUS, null, { extraction_id: extractionId }, now);
      });
      runMatchingSafe(db, now, { windows: deps.matchWindows });
    } catch (e) {
      if (isLastAttempt) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
        tx(db, () => setStatus(db, doc, 'needs_attention', 'extract_retries_exhausted', { error: msg }, now));
      }
      throw e;
    }
  };
}
