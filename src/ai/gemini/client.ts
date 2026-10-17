// Gemini の最小クライアント（docs/mvp-plan.md T2-3）。
// REST generateContent を fetch で直接呼ぶ。SDK は使わない。
// 画像は inline のみ（Files API・キャッシュ・Interactions API は使わない。classification-ocr.md B-2）。
// API キーは x-goog-api-key ヘッダでだけ送り、URL・ログ・例外メッセージには出さない。

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
  inline: { mimeType: string; data: Uint8Array };
  responseJsonSchema: unknown;
  thinkingLevel: ThinkingLevel;
  mediaResolution: MediaResolution;
};

export type Usage = { tokensIn: number; tokensOut: number; tokensThoughts: number };

export type GenerateResult = {
  json: unknown;
  rawText: string;
  usage: Usage;
  latencyMs: number;
  modelVersion: string | null;
};

export class GeminiError extends Error {
  readonly code: 'http' | 'network' | 'invalid_json' | 'empty';
  readonly status: number | null;
  readonly usage: Usage | null;
  readonly latencyMs: number;
  constructor(
    code: GeminiError['code'],
    message: string,
    opts: { status?: number | null; usage?: Usage | null; latencyMs: number },
  ) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.status = opts.status ?? null;
    this.usage = opts.usage ?? null;
    this.latencyMs = opts.latencyMs;
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
          { inlineData: { mimeType: input.inline.mimeType, data: Buffer.from(input.inline.data).toString('base64') } },
          { text: input.prompt },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: input.responseJsonSchema,
      thinkingConfig: { thinkingLevel: input.thinkingLevel },
      mediaResolution: MEDIA_RESOLUTION[input.mediaResolution],
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
        throw new GeminiError('network', redact(`Gemini への接続に失敗: ${msg}`), { latencyMs: elapsed() });
      }
      const text = await res.text();
      const latencyMs = elapsed();
      if (!res.ok) {
        throw new GeminiError('http', redact(`Gemini HTTP ${res.status}: ${text.slice(0, 500)}`), {
          status: res.status,
          latencyMs,
        });
      }
      let raw: RawResponse;
      try {
        raw = JSON.parse(text) as RawResponse;
      } catch {
        throw new GeminiError('invalid_json', 'Gemini の応答が JSON でない', { status: res.status, latencyMs });
      }
      const usage = usageOf(raw);
      const parts = raw.candidates?.[0]?.content?.parts ?? [];
      const rawText = parts
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      if (!rawText) throw new GeminiError('empty', 'Gemini の応答に本文が無い', { status: res.status, usage, latencyMs });
      // スキーマ違反・不正 JSON は再試行せずエラー（classification-ocr.md 受け入れ条件）。
      let json: unknown;
      try {
        json = JSON.parse(rawText);
      } catch {
        throw new GeminiError('invalid_json', '構造化出力が JSON として読めない', { status: res.status, usage, latencyMs });
      }
      return { json, rawText, usage, latencyMs, modelVersion: raw.modelVersion ?? null };
    },
  };
}
