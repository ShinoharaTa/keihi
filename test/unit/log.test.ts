// ログ（src/log.ts）。出力先・時計を差し替えて、text・json の形・レベル・マスキングを確かめる。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addSecrets, createLogger, type Logger } from '../../src/log.ts';

const NOW = new Date('2026-11-19T01:02:03.004Z');

function capture(env: NodeJS.ProcessEnv, service = 'keihi-web'): { log: Logger; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = createLogger({ service, env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW });
  return { log, out, err };
}

describe('text（既定）', () => {
  test('メッセージだけを 1 行。info・debug は stdout、warn・error は stderr。fields は出さない', () => {
    const { log, out, err } = capture({ LOG_LEVEL: 'debug' });
    log.info('web: listening on http://127.0.0.1:18795', { port: 18795 });
    log.debug('d');
    log.warn('web: [web] allowed_users が空なので、/healthz 以外はすべて 403 になる');
    log.error('e', { code: 1 });
    assert.deepEqual(out, ['web: listening on http://127.0.0.1:18795', 'd']);
    assert.deepEqual(err, ['web: [web] allowed_users が空なので、/healthz 以外はすべて 403 になる', 'e']);
  });
  test('fields.err が Error なら次の行に stack', () => {
    const { log, err } = capture({});
    const e = new Error('boom');
    log.error('web: unhandled error', { err: e });
    assert.equal(err.length, 2);
    assert.equal(err[0], 'web: unhandled error');
    assert.equal(err[1], e.stack);
  });
  test('LOG_FORMAT が知らない値なら text', () => {
    const { log, out } = capture({ LOG_FORMAT: 'xml' });
    log.info('x');
    assert.deepEqual(out, ['x']);
  });
});

describe('json', () => {
  test('1 行 1 JSON。ts（UTC）・level・service・env・msg・fields の順', () => {
    const { log, out, err } = capture({ LOG_FORMAT: 'json', APP_ENV: 'production' });
    log.info('request', { method: 'GET', path: '/api/status', status: 200 });
    log.warn('w');
    assert.equal(out.length, 1);
    assert.equal(out[0], '{"ts":"2026-11-19T01:02:03.004Z","level":"info","service":"keihi-web","env":"production","msg":"request","method":"GET","path":"/api/status","status":200}');
    assert.deepEqual(JSON.parse(err[0]), { ts: NOW.toISOString(), level: 'warn', service: 'keihi-web', env: 'production', msg: 'w' });
  });
  test('APP_ENV の既定は development、SERVICE_NAME があれば service を上書き', () => {
    const { log, out } = capture({ LOG_FORMAT: 'json', SERVICE_NAME: 'keihi-web-2' });
    log.info('x');
    const o = JSON.parse(out[0]);
    assert.equal(o.env, 'development');
    assert.equal(o.service, 'keihi-web-2');
  });
  test('fields.err（Error）は error と stack に展開し、err のままは出さない。fields で ts などは上書きできない', () => {
    const { log, err } = capture({ LOG_FORMAT: 'json' });
    const e = new Error('boom');
    log.error('web: unhandled error', { err: e, level: 'info', msg: 'x', method: 'POST' });
    const o = JSON.parse(err[0]);
    assert.equal(o.error, 'boom');
    assert.equal(o.stack, e.stack);
    assert.equal('err' in o, false);
    assert.equal(o.level, 'error');
    assert.equal(o.msg, 'web: unhandled error');
    assert.equal(o.method, 'POST');
  });
  test('child の fields を足す', () => {
    const { log, out } = capture({ LOG_FORMAT: 'json' });
    log.child({ request_id: 'r1' }).child({ job: 3 }).info('x', { a: 1 });
    const o = JSON.parse(out[0]);
    assert.equal(o.request_id, 'r1');
    assert.equal(o.job, 3);
    assert.equal(o.a, 1);
  });
});

describe('レベル', () => {
  test('LOG_LEVEL より下は出さない。知らない値は info', () => {
    for (const [level, expected] of [
      ['debug', 4],
      ['info', 3],
      ['warn', 2],
      ['error', 1],
      ['verbose', 3],
      ['toString', 3],
      [undefined, 3],
    ] as const) {
      const { log, out, err } = capture({ LOG_LEVEL: level });
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      assert.equal(out.length + err.length, expected, String(level));
    }
  });
});

describe('マスキング', () => {
  test('キー名が秘密らしい値は ***（入れ子も）', () => {
    const { log, out } = capture({ LOG_FORMAT: 'json' });
    log.info('x', {
      api_key: 'k',
      apiKey: 'k',
      headers: { Authorization: 'Basic abc', cookie: 'c', nested: { refresh_token: 't', ok: 'v' } },
      list: [{ client_secret: 's' }],
      password: 'p',
      assertion: 'jwt',
    });
    const o = JSON.parse(out[0]);
    assert.equal(o.api_key, '***');
    assert.equal(o.apiKey, '***');
    assert.deepEqual(o.headers, { Authorization: '***', cookie: '***', nested: { refresh_token: '***', ok: 'v' } });
    assert.deepEqual(o.list, [{ client_secret: '***' }]);
    assert.equal(o.password, '***');
    assert.equal(o.assertion, '***');
  });
  test('入れ子は深さ 4 まで（それより深いものは出さない）', () => {
    const { log, out } = capture({ LOG_FORMAT: 'json' });
    log.info('x', { a: { b: { c: { d: { e: { token: 't' } } } } } });
    assert.deepEqual(JSON.parse(out[0]).a, { b: { c: { d: { e: '[truncated]' } } } });
  });
  test('addSecrets で登録した値（8 文字以上）はメッセージ・文字列の値・stack から *** に。短い値は登録しない', () => {
    addSecrets(['registered-SECRET-value-TEST', 'short', null]);
    const j = capture({ LOG_FORMAT: 'json' });
    const e = new Error('failed with registered-SECRET-value-TEST');
    j.log.error('got registered-SECRET-value-TEST', { note: 'x registered-SECRET-value-TEST y', n: { m: ['registered-SECRET-value-TEST'] }, err: e, s: 'short' });
    const line = j.err[0];
    assert.ok(!line.includes('registered-SECRET-value-TEST'), line);
    const o = JSON.parse(line);
    assert.equal(o.msg, 'got ***');
    assert.equal(o.note, 'x *** y');
    assert.deepEqual(o.n, { m: ['***'] });
    assert.equal(o.error, 'failed with ***');
    assert.ok(o.stack.startsWith('Error: failed with ***'));
    assert.equal(o.s, 'short');
    const t = capture({});
    t.log.error('got registered-SECRET-value-TEST', { err: e });
    assert.ok(t.err.every((l) => !l.includes('registered-SECRET-value-TEST')));
    assert.equal(t.err[0], 'got ***');
  });
  test('Bearer <何か> は Bearer ***（text・json）', () => {
    const j = capture({ LOG_FORMAT: 'json' });
    j.log.info('Authorization: Bearer abc.def.ghi failed', { header: 'bearer xyz' });
    const o = JSON.parse(j.out[0]);
    assert.equal(o.msg, 'Authorization: Bearer *** failed');
    assert.equal(o.header, 'Bearer ***');
    const t = capture({});
    t.log.info('Bearer abc');
    assert.deepEqual(t.out, ['Bearer ***']);
  });
});
