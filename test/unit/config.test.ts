// 設定とシークレット（docs/mvp-plan.md T1-2）。一時ディレクトリだけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigError, DEFAULT_MAX_UPLOAD_BYTES, dumpConfig, loadConfig, requireFreee, requireGemini, requireGmail } from '../../src/config.ts';

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
    const cfg = loadConfig({ env: {}, configDir: await dir(POC_TOML, ENV), dataDir: '/nonexistent/keihi' });
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
    const cfg = loadConfig({ env: {}, configDir: await dir(null, null) });
    assert.equal(cfg.gemini.paidTierConfirmed, false);
    assert.equal(cfg.ingest.maxBytes, DEFAULT_MAX_UPLOAD_BYTES);
    assert.deepEqual(cfg.calendar, { deadlineMode: 'early', yearEndHolidays: false });
    assert.deepEqual(cfg.deadline, { countFrom: 'receipt_day' });
    assert.equal(cfg.secrets.geminiApiKey, null);
  });

  for (const mode of [0o644, 0o640, 0o400, 0o700]) {
    test(`secrets.env が 0${mode.toString(8)} なら拒否`, async () => {
      const d = await dir(POC_TOML, ENV, mode);
      assert.throws(() => loadConfig({ env: {}, configDir: d }), (e: Error) => e instanceof ConfigError && /0600 ではない/.test(e.message) && !e.message.includes(GEMINI_KEY));
    });
  }

  test('知らないキー・型違いは拒否', async () => {
    const d1 = await dir('[gemini]\npaid_tier_confirm = true\n', null);
    assert.throws(() => loadConfig({ env: {}, configDir: d1 }), /知らないキー/);
    const d2 = await dir('[gemini]\npaid_tier_confirmed = "yes"\n', null);
    assert.throws(() => loadConfig({ env: {}, configDir: d2 }), /true \/ false/);
    const d3 = await dir('[freee]\npoc_company_id = -1\n', null);
    assert.throws(() => loadConfig({ env: {}, configDir: d3 }), /正の整数/);
    const d4 = await dir('[calendar]\ndeadline_mode = "2m"\n', null);
    assert.throws(() => loadConfig({ env: {}, configDir: d4 }), /deadline_mode/);
    const d6 = await dir('[deadline]\ncount_from = "first"\n', null);
    assert.throws(() => loadConfig({ env: {}, configDir: d6 }), /count_from/);
    const d5 = await dir('[other]\nx = 1\n', null);
    assert.throws(() => loadConfig({ env: {}, configDir: d5 }), /知らないセクション/);
  });
});

describe('worker の配線（[freee] target / day_boundary、[provider] kind、[gemini] thinking_level / media_resolution）', () => {
  test('既定は poc / jst / freee / low / medium', async () => {
    const cfg = loadConfig({ env: {}, configDir: await dir(null, null) });
    assert.deepEqual(cfg.freee, { pocCompanyId: null, prodCompanyId: null, target: 'poc', dayBoundary: 'jst' });
    assert.deepEqual(cfg.provider, { kind: 'freee' });
    assert.equal(cfg.gemini.thinkingLevel, 'low');
    assert.equal(cfg.gemini.mediaResolution, 'medium');
    assert.equal(cfg.gemini.maxOutputTokens, 8192);
  });
  test('指定を読む', async () => {
    const cfg = loadConfig({
      env: {},
      configDir: await dir('[freee]\ntarget = "prod"\nday_boundary = "jst"\n[provider]\nkind = "fake"\n[gemini]\nthinking_level = "medium"\nmedia_resolution = "high"\nmax_output_tokens = 2048\n', null),
    });
    assert.equal(cfg.freee.target, 'prod');
    assert.equal(cfg.provider.kind, 'fake');
    assert.equal(cfg.gemini.thinkingLevel, 'medium');
    assert.equal(cfg.gemini.mediaResolution, 'high');
    assert.equal(cfg.gemini.maxOutputTokens, 2048);
  });
  test('知らない値は拒否', async () => {
    for (const toml of ['[freee]\ntarget = "production"\n', '[freee]\nday_boundary = "utc"\n', '[provider]\nkind = "mf"\n', '[gemini]\nthinking_level = "max"\n', '[gemini]\nmax_output_tokens = 0\n']) {
      assert.throws(() => loadConfig({ env: {}, configDir: dir2(toml) }), ConfigError, toml);
    }
  });
});

