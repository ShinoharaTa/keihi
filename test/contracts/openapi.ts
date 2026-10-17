// 固定した freee の OpenAPI（freee-openapi.json）で、送ったリクエストを検査する小さな検証器（契約テスト用）。
// - 扱う JSON Schema は freee の定義で使われている範囲だけ: type / nullable / required / properties / items / enum /
//   minimum / maximum / minLength / maxLength / pattern / format: binary / $ref。
// - 送る側の検査なので厳しめにする: 定義に無いプロパティ・クエリは誤り（additionalProperties を許さない）。
// - multipart・クエリ・form-urlencoded は値が文字列なので、integer / boolean は文字列の形で確かめる。
import { readFileSync } from 'node:fs';

type Schema = Record<string, unknown>;
type Operation = { parameters?: Schema[]; requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> } };
type Contract = {
  servers: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
  'x-keihi-token-endpoint': { url: string; method: string; contentType: string; schemas: Record<string, Schema> };
};

export const CONTRACT = JSON.parse(readFileSync(new URL('./freee-openapi.json', import.meta.url), 'utf8')) as Contract;

export type SentRequest = { method: string; url: URL; headers: Headers; body: unknown };

function deref(s: Schema): Schema {
  let cur = s;
  while (typeof cur.$ref === 'string') {
    const name = cur.$ref.replace('#/components/schemas/', '');
    const next = CONTRACT.components.schemas[name];
    if (!next) throw new Error(`定義に無い $ref: ${cur.$ref}`);
    cur = next;
  }
  return cur;
}

// stringly = multipart・クエリ・form の値（文字列で来る）。
export function validate(schema0: Schema, v: unknown, at: string, stringly = false): string[] {
  const s = deref(schema0);
  const errs: string[] = [];
  if (v === null) return s.nullable ? [] : [`${at}: null は許されない`];
  const type = s.type as string | undefined;
  if (s.format === 'binary') return v instanceof Blob ? [] : [`${at}: バイナリ（Blob）でない`];
  if (type === 'object' || (!type && s.properties)) {
    if (typeof v !== 'object' || Array.isArray(v)) return [`${at}: object でない`];
    const o = v as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const k of (s.required ?? []) as string[]) if (o[k] === undefined) errs.push(`${at}.${k}: 必須なのに無い`);
    for (const [k, x] of Object.entries(o)) {
      if (x === undefined) continue;
      if (!props[k]) errs.push(`${at}.${k}: 定義に無いプロパティ`);
      else errs.push(...validate(props[k], x, `${at}.${k}`, stringly));
    }
    return errs;
  }
  if (type === 'array') {
    if (!Array.isArray(v)) return [`${at}: array でない`];
    v.forEach((x, i) => errs.push(...validate(s.items as Schema, x, `${at}[${i}]`, stringly)));
    return errs;
  }
  let val: unknown = v;
  if (type === 'integer' || type === 'number') {
    if (stringly && typeof v === 'string') {
      if (!(type === 'integer' ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/).test(v)) return [`${at}: 数の形でない: ${v}`];
      val = Number(v);
    }
    if (typeof val !== 'number' || !Number.isFinite(val)) return [`${at}: ${type} でない`];
    if (type === 'integer' && !Number.isInteger(val)) return [`${at}: 整数でない`];
    if (typeof s.minimum === 'number' && val < s.minimum) errs.push(`${at}: ${s.minimum} 未満`);
    if (typeof s.maximum === 'number' && val > s.maximum) errs.push(`${at}: ${s.maximum} 超`);
  } else if (type === 'boolean') {
    if (stringly && (v === 'true' || v === 'false')) val = v === 'true';
    if (typeof val !== 'boolean') return [`${at}: boolean でない`];
  } else if (type === 'string') {
    if (typeof v !== 'string') return [`${at}: string でない`];
    if (typeof s.minLength === 'number' && v.length < s.minLength) errs.push(`${at}: ${s.minLength} 文字未満`);
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) errs.push(`${at}: ${s.maxLength} 文字超`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) errs.push(`${at}: pattern ${s.pattern} に合わない`);
  }
  if (Array.isArray(s.enum) && !s.enum.includes(val)) errs.push(`${at}: enum ${JSON.stringify(s.enum)} に無い: ${JSON.stringify(val)}`);
  return errs;
}

