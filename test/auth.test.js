import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthManager } from '../auth.js';
import { acquireLease, saveCredentials } from '../credentials.js';
import { loadConfig } from '../config.js';
import { jwt, tokens, tempHome, mockServer, readRequest, sendJson } from './helpers.js';

test('device login polls, exchanges PKCE grant, saves credentials and reuses them after restart', async t => {
  const home = await tempHome(t);
  let polls = 0;
  const calls = [];
  const credentials = tokens();
  const issuer = await mockServer(t, async (req, res) => {
    const bytes = await readRequest(req);
    calls.push(req.url);
    if (req.url.endsWith('/usercode')) {
      assert.deepEqual(JSON.parse(bytes), { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
      sendJson(res, 200, { device_auth_id: 'device', usercode: 'ABCD-EFGH', interval: '1' });
    } else if (req.url.endsWith('/deviceauth/token')) {
      assert.deepEqual(JSON.parse(bytes), { device_auth_id: 'device', user_code: 'ABCD-EFGH' });
      if (++polls < 3) sendJson(res, polls === 1 ? 403 : 404, {});
      else sendJson(res, 200, { authorization_code: 'grant+code', code_verifier: 'verifier', code_challenge: 'challenge' });
    } else {
      assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(bytes.toString())), {
        grant_type: 'authorization_code', code: 'grant+code', redirect_uri: `${issuer.url}/deviceauth/callback`,
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code_verifier: 'verifier',
      });
      sendJson(res, 200, credentials);
    }
  });
  const config = { ...loadConfig({}), home, issuer: issuer.url };
  const delays = [];
  const auth = new AuthManager(config, { sleepImpl: async ms => { delays.push(ms); } });
  await auth.login(prompt => assert.deepEqual(prompt, { url: `${issuer.url}/codex/device`, code: 'ABCD-EFGH' }));
  assert.deepEqual(delays, [1000, 1000]);
  assert.equal((await stat(join(home, 'auth.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).tokens.refresh_token, credentials.refresh_token);
  const restarted = new AuthManager(config);
  assert.equal(await restarted.load(), true);
  assert.deepEqual(await restarted.headers(), { authorization: `Bearer ${credentials.access_token}`, 'chatgpt-account-id': 'account-1' });
  assert.equal(calls.length, 5);
});

test('refresh is shared by concurrent requests, rotates credentials, and preserves omitted tokens', async t => {
  const home = await tempHome(t);
  let count = 0;
  let now = Date.now();
  const renewed = tokens(now, '-new');
  const issuer = await mockServer(t, async (req, res) => {
    count++;
    const body = JSON.parse(await readRequest(req));
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.refresh_token, count === 1 ? 'refresh' : 'refresh-new');
    sendJson(res, 200, count === 1 ? { access_token: renewed.access_token, refresh_token: renewed.refresh_token }
      : { access_token: tokens(now, '-later').access_token });
  });
  const config = { ...loadConfig({}), home, issuer: issuer.url };
  const auth = new AuthManager(config, { now: () => now });
  await auth.persist({ ...tokens(now), access_token: jwt({ exp: Math.floor(now / 1000) + 60 }) });
  const rejected = `Bearer ${auth.credentials.tokens.access_token}`;
  const headers = await Promise.all(Array.from({ length: 20 }, () => auth.headers()));
  assert.equal(count, 1);
  assert.ok(headers.every(value => value.authorization === `Bearer ${renewed.access_token}`));
  await auth.refresh(rejected);
  assert.equal(count, 1, 'late 401 from the old token must not rotate again');
  now += 3600_000;
  await auth.headers();
  assert.equal(count, 2);
  const restarted = new AuthManager(config);
  await restarted.load();
  assert.equal(restarted.credentials.tokens.refresh_token, 'refresh-new');
  assert.equal(restarted.credentials.tokens.id_token, renewed.id_token);
});

test('revoked refresh credentials fail once with a login-required error', async t => {
  const home = await tempHome(t);
  let count = 0;
  const issuer = await mockServer(t, (req, res) => { count++; sendJson(res, 400, { error: 'invalid_grant' }); });
  const auth = new AuthManager({ ...loadConfig({}), home, issuer: issuer.url });
  await auth.persist({ ...tokens(), access_token: jwt({ exp: 1 }) });
  for (let i = 0; i < 2; i++) await assert.rejects(auth.headers(), { status: 401, code: 'login_required' });
  assert.equal(count, 1);
});

test('transient token refresh failure can recover without another login', async t => {
  const home = await tempHome(t);
  let count = 0;
  const issuer = await mockServer(t, (req, res) => sendJson(res, ++count === 1 ? 503 : 200, count === 1 ? {} : tokens()));
  let now = Date.now();
  const auth = new AuthManager({ ...loadConfig({}), home, issuer: issuer.url }, { now: () => now });
  await auth.persist({ ...tokens(), access_token: jwt({ exp: 1 }) });
  await assert.rejects(auth.headers(), { status: 503 });
  await assert.rejects(auth.headers(), { status: 503 });
  assert.equal(count, 1, 'transient failures must cool down before rotating again');
  now += 5001;
  await auth.headers();
  assert.equal(count, 2);
});

test('device authorization expiry and disabled device login are explicit', async t => {
  const home = await tempHome(t);
  let now = 0;
  const auth = new AuthManager({ ...loadConfig({}), home }, {
    now: () => now, loginTimeoutMs: 1000,
    sleepImpl: async ms => { now += ms; },
    fetchImpl: async url => url.endsWith('/usercode')
      ? new Response(JSON.stringify({ device_auth_id: 'device', user_code: 'CODE', interval: 1 }))
      : new Response('{}', { status: 403 }),
  });
  await assert.rejects(auth.login(() => {}), /expired/);
  auth.fetch = async () => new Response('{}', { status: 404 });
  await assert.rejects(auth.login(() => {}), /Enable device-code login/);
  await assert.rejects(readFile(join(home, 'auth.json')), { code: 'ENOENT' });
});

test('a failed credential write retains rotated tokens in memory and retries persistence before another refresh', async t => {
  const home = await tempHome(t);
  let refreshes = 0;
  let writes = 0;
  let now = Date.now();
  const renewed = tokens(now, '-rotated');
  const issuer = await mockServer(t, (_req, res) => { refreshes++; sendJson(res, 200, renewed); });
  const auth = new AuthManager({ ...loadConfig({}), home, issuer: issuer.url }, {
    now: () => now,
    saveImpl: async (path, credentials) => {
      if (++writes === 2) throw new Error('simulated disk failure');
      await saveCredentials(path, credentials);
    },
  });
  await auth.persist({ ...tokens(), access_token: jwt({ exp: 1 }) });
  await assert.rejects(auth.headers(), { code: 'credentials_persistence_failed' });
  assert.equal(auth.status().reason, 'credentials_not_saved');
  now += 5001;
  assert.equal((await auth.headers()).authorization, `Bearer ${renewed.access_token}`);
  assert.equal(refreshes, 1);
  assert.equal(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).tokens.refresh_token, renewed.refresh_token);
});

test('process lease prevents concurrent use and is released cleanly', async t => {
  const home = await tempHome(t);
  const release = await acquireLease(home);
  await assert.rejects(acquireLease(home), /Another proxy process/);
  await release();
  const next = await acquireLease(home);
  await next();
  await writeFile(join(home, 'auth.json'), 'not json');
  const auth = new AuthManager({ ...loadConfig({}), home });
  await assert.rejects(auth.load(), /Cannot read/);
});
