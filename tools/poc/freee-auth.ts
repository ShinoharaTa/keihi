// T0-2' freee の認可（docs/freee-codex.md §3.1 手作業 5）。ブラウザの無い本機向け。
// 認可 URL（prompt=select_company、redirect_uri=urn:ietf:wg:oauth:2.0:oob）を表示し、
// ユーザーがスマホのブラウザで事業所を選んで許可 → 画面に出た認可コードを標準入力に貼る → トークンを 0600 で保存する。
// ローカルでリダイレクトを受けるサーバーは立てない。
//
//   node tools/poc/freee-auth.ts           # テスト事業所（freee-token-poc.json）
//   node tools/poc/freee-auth.ts --prod    # 本番事業所（freee-token-prod.json。F15 の読み取り用）
//
// - 応答の company_id が config.toml の poc_company_id と違えば保存しない（未設定なら保存して、設定する値を表示する）。
// - --prod では、応答の company_id が poc_company_id と同じなら保存しない。prod_company_id が設定済みで違っても保存しない。
// - 認可コード・トークン・client_secret は表示しない。
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { TokenStore, buildAuthorizeUrl, exchangeCode } from '../../src/providers/freee/auth.ts';
import { DEFAULT_CONFIG_DIR, createRedactor, loadFreeeConfig, loadFreeeCredentials, tokenFile, type Target } from './freee-poc.ts';

export type AuthDeps = {
  fetch?: typeof fetch;
  log?: (s: string) => void;
  error?: (s: string) => void;
  readCode?: (prompt: string) => Promise<string>;
};

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export async function main(argv: string[], deps: AuthDeps = {}): Promise<number> {
  const redactor = createRedactor();
  const log = (s: string) => (deps.log ?? ((x: string) => console.log(x)))(redactor.apply(s));
  const error = (s: string) => (deps.error ?? ((x: string) => console.error(x)))(redactor.apply(s));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        prod: { type: 'boolean', default: false },
        'config-dir': { type: 'string', default: DEFAULT_CONFIG_DIR },
      },
    }));
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const target: Target = values.prod ? 'prod' : 'poc';
  const configDir = values['config-dir'];
  try {
    const config = await loadFreeeConfig(configDir);
    const creds = await loadFreeeCredentials(configDir);
    redactor.add(creds.clientSecret);
    log(`対象: ${target === 'prod' ? '本番事業所（読み取りだけに使う）' : 'テスト事業所'}`);
    log('次の URL をスマホのブラウザで開き、事業所を選んで許可する:');
    log(buildAuthorizeUrl(creds.clientId));
    const code = (await (deps.readCode ?? readLine)('画面に表示された認可コードを貼り付けて Enter: ')).trim();
    if (!code) throw new Error('認可コードが空');
    redactor.add(code);
    const token = await exchangeCode(creds, code, { fetch: deps.fetch });
    redactor.add(token.access_token);
    redactor.add(token.refresh_token);
    const cid = token.company_id;
    if (cid === null) throw new Error('応答に company_id が無い（prompt=select_company で事業所を選んだか確かめる）。保存しない');
    if (target === 'poc' && config.pocCompanyId !== null && cid !== config.pocCompanyId) {
      throw new Error(`選んだ事業所（${cid}）が poc_company_id（${config.pocCompanyId}）と違う。保存しない`);
    }
    if (target === 'prod' && cid === config.pocCompanyId) throw new Error(`選んだ事業所（${cid}）はテスト事業所。--prod では保存しない`);
    if (target === 'prod' && config.prodCompanyId !== null && cid !== config.prodCompanyId) {
      throw new Error(`選んだ事業所（${cid}）が prod_company_id（${config.prodCompanyId}）と違う。保存しない`);
    }
    const store = new TokenStore(tokenFile(configDir, target));
    await store.withLock(() => store.write(token));
    log(`保存した: ${store.path}（0600）。company_id=${cid} expires_in=${token.expires_in}`);
    const key = target === 'prod' ? 'prod_company_id' : 'poc_company_id';
    if ((target === 'prod' ? config.prodCompanyId : config.pocCompanyId) === null) {
      log(`${path.join(configDir, 'config.toml')} の [freee] に ${key} = ${cid} を書く`);
    }
    return 0;
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
