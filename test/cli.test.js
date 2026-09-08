import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockServer, tempHome, tokens, sendJson } from './helpers.js';

const cwd = fileURLToPath(new URL('..', import.meta.url));

function launch(t, args, env) {
  const child = spawn(process.execPath, ['cli.js', ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } });
  return {
    child, exited, output: () => output,
    async waitFor(pattern) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const match = output.match(pattern);
        if (match) return match;
        if (child.exitCode !== null) throw new Error(`CLI exited: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`CLI did not produce expected output: ${output}`);
    },
  };
}

test('CLI starts with device login, serves health, shuts down and restarts without logging in', async t => {
  const home = await tempHome(t);
  let loginRequests = 0;
  const issuer = await mockServer(t, (req, res) => {
    if (req.url.endsWith('/usercode')) { loginRequests++; sendJson(res, 200, { device_auth_id: 'device', user_code: 'CODE-1234', interval: 1 }); }
    else if (req.url.endsWith('/deviceauth/token')) sendJson(res, 200, { authorization_code: 'code', code_verifier: 'verifier' });
    else sendJson(res, 200, tokens());
  });
  const env = { CODEX_PROXY_HOME: home, CODEX_PROXY_AUTH_ISSUER: issuer.url, CODEX_PROXY_PORT: '0' };
  const first = launch(t, [], env);
  const match = await first.waitFor(/listening at (http:\/\/127\.0\.0\.1:\d+)\/v1/);
  assert.match(first.output(), /Enter code: CODE-1234/);
  assert.equal((await fetch(`${match[1]}/health`)).status, 200);
  first.child.kill('SIGTERM');
  assert.equal((await first.exited)[0], 0);
  await assert.rejects(readFile(join(home, 'process.lock')), { code: 'ENOENT' });
  const second = launch(t, [], env);
  await second.waitFor(/listening at/);
  assert.doesNotMatch(second.output(), /Enter code/);
  assert.equal(loginRequests, 1);
  second.child.kill('SIGINT');
  assert.equal((await second.exited)[0], 0);
});

test('help and configuration validation do not need credentials', async t => {
  const home = await tempHome(t);
  const helper = launch(t, ['--help'], { CODEX_PROXY_HOME: home });
  assert.equal((await helper.exited)[0], 0);
  assert.match(helper.output(), /Usage:/);
  await assert.rejects(readFile(join(home, 'process.lock')), { code: 'ENOENT' });
  const invalid = launch(t, [], { CODEX_PROXY_HOME: home, CODEX_PROXY_PORT: 'invalid' });
  assert.equal((await invalid.exited)[0], 1);
  assert.match(invalid.output(), /CODEX_PROXY_PORT must be/);
});

test('explicit login replaces an unreadable credential file', async t => {
  const home = await tempHome(t);
  await writeFile(join(home, 'auth.json'), 'broken json');
  const issuer = await mockServer(t, (req, res) => {
    if (req.url.endsWith('/usercode')) sendJson(res, 200, { device_auth_id: 'device', user_code: 'CODE', interval: 1 });
    else if (req.url.endsWith('/deviceauth/token')) sendJson(res, 200, { authorization_code: 'code', code_verifier: 'verifier' });
    else sendJson(res, 200, tokens());
  });
  const login = launch(t, ['login'], { CODEX_PROXY_HOME: home, CODEX_PROXY_AUTH_ISSUER: issuer.url });
  assert.equal((await login.exited)[0], 0);
  assert.match(login.output(), /Login saved/);
  assert.equal(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).tokens.account_id, 'account-1');
});
