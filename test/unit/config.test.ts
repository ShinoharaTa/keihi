// 設定とシークレット（docs/mvp-plan.md T1-2）。一時ディレクトリだけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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

function dir2(toml: string): string {
  const d = path.join(root, String(n++));
  mkdirSync(d);
  writeFileSync(path.join(d, 'config.toml'), toml);
  return d;
}

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
    assert.deepEqual(cfg.deadline, { countFrom: 'receipt_day' });
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
    const d6 = await dir('[deadline]\ncount_from = "first"\n', null);
    assert.throws(() => loadConfig({ configDir: d6 }), /count_from/);
    const d5 = await dir('[other]\nx = 1\n', null);
    assert.throws(() => loadConfig({ configDir: d5 }), /知らないセクション/);
  });
});

describe('worker の配線（[freee] target / day_boundary、[provider] kind、[gemini] thinking_level / media_resolution）', () => {
  test('既定は poc / jst / freee / low / medium', async () => {
    const cfg = loadConfig({ configDir: await dir(null, null) });
    assert.deepEqual(cfg.freee, { pocCompanyId: null, prodCompanyId: null, target: 'poc', dayBoundary: 'jst' });
    assert.deepEqual(cfg.provider, { kind: 'freee' });
    assert.equal(cfg.gemini.thinkingLevel, 'low');
    assert.equal(cfg.gemini.mediaResolution, 'medium');
  });
  test('指定を読む', async () => {
    const cfg = loadConfig({
      configDir: await dir('[freee]\ntarget = "prod"\nday_boundary = "jst"\n[provider]\nkind = "fake"\n[gemini]\nthinking_level = "medium"\nmedia_resolution = "high"\n', null),
    });
    assert.equal(cfg.freee.target, 'prod');
    assert.equal(cfg.provider.kind, 'fake');
    assert.equal(cfg.gemini.thinkingLevel, 'medium');
    assert.equal(cfg.gemini.mediaResolution, 'high');
  });
  test('知らない値は拒否', async () => {
    for (const toml of ['[freee]\ntarget = "production"\n', '[freee]\nday_boundary = "utc"\n', '[provider]\nkind = "mf"\n', '[gemini]\nthinking_level = "max"\n']) {
      assert.throws(() => loadConfig({ configDir: dir2(toml) }), ConfigError, toml);
    }
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

describe('[worker]', () => {
  test('linger_ms の既定は 1500（0 も可）、reauth_wait_days の既定は 7。負・0 日・知らないキーは拒否', () => {
    assert.deepEqual(loadConfig({ configDir: dir2(''), dataDir: '/data/keihi' }).worker, { lingerMs: 1500, reauthWaitDays: 7 });
    assert.deepEqual(loadConfig({ configDir: dir2('[worker]\nlinger_ms = 0\nreauth_wait_days = 3\n'), dataDir: '/data/keihi' }).worker, { lingerMs: 0, reauthWaitDays: 3 });
    for (const bad of ['[worker]\nlinger_ms = -1', '[worker]\nreauth_wait_days = 0', '[worker]\nlinger = 1']) assert.throws(() => loadConfig({ configDir: dir2(bad), dataDir: '/data/keihi' }), ConfigError, bad);
  });
});

describe('[reconcile]', () => {
  test('verified_lookback_days の既定は 35、max_list_pages の既定は 20。0・知らないキーは拒否', () => {
    assert.deepEqual(loadConfig({ configDir: dir2(''), dataDir: '/data/keihi' }).reconcile, { verifiedLookbackDays: 35, maxListPages: 20 });
    assert.deepEqual(loadConfig({ configDir: dir2('[reconcile]\nverified_lookback_days = 60\nmax_list_pages = 5\n'), dataDir: '/data/keihi' }).reconcile, { verifiedLookbackDays: 60, maxListPages: 5 });
    for (const bad of ['[reconcile]\nverified_lookback_days = 0', '[reconcile]\nmax_list_pages = 0', '[reconcile]\nmax_pages = 1']) assert.throws(() => loadConfig({ configDir: dir2(bad), dataDir: '/data/keihi' }), ConfigError, bad);
  });
});

describe('[bank]', () => {
  test('既定は backfill_from = 2025-01-01、dedup 0 日、振替・照合 3 日。指定を読み、不正な値・知らないキーは拒否', () => {
    assert.deepEqual(loadConfig({ configDir: dir2(''), dataDir: '/data/keihi' }).bank, {
      backfillFrom: '2025-01-01', dedupDateWindowDays: 0, transferWindowDays: 3, matchDateWindowDays: 3,
    });
    assert.deepEqual(
      loadConfig({
        configDir: dir2('[bank]\nbackfill_from = "2024-02-29"\ndedup_date_window_days = 1\ntransfer_window_days = 0\nmatch_date_window_days = 5\n'),
        dataDir: '/data/keihi',
      }).bank,
      { backfillFrom: '2024-02-29', dedupDateWindowDays: 1, transferWindowDays: 0, matchDateWindowDays: 5 },
    );
    for (const bad of [
      '[bank]\nbackfill_from = "2025-1-1"',
      '[bank]\nbackfill_from = "2025-02-30"',
      '[bank]\nbackfill_from = 2025-01-01',
      '[bank]\nbackfill_from = ""',
      '[bank]\ndedup_date_window_days = -1',
      '[bank]\ntransfer_window_days = 1.5',
      '[bank]\nmatch_date_window_days = "3"',
      '[bank]\nbackfill = "2025-01-01"',
    ]) assert.throws(() => loadConfig({ configDir: dir2(bad), dataDir: '/data/keihi' }), ConfigError, bad);
  });
});

describe('[backup] / [retention]', () => {
  test('既定値（drill_dir は <data_dir>/drill）', () => {
    const c = loadConfig({ configDir: dir2(''), dataDir: '/data/keihi' });
    assert.deepEqual(c.backup, { repository: null, keepSnapshots: 7, checkIntervalDays: 7, readDataSubset: '5%', drillDir: '/data/keihi/drill', remoteVerifyMode: 'download_only' });
    assert.deepEqual(c.retention, { years: 7, extraYears: 1, start: 'next_year_0316' });
  });

  test('指定を読む', () => {
    const c = loadConfig({
      configDir: dir2(`[backup]\nrepository = "b2:x:y"\nkeep_snapshots = 3\ncheck_interval_days = 14\nread_data_subset = "10%"\ndrill_dir = "/tmp/d"\nremote_verify_mode = "sha256"\n[retention]\nyears = 5\nextra_years = 0\nstart = "next_year_0316"\n`),
    });
    assert.deepEqual(c.backup, { repository: 'b2:x:y', keepSnapshots: 3, checkIntervalDays: 14, readDataSubset: '10%', drillDir: '/tmp/d', remoteVerifyMode: 'sha256' });
    assert.deepEqual(c.retention, { years: 5, extraYears: 0, start: 'next_year_0316' });
  });

  test('知らないキー・不正な値は拒否', () => {
    for (const bad of [
      '[backup]\nkeep = 1',
      '[backup]\nremote_verify_mode = "full"',
      '[backup]\nread_data_subset = "5"',
      '[backup]\ndrill_dir = "rel"',
      '[retention]\nyears = 0',
      '[retention]\nextra_years = -1',
      '[retention]\nstart = "fiscal_year_end"',
      '[retention]\nkeep = 1',
    ]) {
      assert.throws(() => loadConfig({ configDir: dir2(bad) }), ConfigError, bad);
    }
  });
});
