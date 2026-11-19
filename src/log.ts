// プロセスのログ（web・worker・daily・migrate の main。対話用の CLI は console のまま）。
// - LOG_FORMAT=text（既定）: 今までと同じ見た目。メッセージだけを 1 行（fields は出さない。fields.err が Error なら次の行に stack）。
// - LOG_FORMAT=json: 1 行 1 JSON（{"ts","level","service","env","msg",...fields}。fields.err は error・stack に展開）。
// - info・debug は stdout、warn・error は stderr。LOG_LEVEL（debug / info / warn / error、既定 info）より下は出さない。
// - マスキング（text・json の両方）: 秘密らしいキー名の値、addSecrets で登録した値、`Bearer <何か>`、JWT の形の文字列を *** にする。
export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;
export type Logger = {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
};

export type LoggerOptions = {
  service: string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => Date;
};

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY_RE = /secret|token|password|authorization|api[_-]?key|cookie|assertion/i;
const MAX_DEPTH = 4;
const MIN_SECRET_LENGTH = 8;

// addSecrets で登録した値（プロセス共通。長いものから置き換える）。
const secretValues = new Set<string>();
let secretList: string[] = [];

export function addSecrets(values: (string | null | undefined)[]): void {
  for (const v of values) if (typeof v === 'string' && v.length >= MIN_SECRET_LENGTH) secretValues.add(v);
  secretList = [...secretValues].sort((a, b) => b.length - a.length);
}

function maskText(s: string): string {
  let out = s;
  for (const v of secretList) if (out.includes(v)) out = out.split(v).join('***');
  // JWT の形（header.payload.signature、どれも base64url）は、登録していなくても隠す。
  return out.replace(/\bBearer\s+\S+/gi, 'Bearer ***').replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***');
}

function maskValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return maskText(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Error) return maskText(v.message);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(v)) return v.map((x) => maskValue(x, depth + 1));
  const out: Fields = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY_RE.test(k) ? '***' : maskValue(x, depth + 1);
  return out;
}

function levelOf(v: string | undefined): Level {
  return v !== undefined && Object.hasOwn(ORDER, v) ? (v as Level) : 'info';
}

type State = { service: string };

function make(state: State, opts: Required<Omit<LoggerOptions, 'service' | 'env'>> & { level: Level; format: 'text' | 'json'; appEnv: string }, base: Fields): Logger {
  const write = (level: Level, msg: string, fields?: Fields) => {
    if (ORDER[level] < ORDER[opts.level]) return;
    const sink = level === 'warn' || level === 'error' ? opts.err : opts.out;
    const all: Fields = { ...base, ...fields };
    const err = all.err instanceof Error ? all.err : null;
    if (opts.format === 'text') {
      sink(maskText(msg));
      if (err?.stack) sink(maskText(err.stack));
      return;
    }
    const rest: Fields = {};
    for (const [k, v] of Object.entries(all)) {
      if (k === 'err' && err) continue;
      rest[k] = SECRET_KEY_RE.test(k) ? '***' : maskValue(v, 0);
    }
    if (err) {
      rest.error = maskText(err.message);
      if (err.stack) rest.stack = maskText(err.stack);
    }
    const core = { ts: opts.now().toISOString(), level, service: state.service, env: opts.appEnv, msg: maskText(msg) };
    sink(JSON.stringify({ ...core, ...rest, ...core }));
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => make(state, opts, { ...base, ...fields }),
  };
}

function build(state: State, o: Omit<LoggerOptions, 'service'>): Logger {
  const env = o.env ?? process.env;
  return make(
    state,
    {
      out: o.out ?? ((line) => console.log(line)),
      err: o.err ?? ((line) => console.error(line)),
      now: o.now ?? (() => new Date()),
      level: levelOf(env.LOG_LEVEL),
      format: env.LOG_FORMAT === 'json' ? 'json' : 'text',
      appEnv: env.APP_ENV || 'development',
    },
    {},
  );
}

export function createLogger(opts: LoggerOptions): Logger {
  const env = opts.env ?? process.env;
  return build({ service: env.SERVICE_NAME || opts.service }, opts);
}

// プロセス共通のロガー（process.env から作る）。各 main が最初に setService を呼ぶ。
const globalState: State = { service: process.env.SERVICE_NAME || 'keihi' };
export const log: Logger = build(globalState, {});

// SERVICE_NAME があればそちらが優先。
export function setService(name: string): void {
  if (!process.env.SERVICE_NAME) globalState.service = name;
}

