// 設定とシークレット（docs/mvp-plan.md T1-2）。一時ディレクトリだけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigError, DEFAULT_MAX_UPLOAD_BYTES, dumpConfig, loadConfig, requireFreee, requireGemini } from '../../src/config.ts';

const GEMINI_KEY = 'AIzaTEST-not-a-real-key-0123456789';
const CLIENT_ID = 'client-id-TEST-123456';
const CLIENT_SECRET = 'client-secret-TEST-abcdef';

let root: string;
let n = 0;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'keihi-config-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function dir(toml: string | null, env: string | null, mode = 0o600): Promise<string> {
  const d = path.join(root, String(n++));
  await mkdir(d);
  if (toml !== null) await writeFile(path.join(d, 'config.toml'), toml);
  if (env !== null) {
    await writeFile(path.join(d, 'secrets.env'), env);
    await chmod(path.join(d, 'secrets.env'), mode);
  }
  return d;
}

const POC_TOML = `
[gemini]
paid_tier_confirmed = true # コメント
[freee]
poc_company_id = 123
`;
const ENV = `# secrets\nGEMINI_API_KEY=${GEMINI_KEY}\nexport FREEE_CLIENT_ID="${CLIENT_ID}"\nFREEE_CLIENT_SECRET='${CLIENT_SECRET}'\n`;

describe('loadConfig', () => {
  test('PoC と同じ形式を読む', async () => {
    const cfg = loadConfig({ configDir: await dir(POC_TOML, ENV), dataDir: '/nonexistent/keihi' });
    assert.equal(cfg.gemini.paidTierConfirmed, true);
    assert.equal(cfg.gemini.model, 'gemini-3.8-flash');
    assert.equal(cfg.freee.pocCompanyId, 123);
    assert.equal(cfg.freee.prodCompanyId, null);
    assert.equal(cfg.secrets.geminiApiKey, GEMINI_KEY);
    assert.equal(cfg.secrets.freeeClientId, CLIENT_ID);
    assert.equal(cfg.secrets.freeeClientSecret, CLIENT_SECRET);
    assert.equal(cfg.dbPath, '/nonexistent/keihi/keihi.db');
    assert.equal(cfg.freeeTokenPath, '/nonexistent/keihi/freee-token.json');
  });

  test('ファイルが無ければ既定値（安全側）', async () => {
    const cfg = loadConfig({ configDir: await dir(null, null) });
    assert.equal(cfg.gemini.paidTierConfirmed, false);
    assert.equal(cfg.ingest.maxBytes, DEFAULT_MAX_UPLOAD_BYTES);
    assert.deepEqual(cfg.calendar, { deadlineMode: 'early', yearEndHolidays: false });
    assert.equal(cfg.secrets.geminiApiKey, null);
  });

  for (const mode of [0o644, 0o640, 0o400, 0o700]) {
    test(`secrets.env が 0${mode.toString(8)} なら拒否`, async () => {
      const d = await dir(POC_TOML, ENV, mode);
      assert.throws(() => loadConfig({ configDir: d }), (e: Error) => e instanceof ConfigError && /0600 ではない/.test(e.message) && !e.message.includes(GEMINI_KEY));
    });
  }

  test('知らないキー・型違いは拒否', async () => {
    const d1 = await dir('[gemini]\npaid_tier_confirm = true\n', null);
    assert.throws(() => loadConfig({ configDir: d1 }), /知らないキー/);
    const d2 = await dir('[gemini]\npaid_tier_confirmed = "yes"\n', null);
    assert.throws(() => loadConfig({ configDir: d2 }), /true \/ false/);
    const d3 = await dir('[freee]\npoc_company_id = -1\n', null);
    assert.throws(() => loadConfig({ configDir: d3 }), /正の整数/);
    const d4 = await dir('[calendar]\ndeadline_mode = "2m"\n', null);
    assert.throws(() => loadConfig({ configDir: d4 }), /deadline_mode/);
    const d5 = await dir('[other]\nx = 1\n', null);
    assert.throws(() => loadConfig({ configDir: d5 }), /知らないセクション/);
  });
});

describe('require*', () => {
  test('paid_tier_confirmed が無ければ Gemini は起動時エラー', async () => {
    const cfg = loadConfig({ configDir: await dir('[freee]\npoc_company_id = 1\n', ENV) });
    assert.throws(() => requireGemini(cfg), /paid_tier_confirmed/);
  });
  test('GEMINI_API_KEY が無ければエラー', async () => {
    const cfg = loadConfig({ configDir: await dir(POC_TOML, '') });
    assert.throws(() => requireGemini(cfg), /GEMINI_API_KEY/);
  });
  test('揃っていれば返す', async () => {
    const cfg = loadConfig({ configDir: await dir(POC_TOML, ENV) });
    assert.deepEqual(requireGemini(cfg), { model: 'gemini-3.8-flash', apiKey: GEMINI_KEY });
    assert.deepEqual(requireFreee(cfg, 'poc'), { companyId: 123, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });
  test('対象の company_id が無ければ freee は起動時エラー', async () => {
    const cfg = loadConfig({ configDir: await dir(POC_TOML, ENV) });
    assert.throws(() => requireFreee(cfg, 'prod'), /prod_company_id/);
    const cfg2 = loadConfig({ configDir: await dir('', ENV) });
    assert.throws(() => requireFreee(cfg2, 'poc'), /poc_company_id/);
  });
  test('client_secret が無ければ freee は起動時エラー', async () => {
    const cfg = loadConfig({ configDir: await dir(POC_TOML, `FREEE_CLIENT_ID=${CLIENT_ID}\n`) });
    assert.throws(() => requireFreee(cfg, 'poc'), /FREEE_CLIENT_SECRET/);
  });
});

test('dumpConfig はシークレットを *** にする', async () => {
  const cfg = loadConfig({ configDir: await dir(POC_TOML, ENV) });
  const s = dumpConfig(cfg);
  for (const v of [GEMINI_KEY, CLIENT_ID, CLIENT_SECRET]) assert.ok(!s.includes(v));
  const o = JSON.parse(s);
  assert.deepEqual(o.secrets, { geminiApiKey: '***', freeeClientId: '***', freeeClientSecret: '***' });
  assert.equal(o.freee.pocCompanyId, 123);
});
