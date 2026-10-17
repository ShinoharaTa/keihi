// keihi の CLI（docs/mvp-plan.md T1-10）。
//
//   node src/cli/keihi.ts freee auth [--company <id>] [--config-dir <dir>] [--data-dir <dir>]
//
// freee auth: 初回の認可と、invalid_grant の後の再認可。ブラウザの無い本機向けに oob（urn:ietf:wg:oauth:2.0:oob）を使う。
// 認可 URL（prompt=select_company）を表示 → スマホのブラウザで事業所を選んで許可 → 画面に出た認可コードを標準入力に貼る
// → <data_dir>/freee-token.json に 0600 で保存（<data_dir>/freee-token.lock で排他）→ settings.freee_reauth_required を 0 に戻す。
// - 対象の事業所は --company（config.toml の poc_company_id か prod_company_id のどちらか）。省略時は prod_company_id。
//   応答の company_id が対象と違えば保存しない。
// - 認可コード・トークン・client_secret は表示しない。ディレクトリは作らない（data_dir が無ければ止める）。
// - DB（keihi.db）があれば、トークンエンドポイントの呼び出しを予算（auth）に通して freee_calls に記録する。
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.ts';
import { openDb, type Db } from '../db/index.ts';
import { TOKEN_URL, TokenStore, buildAuthorizeUrl, exchangeCode } from '../providers/freee/auth.ts';
import { budgetedFetch, createBudget } from '../providers/freee/budget.ts';
import { freeeTokenPaths } from '../providers/freee/provider.ts';
import { setReauthRequired } from '../providers/freee/state.ts';

export type CliDeps = {
  fetch?: typeof fetch;
  log?: (s: string) => void;
  error?: (s: string) => void;
  readCode?: (prompt: string) => Promise<string>;
};

const USAGE = '使い方: node src/cli/keihi.ts freee auth [--company <id>] [--config-dir <dir>] [--data-dir <dir>]';

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function hasSettingsTable(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
}

async function freeeAuth(argv: string[], deps: CliDeps): Promise<number> {
  const secrets: string[] = [];
  const redact = (s: string) => secrets.reduce((acc, v) => (v ? acc.split(v).join('***') : acc), s);
  const log = (s: string) => (deps.log ?? ((x: string) => console.log(x)))(redact(s));
  const error = (s: string) => (deps.error ?? ((x: string) => console.error(x)))(redact(s));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { company: { type: 'string' }, 'config-dir': { type: 'string' }, 'data-dir': { type: 'string' } },
    }));
  } catch (e) {
    error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  let db: Db | null = null;
  try {
    const cfg = loadConfig({ configDir: values['config-dir'], dataDir: values['data-dir'] });
    const clientId = cfg.secrets.freeeClientId;
    const clientSecret = cfg.secrets.freeeClientSecret;
    if (!clientId || !clientSecret) throw new ConfigError(`${cfg.configDir}/secrets.env に FREEE_CLIENT_ID / FREEE_CLIENT_SECRET が無い`);
    secrets.push(clientSecret);
    const configured = [cfg.freee.pocCompanyId, cfg.freee.prodCompanyId].filter((x): x is number => x !== null);
    let company: number;
    if (values.company !== undefined) {
      if (!/^[1-9]\d*$/.test(values.company)) throw new ConfigError('--company は正の整数');
      company = Number(values.company);
      if (!configured.includes(company)) {
        throw new ConfigError(`--company ${company} は config.toml の [freee] poc_company_id / prod_company_id のどちらでもない`);
      }
    } else {
      if (cfg.freee.prodCompanyId === null) throw new ConfigError('config.toml に [freee] prod_company_id が無い（または --company で指定する）');
      company = cfg.freee.prodCompanyId;
    }
    if (!existsSync(cfg.dataDir)) throw new ConfigError(`${cfg.dataDir} が無い（作らない）`);
    if (existsSync(cfg.dbPath)) {
      db = openDb(cfg.dbPath);
      if (!hasSettingsTable(db)) {
        db.close();
        db = null;
      }
    }

    const baseFetch = deps.fetch ?? fetch;
    const doFetch = db ? budgetedFetch(createBudget({ db }), 'auth', new URL(TOKEN_URL).pathname, baseFetch) : baseFetch;

    log(`対象の事業所: ${company}`);
    log('次の URL をスマホのブラウザで開き、事業所を選んで許可する:');
    log(buildAuthorizeUrl(clientId));
    const code = (await (deps.readCode ?? readLine)('画面に表示された認可コードを貼り付けて Enter: ')).trim();
    if (!code) throw new Error('認可コードが空');
    secrets.push(code);
    const token = await exchangeCode({ clientId, clientSecret }, code, { fetch: doFetch });
    secrets.push(token.access_token, token.refresh_token);
    if (token.company_id === null) throw new Error('応答に company_id が無い（prompt=select_company で事業所を選んだか確かめる）。保存しない');
    if (token.company_id !== company) throw new Error(`選んだ事業所（${token.company_id}）が対象（${company}）と違う。保存しない`);
    const { tokenPath, lockPath } = freeeTokenPaths(cfg.dataDir);
    const store = new TokenStore(tokenPath, lockPath);
    await store.withLock(() => store.write(token));
    if (db) setReauthRequired(db, false);
    log(`保存した: ${store.path}（0600）。company_id=${token.company_id} expires_in=${token.expires_in}`);
    if (!db) log(`${cfg.dbPath} が無い（またはマイグレーション前）ので、freee_reauth_required は更新していない`);
    return 0;
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    db?.close();
  }
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const [group, cmd, ...rest] = argv;
  if (group === 'freee' && cmd === 'auth') return freeeAuth(rest, deps);
  (deps.error ?? ((x: string) => console.error(x)))(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