describe('require*', () => {
  test('paid_tier_confirmed が無ければ Gemini は起動時エラー', async () => {
    const cfg = loadConfig({ env: {}, configDir: await dir('[freee]\npoc_company_id = 1\n', ENV) });
    assert.throws(() => requireGemini(cfg), /paid_tier_confirmed/);
  });
  test('GEMINI_API_KEY が無ければエラー', async () => {
    const cfg = loadConfig({ env: {}, configDir: await dir(POC_TOML, '') });
    assert.throws(() => requireGemini(cfg), /GEMINI_API_KEY/);
  });
  test('揃っていれば返す', async () => {
    const cfg = loadConfig({ env: {}, configDir: await dir(POC_TOML, ENV) });
    assert.deepEqual(requireGemini(cfg), { model: 'gemini-3.8-flash', apiKey: GEMINI_KEY });
    assert.deepEqual(requireFreee(cfg, 'poc'), { companyId: 123, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });
  test('対象の company_id が無ければ freee は起動時エラー', async () => {
    const cfg = loadConfig({ env: {}, configDir: await dir(POC_TOML, ENV) });
    assert.throws(() => requireFreee(cfg, 'prod'), /prod_company_id/);
    const cfg2 = loadConfig({ env: {}, configDir: await dir('', ENV) });
    assert.throws(() => requireFreee(cfg2, 'poc'), /poc_company_id/);
  });
  test('client_secret が無ければ freee は起動時エラー', async () => {
    const cfg = loadConfig({ env: {}, configDir: await dir(POC_TOML, `FREEE_CLIENT_ID=${CLIENT_ID}\n`) });
    assert.throws(() => requireFreee(cfg, 'poc'), /FREEE_CLIENT_SECRET/);
  });
});

test('dumpConfig はシークレットを *** にする', async () => {
  const cfg = loadConfig({ env: {}, configDir: await dir(POC_TOML, ENV) });
  const s = dumpConfig(cfg);
  for (const v of [GEMINI_KEY, CLIENT_ID, CLIENT_SECRET]) assert.ok(!s.includes(v));
  const o = JSON.parse(s);
  assert.deepEqual(o.secrets, { geminiApiKey: '***', freeeClientId: '***', freeeClientSecret: '***', gmailClientId: null, gmailClientSecret: null });
  assert.equal(o.freee.pocCompanyId, 123);
});

describe('[worker]', () => {
  test('linger_ms の既定は 1500（0 も可）、reauth_wait_days の既定は 7。負・0 日・知らないキーは拒否', () => {
    assert.deepEqual(loadConfig({ env: {}, configDir: dir2(''), dataDir: '/data/keihi' }).worker, { lingerMs: 1500, reauthWaitDays: 7, mode: 'systemd' });
    assert.deepEqual(loadConfig({ env: {}, configDir: dir2('[worker]\nlinger_ms = 0\nreauth_wait_days = 3\n'), dataDir: '/data/keihi' }).worker, { lingerMs: 0, reauthWaitDays: 3, mode: 'systemd' });
    for (const bad of ['[worker]\nlinger_ms = -1', '[worker]\nreauth_wait_days = 0', '[worker]\nlinger = 1']) assert.throws(() => loadConfig({ env: {}, configDir: dir2(bad), dataDir: '/data/keihi' }), ConfigError, bad);
  });
});

describe('[reconcile]', () => {
  test('verified_lookback_days の既定は 35、max_list_pages の既定は 20。0・知らないキーは拒否', () => {
    assert.deepEqual(loadConfig({ env: {}, configDir: dir2(''), dataDir: '/data/keihi' }).reconcile, { verifiedLookbackDays: 35, maxListPages: 20 });
    assert.deepEqual(loadConfig({ env: {}, configDir: dir2('[reconcile]\nverified_lookback_days = 60\nmax_list_pages = 5\n'), dataDir: '/data/keihi' }).reconcile, { verifiedLookbackDays: 60, maxListPages: 5 });
    for (const bad of ['[reconcile]\nverified_lookback_days = 0', '[reconcile]\nmax_list_pages = 0', '[reconcile]\nmax_pages = 1']) assert.throws(() => loadConfig({ env: {}, configDir: dir2(bad), dataDir: '/data/keihi' }), ConfigError, bad);
  });
});

describe('[bank]', () => {
  test('既定は backfill_from = 2025-01-01、dedup 0 日、振替・照合 3 日、カードの照合 10 日。指定を読み、不正な値・知らないキーは拒否', () => {
    assert.deepEqual(loadConfig({ env: {}, configDir: dir2(''), dataDir: '/data/keihi' }).bank, {
      backfillFrom: '2025-01-01', dedupDateWindowDays: 0, transferWindowDays: 3, matchDateWindowDays: 3, matchCardDateWindowDays: 10,
    });
    assert.deepEqual(
      loadConfig({
        env: {},
        configDir: dir2('[bank]\nbackfill_from = "2024-02-29"\ndedup_date_window_days = 1\ntransfer_window_days = 0\nmatch_date_window_days = 5\nmatch_card_date_window_days = 31\n'),
        dataDir: '/data/keihi',
      }).bank,
      { backfillFrom: '2024-02-29', dedupDateWindowDays: 1, transferWindowDays: 0, matchDateWindowDays: 5, matchCardDateWindowDays: 31 },
    );
    assert.equal(loadConfig({ env: {}, configDir: dir2('[bank]\nmatch_card_date_window_days = 0\n'), dataDir: '/data/keihi' }).bank.matchCardDateWindowDays, 0);
    for (const bad of [
      '[bank]\nbackfill_from = "2025-1-1"',
      '[bank]\nbackfill_from = "2025-02-30"',
      '[bank]\nbackfill_from = 2025-01-01',
      '[bank]\nbackfill_from = ""',
      '[bank]\ndedup_date_window_days = -1',
      '[bank]\ntransfer_window_days = 1.5',
      '[bank]\nmatch_date_window_days = "3"',
      '[bank]\nmatch_card_date_window_days = 32',
      '[bank]\nmatch_card_date_window_days = -1',
      '[bank]\nbackfill = "2025-01-01"',
    ]) assert.throws(() => loadConfig({ env: {}, configDir: dir2(bad), dataDir: '/data/keihi' }), ConfigError, bad);
  });
});

describe('[cashflow]', () => {
  test('既定は予定外の目安 6 か月・残す額 3 か月・予定外の収入は足さない。指定を読み、不正な値・知らないキーは拒否', () => {
    assert.deepEqual(loadConfig({ env: {}, configDir: dir2(''), dataDir: '/data/keihi' }).cashflow, { unplannedLookbackMonths: 6, reserveMonths: 3, includeUnplannedIncome: false });
    assert.deepEqual(
      loadConfig({ env: {}, configDir: dir2('[cashflow]\nunplanned_lookback_months = 24\nreserve_months = 12\ninclude_unplanned_income = true\n'), dataDir: '/data/keihi' }).cashflow,
      { unplannedLookbackMonths: 24, reserveMonths: 12, includeUnplannedIncome: true },
    );
    for (const bad of [
      '[cashflow]\nunplanned_lookback_months = 0',
      '[cashflow]\nunplanned_lookback_months = 25',
      '[cashflow]\nreserve_months = 0',
      '[cashflow]\nreserve_months = 13',
      '[cashflow]\ninclude_unplanned_income = 1',
      '[cashflow]\nreserve_months = "3"',
      '[cashflow]\nlookback_months = 6',
    ]) assert.throws(() => loadConfig({ env: {}, configDir: dir2(bad), dataDir: '/data/keihi' }), ConfigError, bad);
  });
});

describe('[backup] / [retention]', () => {
  test('既定値（drill_dir は <data_dir>/drill）', () => {
    const c = loadConfig({ env: {}, configDir: dir2(''), dataDir: '/data/keihi' });
    assert.deepEqual(c.backup, { repository: null, keepSnapshots: 7, checkIntervalDays: 7, readDataSubset: '5%', drillDir: '/data/keihi/drill', remoteVerifyMode: 'download_only' });
    assert.deepEqual(c.retention, { years: 7, extraYears: 1, start: 'next_year_0316' });
  });

  test('指定を読む', () => {
    const c = loadConfig({
      env: {},
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
      assert.throws(() => loadConfig({ env: {}, configDir: dir2(bad) }), ConfigError, bad);
    }
  });
});

describe('[mail]', () => {
  const load = (toml: string) => loadConfig({ env: {}, configDir: dir2(toml) });
  test('既定: 無効、gmail_api、100 通、手がかりあり、アカウント 0 件', () => {
    assert.deepEqual(load('').mail, { enabled: false, provider: 'gmail_api', maxMessagesPerRun: 100, extractHints: true, accounts: [] });
  });
  test('[[mail.accounts]] を 2 件（label の既定は keihi、query の既定は空、since は無ければ null）', () => {
    const cfg = load(
      [
        '[mail]', 'enabled = true', 'max_messages_per_run = 500', 'extract_hints = false',
        '[[mail.accounts]]', 'id = "personal"',
        '[[mail.accounts]]', 'id = "work-1"', 'label = "経費"', 'query = "has:attachment"', 'since = "2026-10-01"',
      ].join('\n'),
    );
    assert.deepEqual(cfg.mail, {
      enabled: true, provider: 'gmail_api', maxMessagesPerRun: 500, extractHints: false,
      accounts: [
        { id: 'personal', label: 'keihi', query: '', since: null },
        { id: 'work-1', label: '経費', query: 'has:attachment', since: '2026-10-01' },
      ],
    });
  });
  test('provider = "imap" は起動時エラー（mail_provider_not_implemented）', () => {
    assert.throws(() => load('[mail]\nprovider = "imap"\n'), (e: unknown) => e instanceof ConfigError && /mail_provider_not_implemented/.test(e.message));
    assert.throws(() => load('[mail]\nprovider = "pop3"\n'), ConfigError);
  });
  test('範囲外・不正な値・知らないキーはエラー', () => {
    for (const t of [
      '[mail]\nmax_messages_per_run = 0\n',
      '[mail]\nmax_messages_per_run = 501\n',
      '[mail]\nenabled = "yes"\n',
      '[mail]\nlabel = "keihi"\n', // label はアカウントごと
      '[mail]\nnope = 1\n',
      '[mail]\naccounts = "x"\n',
      '[[mail.accounts]]\nlabel = "keihi"\n', // id が無い
      '[[mail.accounts]]\nid = "a b"\n',
      `[[mail.accounts]]\nid = "${'a'.repeat(33)}"\n`,
      '[[mail.accounts]]\nid = "a"\n[[mail.accounts]]\nid = "a"\n',
      `[[mail.accounts]]\nid = "a"\nlabel = "${'x'.repeat(101)}"\n`,
      '[[mail.accounts]]\nid = "a"\nlabel = ""\n',
      `[[mail.accounts]]\nid = "a"\nquery = "${'x'.repeat(501)}"\n`,
      '[[mail.accounts]]\nid = "a"\nsince = "2026-02-30"\n',
      '[[mail.accounts]]\nid = "a"\nenabled = true\n',
    ]) {
      assert.throws(() => load(t), ConfigError, t);
    }
  });
  test('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET（dumpConfig では ***）', async () => {
    const cfg = loadConfig({ env: {}, configDir: await dir('', 'GMAIL_CLIENT_ID=gid-TEST\nGMAIL_CLIENT_SECRET=gsecret-TEST\n') });
    assert.deepEqual(requireGmail(cfg), { clientId: 'gid-TEST', clientSecret: 'gsecret-TEST' });
    const s = dumpConfig(cfg);
    assert.ok(!s.includes('gsecret-TEST') && !s.includes('gid-TEST'));
    const none = loadConfig({ env: {}, configDir: await dir('', '') });
    assert.throws(() => requireGmail(none), /GMAIL_CLIENT_ID/);
  });
});

describe('環境変数（コンテナ用）', () => {
  const load = (toml: string, env: NodeJS.ProcessEnv, extra: { configDir?: string; dataDir?: string } = {}) => loadConfig({ configDir: dir2(toml), dataDir: '/data/keihi', ...extra, env });
  const msgOf = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      assert.ok(e instanceof ConfigError, String(e));
      return e.message;
    }
    assert.fail('ConfigError にならない');
  };

  test('何も無ければ今までと同じ（host は 127.0.0.1、auth は tailscale、worker.mode は systemd）', () => {
    const c = load('', {});
    assert.equal(c.web.host, '127.0.0.1');
    assert.equal(c.web.auth, 'tailscale');
    assert.equal(c.worker.mode, 'systemd');
    assert.equal(c.dbPath, '/data/keihi/keihi.db');
  });
  test('型ごとの解釈: 文字列・整数・真偽・カンマ区切り・TOML のインライン配列', () => {
    const c = load('', {
      KEIHI_GEMINI_MODEL: 'gemini-test',
      KEIHI_WEB_PORT: '18795',
      KEIHI_GEMINI_PAID_TIER_CONFIRMED: 'true',
      KEIHI_MAIL_ENABLED: 'false',
      KEIHI_WEB_ALLOWED_USERS: ' you@example.com , ,other@example.com,',
      KEIHI_WEB_ALLOWED_HOSTS: 'Keihi.Example.com',
      KEIHI_MAIL_ACCOUNTS: '[{ id = "main", label = "keihi" }, { id = "sub", since = "2026-10-01" }]',
    });
    assert.equal(c.gemini.model, 'gemini-test');
    assert.equal(c.web.port, 18795);
    assert.equal(c.gemini.paidTierConfirmed, true);
    assert.equal(c.mail.enabled, false);
    assert.deepEqual(c.web.allowedUsers, ['you@example.com', 'other@example.com']);
    assert.deepEqual(c.web.allowedHosts, ['127.0.0.1:18795', 'keihi.example.com']);
    assert.deepEqual(c.mail.accounts, [
      { id: 'main', label: 'keihi', query: '', since: null },
      { id: 'sub', label: 'keihi', query: '', since: '2026-10-01' },
    ]);
  });
  test('config.toml より環境変数が優先。空文字は未設定', () => {
    const toml = '[web]\nport = 18800\nallowed_users = ["a@example.com"]\n';
    assert.equal(load(toml, { KEIHI_WEB_PORT: '18801' }).web.port, 18801);
    assert.equal(load(toml, { KEIHI_WEB_PORT: '' }).web.port, 18800);
    assert.deepEqual(load(toml, { KEIHI_WEB_ALLOWED_USERS: '' }).web.allowedUsers, ['a@example.com']);
  });
  test('型に合わない値はエラー（名前が分かる）。上書きした後も今の検証を通す', () => {
    for (const [name, v, re] of [
      ['KEIHI_WEB_PORT', '18795.5', /環境変数 KEIHI_WEB_PORT は整数/],
      ['KEIHI_WEB_PORT', 'abc', /環境変数 KEIHI_WEB_PORT は整数/],
      ['KEIHI_WEB_PORT', '70000', /環境変数 KEIHI_WEB_PORT は 1〜65535/],
      ['KEIHI_WORKER_LINGER_MS', '-1', /環境変数 KEIHI_WORKER_LINGER_MS は 0 以上/],
      ['KEIHI_MAIL_ENABLED', 'yes', /環境変数 KEIHI_MAIL_ENABLED は true \/ false/],
      ['KEIHI_MAIL_ENABLED', '1', /環境変数 KEIHI_MAIL_ENABLED は true \/ false/],
      ['KEIHI_CALENDAR_DEADLINE_MODE', 'late', /環境変数 KEIHI_CALENDAR_DEADLINE_MODE は "early" か "cycle"/],
      ['KEIHI_PROVIDER_KIND', 'other', /環境変数 KEIHI_PROVIDER_KIND は "freee" \/ "fake"/],
      ['KEIHI_MAIL_ACCOUNTS', '[{ id = ', /環境変数 KEIHI_MAIL_ACCOUNTS は TOML のインライン配列/],
      ['KEIHI_MAIL_ACCOUNTS', '"x"', /環境変数 KEIHI_MAIL_ACCOUNTS は表の配列/],
      ['KEIHI_MAIL_ACCOUNTS', '[{ id = "a b" }]', /環境変数 KEIHI_MAIL_ACCOUNTS の mail.accounts\[0\].id は/],
      ['KEIHI_MAIL_ACCOUNTS', '[{ id = "a", nope = 1 }]', /環境変数 KEIHI_MAIL_ACCOUNTS の mail.accounts\[0\].nope は知らないキー/],
      ['KEIHI_WORKER_MODE', 'docker', /環境変数 KEIHI_WORKER_MODE は "systemd" \/ "spawn" \/ "none"/],
    ] as const) {
      assert.match(msgOf(() => load('', { [name]: v })), re, `${name}=${v}`);
    }
  });
  test('KEIHI_ で始まる知らない名前はエラー。[paths] は上書きしない（KEIHI_DATA_DIR を使う）', () => {
    assert.match(msgOf(() => load('', { KEIHI_WEB_ALLOWED_USER: 'you@example.com' })), /環境変数 KEIHI_WEB_ALLOWED_USER は知らない名前/);
    assert.match(msgOf(() => load('', { KEIHI_PATHS_DATA_DIR: '/x' })), /KEIHI_PATHS_DATA_DIR は知らない名前/);
    // 知っている名前と、KEIHI_ で始まらない名前は通す
    load('', { KEIHI_INSECURE_HEADER_AUTH: '1', KEIHI_MIGRATE_ON_START: '1', KEIHI_BIND_HOST: '127.0.0.1', PATH: '/usr/bin', LOG_FORMAT: 'json' });
  });
  test('KEIHI_CONFIG_DIR・KEIHI_DATA_DIR の優先順位（引数 > 環境変数 > config.toml > 既定）', () => {
    const d = dir2('[paths]\ndata_dir = "/from/toml"\n[web]\nport = 18802\n');
    const viaEnv = loadConfig({ env: { KEIHI_CONFIG_DIR: d } });
    assert.equal(viaEnv.configDir, d);
    assert.equal(viaEnv.web.port, 18802);
    assert.equal(viaEnv.dataDir, '/from/toml');
    assert.equal(loadConfig({ configDir: d, env: { KEIHI_DATA_DIR: '/from/env' } }).dataDir, '/from/env');
    assert.equal(loadConfig({ configDir: d, dataDir: '/from/arg', env: { KEIHI_DATA_DIR: '/from/env' } }).dataDir, '/from/arg');
    const other = dir2('[web]\nport = 18803\n');
    assert.equal(loadConfig({ configDir: other, env: { KEIHI_CONFIG_DIR: d } }).web.port, 18803);
    assert.match(msgOf(() => loadConfig({ configDir: d, env: { KEIHI_DATA_DIR: 'relative' } })), /環境変数 KEIHI_DATA_DIR は絶対パス/);
    // 引数があれば環境変数は見ない
    assert.equal(loadConfig({ configDir: d, dataDir: '/from/arg', env: { KEIHI_DATA_DIR: 'relative' } }).dataDir, '/from/arg');
  });
  test('DATABASE_URL は sqlite:///絶対パス だけ（dbPath だけ変わる）。値はエラーに含めない', () => {
    const c = load('', { DATABASE_URL: 'sqlite:///db/keihi.db' });
    assert.equal(c.dbPath, '/db/keihi.db');
    assert.equal(c.objectsDir, '/data/keihi/objects');
    assert.equal(c.freeeTokenPath, '/data/keihi/freee-token.json');
    assert.equal(load('', { DATABASE_URL: 'sqlite:/db/keihi.db' }).dbPath, '/db/keihi.db');
    assert.equal(load('', { DATABASE_URL: '' }).dbPath, '/data/keihi/keihi.db');
    for (const url of ['postgres://user:hunter2-password@db.example.com/keihi', 'sqlite://relative.db', 'sqlite:relative.db', 'mysql:///x']) {
      const m = msgOf(() => load('', { DATABASE_URL: url }));
      assert.match(m, /DATABASE_URL は sqlite:\/\/\/絶対パス だけ/);
      assert.ok(!m.includes(url) && !m.includes('hunter2'), m);
    }
  });
  test('KEIHI_BIND_HOST は 127.0.0.1 か 0.0.0.0。allowedHosts に入れるのは 127.0.0.1:<port> のまま', () => {
    const c = load('', { KEIHI_BIND_HOST: '0.0.0.0' });
    assert.equal(c.web.host, '0.0.0.0');
    assert.deepEqual(c.web.allowedHosts, ['127.0.0.1:8795']);
    for (const h of ['::', 'localhost', '192.0.2.1']) assert.match(msgOf(() => load('', { KEIHI_BIND_HOST: h })), /KEIHI_BIND_HOST は "127.0.0.1" か "0.0.0.0"/);
    // config.toml には置けない
    assert.throws(() => load('[web]\nhost = "0.0.0.0"\n', {}), /知らないキー/);
  });
  test('secrets.env があればそのファイルだけ、無いときだけ環境変数から読む', async () => {
    const env = { GEMINI_API_KEY: 'env-gemini-TEST-key', FREEE_CLIENT_ID: 'env-cid-TEST', FREEE_CLIENT_SECRET: 'env-csecret-TEST', GMAIL_CLIENT_ID: 'env-gid-TEST', GMAIL_CLIENT_SECRET: 'env-gsecret-TEST' };
    const withFile = loadConfig({ configDir: await dir(POC_TOML, ENV), env });
    assert.deepEqual(withFile.secrets, { geminiApiKey: GEMINI_KEY, freeeClientId: CLIENT_ID, freeeClientSecret: CLIENT_SECRET, gmailClientId: null, gmailClientSecret: null });
    const without = loadConfig({ configDir: await dir(POC_TOML, null), env });
    assert.deepEqual(without.secrets, {
      geminiApiKey: 'env-gemini-TEST-key', freeeClientId: 'env-cid-TEST', freeeClientSecret: 'env-csecret-TEST', gmailClientId: 'env-gid-TEST', gmailClientSecret: 'env-gsecret-TEST',
    });
    const s = dumpConfig(without);
    for (const v of Object.values(env)) assert.ok(!s.includes(v));
    // 0600 の検査は今までどおり（環境変数があっても通さない）
    const bad = await dir(POC_TOML, ENV, 0o644);
    assert.throws(() => loadConfig({ configDir: bad, env }), /0600 ではない/);
    const none = loadConfig({ configDir: await dir(POC_TOML, null), env: {} });
    assert.match(msgOf(() => requireGemini(none)), /secrets\.env か環境変数に GEMINI_API_KEY が無い/);
    assert.match(msgOf(() => requireFreee(none, 'poc')), /secrets\.env か環境変数に FREEE_CLIENT_ID が無い/);
    assert.match(msgOf(() => requireGmail(none)), /secrets\.env か環境変数に GMAIL_CLIENT_ID が無い/);
  });
  test('[web] auth = "cloudflare_access" と access_*。必須キーが無ければエラー', () => {
    const ok = load('[web]\nauth = "cloudflare_access"\naccess_team_domain = "example.cloudflareaccess.com"\naccess_aud = "aud-tag-TEST"\naccess_service_tokens = ["ci-token.access"]\n', {});
    assert.equal(ok.web.auth, 'cloudflare_access');
    assert.equal(ok.web.accessTeamDomain, 'example.cloudflareaccess.com');
    assert.equal(ok.web.accessAud, 'aud-tag-TEST');
    assert.deepEqual(ok.web.accessServiceTokens, ['ci-token.access']);
    // accessAud は秘密ではないので dumpConfig にそのまま出る
    assert.equal(JSON.parse(dumpConfig(ok)).web.accessAud, 'aud-tag-TEST');
    const viaEnv = load('', {
      KEIHI_WEB_AUTH: 'cloudflare_access',
      KEIHI_WEB_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      KEIHI_WEB_ACCESS_AUD: 'aud-tag-TEST',
      KEIHI_WEB_ACCESS_SERVICE_TOKENS: 'a.access, b.access',
    });
    assert.equal(viaEnv.web.auth, 'cloudflare_access');
    assert.deepEqual(viaEnv.web.accessServiceTokens, ['a.access', 'b.access']);
    assert.match(msgOf(() => load('[web]\nauth = "cloudflare_access"\naccess_aud = "x"\n', {})), /access_team_domain と web.access_aud が要る/);
    assert.match(msgOf(() => load('[web]\nauth = "cloudflare_access"\naccess_team_domain = "example.cloudflareaccess.com"\n', {})), /access_aud が要る/);
    for (const bad of [
      '[web]\nauth = "basic"\n',
      '[web]\naccess_team_domain = "Example.cloudflareaccess.com"\n',
      '[web]\naccess_team_domain = "example.com"\n',
      '[web]\naccess_team_domain = "a.b.cloudflareaccess.com"\n',
      '[web]\naccess_aud = ""\n',
      '[web]\naccess_service_tokens = "x"\n',
    ]) {
      assert.throws(() => load(bad, {}), ConfigError, bad);
    }
    assert.match(msgOf(() => load('', { KEIHI_WEB_ACCESS_TEAM_DOMAIN: 'evil.example.com' })), /環境変数 KEIHI_WEB_ACCESS_TEAM_DOMAIN は "example.cloudflareaccess.com" の形/);
  });
  test('[worker] mode', () => {
    for (const m of ['systemd', 'spawn', 'none'] as const) assert.equal(load(`[worker]\nmode = "${m}"\n`, {}).worker.mode, m);
    assert.equal(load('', { KEIHI_WORKER_MODE: 'spawn' }).worker.mode, 'spawn');
  });
});