export function findOperation(method: string, pathname: string): { template: string; op: Operation; params: Record<string, string> } | null {
  for (const [template, ops] of Object.entries(CONTRACT.paths)) {
    const names: string[] = [];
    const re = new RegExp(`^${template.replace(/\{(\w+)\}/g, (_m, n: string) => (names.push(n), '([^/]+)'))}$`);
    const m = re.exec(pathname);
    const op = ops[method.toLowerCase()];
    if (m && op) return { template, op, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

function formToObject(f: FormData | URLSearchParams): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of f.entries()) {
    if (k in o) throw new Error(`同じ名前のフィールドが 2 回: ${k}`);
    o[k] = v;
  }
  return o;
}

// 送ったリクエスト 1 件の誤りを返す（空なら定義どおり）。
export function checkRequest(r: SentRequest): string[] {
  const tok = CONTRACT['x-keihi-token-endpoint'];
  const label = `${r.method} ${r.url.pathname}`;
  if (`${r.url.origin}${r.url.pathname}` === tok.url) {
    if (r.method.toLowerCase() !== tok.method) return [`${label}: トークンエンドポイントは POST だけ`];
    if (!(r.body instanceof URLSearchParams)) return [`${label}: form-urlencoded でない`];
    const body = formToObject(r.body);
    const schema = tok.schemas[String(body.grant_type)];
    if (!schema) return [`${label}: 知らない grant_type`];
    return validate(schema, body, `${label} body`, true);
  }
  if (!CONTRACT.servers.some((s) => s.url === r.url.origin)) return [`${label}: 定義に無いサーバー ${r.url.origin}`];
  const found = findOperation(r.method, r.url.pathname);
  if (!found) return [`${label}: 定義に無い操作`];
  const errs: string[] = [];
  const params = (found.op.parameters ?? []).map(deref);
  const query = Object.fromEntries(r.url.searchParams.entries());
  for (const p of params) {
    const name = p.name as string;
    const v = p.in === 'query' ? query[name] : p.in === 'path' ? found.params[name] : undefined;
    if (v === undefined) {
      if (p.required) errs.push(`${label}: ${p.in} の ${name} が必須なのに無い`);
      continue;
    }
    errs.push(...validate(p.schema as Schema, v, `${label} ${p.in}.${name}`, true));
  }
  for (const k of r.url.searchParams.keys()) {
    if (!params.some((p) => p.in === 'query' && p.name === k)) errs.push(`${label}: 定義に無いクエリ ${k}`);
  }
  const content = found.op.requestBody?.content;
  if (r.body === undefined || r.body === null) {
    if (found.op.requestBody?.required) errs.push(`${label}: 本文が必須なのに無い`);
    return errs;
  }
  if (!content) return [...errs, `${label}: 本文を送らない操作に本文がある`];
  if (r.body instanceof FormData) {
    const c = content['multipart/form-data'];
    if (!c) return [...errs, `${label}: multipart を受け付けない`];
    errs.push(...validate(c.schema, formToObject(r.body), `${label} body`, true));
  } else if (typeof r.body === 'string') {
    const c = content['application/json'];
    if (!c) return [...errs, `${label}: JSON を受け付けない`];
    if (!(r.headers.get('content-type') ?? '').startsWith('application/json')) errs.push(`${label}: content-type が application/json でない`);
    errs.push(...validate(c.schema, JSON.parse(r.body), `${label} body`));
  } else {
    errs.push(`${label}: 想定外の本文の型`);
  }
  return errs;
}
