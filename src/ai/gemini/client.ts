// Gemini のクライアント（docs/mvp-plan.md T2-3、mvp-plan-v0.1.md T2-3）。
// REST generateContent を fetch で直接呼ぶ。SDK は使わない。
// 画像は inline のみ（Files API・キャッシュ・Interactions API は使わない。classification-ocr.md B-2）。
// API キーは x-goog-api-key ヘッダでだけ送り、URL・ログ・例外メッセージ・保存する応答本文には出さない。
// - 設定（model・paid_tier_confirmed・thinking_level・media_resolution・max_output_tokens）は createGeminiFromConfig で読む。
// - generationConfig.maxOutputTokens（思考トークン込み）を必ず付け、出力が上限なしに伸びないようにする。
//   有料 tier の確認かキーが無ければ ConfigError（requireGemini）。
// - 領収書の抽出（extractReceipt）は、原本から deriveForAi で作った派生画像だけを送り（D13）、
//   応答は schema.ts の構造化出力（responseJsonSchema）で受ける。応答の検証は呼び出し側が validate.ts で行う。
// - generateContent に「保存しない（store: false）」相当のパラメータは無い（Interactions API の store は使わない）ので付けない。
import { createHash } from 'node:crypto';
import { requireGemini, type Config } from '../../config.ts';
import { deriveForAi } from './derive.ts';
import { buildPrompt, SYSTEM_INSTRUCTION } from './prompt.ts';
import { buildResponseSchema, type SchemaAccount } from './schema.ts';

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export type ThinkingLevel = 'low' | 'medium' | 'high';
export type MediaResolution = 'low' | 'medium' | 'high';

const MEDIA_RESOLUTION: Record<MediaResolution, string> = {
  low: 'MEDIA_RESOLUTION_LOW',
  medium: 'MEDIA_RESOLUTION_MEDIUM',
  high: 'MEDIA_RESOLUTION_HIGH',
};

export type GenerateInput = {
  model: string;
  systemInstruction: string;
  prompt: string;
  // 画像・PDF（領収書）。テキストだけの呼び出し（メールの手がかり。src/mail/hints.ts）では省き、mediaResolution も送らない。
  inline?: { mimeType: string; data: Uint8Array };
  responseJsonSchema: unknown;
  thinkingLevel: ThinkingLevel;
  mediaResolution: MediaResolution;
  maxOutputTokens: number;
};

export type Usage = { tokensIn: number; tokensOut: number; tokensThoughts: number };

export type GenerateResult = {
  json: unknown;
  rawText: string;
  // HTTP の応答本文そのまま（キーは *** に置き換える）。ai_turns.response_json に保存する（U6）。
  responseBody: string;
  // 送ったリクエスト本文の sha256（ai_turns.request_sha256）。
  requestSha256: string;
  usage: Usage;
  latencyMs: number;
  modelVersion: string | null;
};

export class GeminiError extends Error {
  readonly code: 'http' | 'network' | 'invalid_json' | 'empty';
  readonly status: number | null;
  readonly usage: Usage | null;
  readonly latencyMs: number;
  readonly responseBody: string | null;
  readonly requestSha256: string | null;
  constructor(
    code: GeminiError['code'],
    message: string,
    opts: { status?: number | null; usage?: Usage | null; latencyMs: number; responseBody?: string | null; requestSha256?: string | null },
  ) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.status = opts.status ?? null;
    this.usage = opts.usage ?? null;
    this.latencyMs = opts.latencyMs;
    this.responseBody = opts.responseBody ?? null;
    this.requestSha256 = opts.requestSha256 ?? null;
  }

  // 時間を置けば通りうる失敗（429・5xx・接続できない）。ジョブの再試行に回す。
  get retryable(): boolean {
    return this.code === 'network' || (this.code === 'http' && this.status !== null && (this.status === 429 || this.status >= 500));
  }

  // 応答は来たが構造化出力として読めない（スキーマ違反と同じ扱い）。
  get malformed(): boolean {
    return this.code === 'invalid_json' || this.code === 'empty';
  }
}

const MODEL_ID = /^[a-z0-9][a-z0-9.\-]*$/;

export function generateContentUrl(baseUrl: string, model: string): string {
  if (!MODEL_ID.test(model)) throw new Error(`不正なモデル ID: ${JSON.stringify(model)}`);
  return `${baseUrl}/models/${model}:generateContent`;
}

export function buildGenerateContentBody(input: GenerateInput): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: input.systemInstruction }] },
    contents: [
      {
        role: 'user',
        parts: [
          ...(input.inline ? [{ inlineData: { mimeType: input.inline.mimeType, data: Buffer.from(input.inline.data).toString('base64') } }] : []),
          { text: input.prompt },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: input.responseJsonSchema,
      thinkingConfig: { thinkingLevel: input.thinkingLevel },
      ...(input.inline ? { mediaResolution: MEDIA_RESOLUTION[input.mediaResolution] } : {}),
      maxOutputTokens: input.maxOutputTokens,
    },
  };
}

type RawResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
};

function usageOf(r: RawResponse): Usage {
  const u = r.usageMetadata ?? {};
  const thoughts = u.thoughtsTokenCount ?? 0;
  // 出力の課金は思考トークンを含む（a2ui-review-ui.md §1.4）。
  return { tokensIn: u.promptTokenCount ?? 0, tokensOut: (u.candidatesTokenCount ?? 0) + thoughts, tokensThoughts: thoughts };
}

export type GeminiClient = { generate(input: GenerateInput): Promise<GenerateResult> };

export function createGeminiClient(opts: {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): GeminiClient {
  const { apiKey } = opts;
  if (!apiKey) throw new Error('Gemini API キーが空');
  const doFetch = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  // 応答本文やエラー文にキーが紛れても外へ出さない。
  const redact = (s: string) => s.split(apiKey).join('***');

  return {
    async generate(input) {
      const url = generateContentUrl(baseUrl, input.model);
      const body = JSON.stringify(buildGenerateContentBody(input));
      const requestSha256 = createHash('sha256').update(body).digest('hex');
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        throw new GeminiError('network', redact(`Gemini への接続に失敗: ${msg}`), { latencyMs: elapsed(), requestSha256 });
      }
      const text = redact(await res.text());
      const latencyMs = elapsed();
      if (!res.ok) {
        throw new GeminiError('http', `Gemini HTTP ${res.status}: ${text.slice(0, 500)}`, {
          status: res.status,
          latencyMs,
          responseBody: text,
          requestSha256,
        });
      }
      let raw: RawResponse;
      try {
        raw = JSON.parse(text) as RawResponse;
      } catch {
        throw new GeminiError('invalid_json', 'Gemini の応答が JSON でない', { status: res.status, latencyMs, responseBody: text, requestSha256 });
      }
      const usage = usageOf(raw);
      const parts = raw.candidates?.[0]?.content?.parts ?? [];
      const rawText = parts
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      const meta = { status: res.status, usage, latencyMs, responseBody: text, requestSha256 };
      if (!rawText) throw new GeminiError('empty', 'Gemini の応答に本文が無い', meta);
      // スキーマ違反・不正 JSON は再試行せずエラー（classification-ocr.md 受け入れ条件）。
      let json: unknown;
      try {
        json = JSON.parse(rawText);
      } catch {
        throw new GeminiError('invalid_json', '構造化出力が JSON として読めない', meta);
      }
      return { json, rawText, responseBody: text, requestSha256, usage, latencyMs, modelVersion: raw.modelVersion ?? null };
    },
  };
}

// ---- 設定から作る / 領収書の抽出 ----

export type GeminiSettings = { model: string; thinkingLevel: ThinkingLevel; mediaResolution: MediaResolution; maxOutputTokens: number };
export type Gemini = GeminiSettings & { client: GeminiClient };

// 有料 tier の確認とキーが無ければ ConfigError（classification-ocr.md 受け入れ条件）。
export function createGeminiFromConfig(cfg: Config, opts: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number } = {}): Gemini {
  const g = requireGemini(cfg);
  return {
    model: g.model,
    thinkingLevel: cfg.gemini.thinkingLevel,
    mediaResolution: cfg.gemini.mediaResolution,
    maxOutputTokens: cfg.gemini.maxOutputTokens,
    client: createGeminiClient({ apiKey: g.apiKey, fetch: opts.fetch, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs }),
  };
}

export type ReceiptRequest = {
  // 原本のバイト列（そのままは送らない。deriveForAi の派生画像を送る）。
  original: Buffer;
  // Gemini に見せる科目（enabled_accounts）。応答スキーマの enum になる。
  accounts: readonly SchemaAccount[];
  // 呼び出しごとに足す文脈（辞書の集計など。prompt.ts）。
  context?: string;
};

export async function buildReceiptInput(req: ReceiptRequest, s: GeminiSettings): Promise<GenerateInput> {
  const d = await deriveForAi(req.original);
  const prompt = req.context ? `${buildPrompt(req.accounts)}\n${req.context}` : buildPrompt(req.accounts);
  return {
    model: s.model,
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt,
    inline: { mimeType: d.mime, data: d.bytes },
    responseJsonSchema: buildResponseSchema(req.accounts),
    thinkingLevel: s.thinkingLevel,
    mediaResolution: s.mediaResolution,
    maxOutputTokens: s.maxOutputTokens,
  };
}

export async function extractReceipt(g: Gemini, req: ReceiptRequest, override: Partial<GeminiSettings> = {}): Promise<GenerateResult> {
  return g.client.generate(await buildReceiptInput(req, { ...g, ...override }));
}
