import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../observability.js';
import { loadConfig } from '../config.js';
import { launchdPlist, serviceEnvironment } from '../service-config.js';
import { requestRaw, readBody } from '../transport.js';
import { normalizeResponsesStream } from '../responses-stream.js';
import { Readable } from 'node:stream';
import { fixture, readRequest, sendJson, finalResponse, events, encodeSSE, post, tempHome } from './helpers.js';

async function until(check, message = 'Condition did not become true') {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { if (await check()) return; await delay(5); }
  throw new Error(message);
}

test('admission includes streaming lifetime; overload rejects immediately while monitoring stays available', async t => {
  let calls = 0;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  t.after(finish);
  const app = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return sendJson(res, 200, { models: [] });
    calls++;
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': held\n\n');
    await gate;
    res.end(encodeSSE(events()));
  }, { config: { maxConcurrent: 1 } });
  await app.server.checkReadiness();
  const response = await post(app.baseURL, '/responses', { model: 'm', input: 'x', stream: true });
  assert.equal(response.status, 200);
  const rejected = await post(app.baseURL, '/responses', { model: 'm', input: 'x' });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get('retry-after'), '1');
  assert.equal((await rejected.json()).error.code, 'proxy_overloaded');
  for (const route of ['health', 'ready', 'metrics']) assert.equal((await fetch(`${app.baseURL.slice(0, -3)}/${route}`)).status, 200);
  assert.equal(calls, 1);
  assert.equal(app.server.snapshot().active, 1);
  finish();
  await response.text();
  await until(() => app.server.snapshot().active === 0);
  assert.equal(app.server.snapshot().counts.rejected, 1);
});

test('absolute deadline releases a request even when upstream sends continuous heartbeats', async t => {
  let closed = false;
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': heartbeat\n\n');
    const tick = setInterval(() => res.write(': heartbeat\n\n'), 10);
    res.once('close', () => { closed = true; clearInterval(tick); });
  }, { config: { requestTimeoutMs: 80 } });
  const response = await post(app.baseURL, '/responses', { model: 'm', input: 'x', stream: true });
  await assert.rejects(response.text());
  await until(() => closed && app.server.snapshot().active === 0);
  assert.equal(app.server.snapshot().counts.timeout, 1);
});

test('deadline before response headers returns a gateway timeout and cancels upstream', async t => {
  const app = await fixture(t, async req => { await readRequest(req); }, { config: { requestTimeoutMs: 50 } });
  const response = await post(app.baseURL, '/responses', { model: 'm', input: 'x' });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'request_timeout');
  await until(() => app.server.snapshot().active === 0);
});

test('stalled local uploads time out and release capacity without reaching upstream', async t => {
  let calls = 0;
  const app = await fixture(t, () => { calls++; }, { config: { bodyTimeoutMs: 60, headersTimeoutMs: 30 } });
  const request = http.request(`${app.baseURL}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {});
  t.after(() => request.destroy());
  const received = once(request, 'response');
  request.write('{"model":');
  const [response] = await received;
  const parts = [];
  for await (const part of response) parts.push(part);
  assert.equal(response.statusCode, 408);
  assert.equal(JSON.parse(Buffer.concat(parts)).error.code, 'body_timeout');
  await until(() => app.server.snapshot().active === 0);
  assert.equal(calls, 0);
});

test('cancellation while waiting for shared authentication releases capacity promptly', async t => {
  let entered = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release({}));
  const app = await fixture(t, () => {}, { auth: { headers: () => { entered = true; return gate; } } });
  const controller = new AbortController();
  const call = fetch(`${app.baseURL}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"model":"m","input":"x"}', signal: controller.signal }).catch(() => {});
  await until(() => entered);
  controller.abort();
  await call;
  await until(() => app.server.snapshot().active === 0);
  assert.equal(app.server.snapshot().counts.cancelled, 1);
});

test('graceful shutdown drains successful work and repeated shutdown calls share completion', async t => {
  let entered = false;
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    entered = true;
    await delay(60);
    sendJson(res, 200, finalResponse());
  }, { config: { shutdownGraceMs: 1000 } });
  const response = post(app.baseURL, '/responses', { model: 'm', input: 'x' });
  await until(() => entered);
  const stopping = app.server.shutdown();
  assert.equal(app.server.shutdown(), stopping);
  assert.equal((await response).status, 200);
  await (await response).json();
  await stopping;
  assert.equal(app.server.snapshot().active, 0);
  assert.equal(app.server.snapshot().ready.reason, 'draining');
});

test('shutdown deadline cancels stalled streams and reports forced termination', async t => {
  const records = [];
  let closed = false;
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.once('close', () => { closed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': held\n\n');
  }, { config: { shutdownGraceMs: 50 }, logger: { log: (event, values) => records.push({ event, ...values }) } });
  const response = await post(app.baseURL, '/responses', { model: 'm', input: 'x', stream: true });
  const consumed = response.text().catch(() => null);
  await app.server.shutdown();
  assert.equal(await consumed, null);
  await until(() => closed);
  assert.equal(app.server.snapshot().active, 0);
  assert.ok(records.some(value => value.event === 'shutdown_finished' && value.forced));
});

test('readiness probes are shared and cached, detect upstream recovery and revoked auth', async t => {
  let calls = 0;
  let status = 200;
  let validAuth = true;
  const app = await fixture(t, async (req, res) => {
    assert.match(req.url, /^\/models\?/);
    calls++;
    await delay(10);
    sendJson(res, status, { models: [] });
  }, { config: { readinessIntervalMs: 100_000 }, auth: {
    headers: async () => ({}), status: () => ({ ready: validAuth, reason: validAuth ? 'ok' : 'login_required' }),
  } });
  await Promise.all(Array.from({ length: 20 }, () => app.server.checkReadiness()));
  assert.equal(calls, 1);
  const url = `${app.baseURL.slice(0, -3)}/ready`;
  for (let i = 0; i < 10; i++) assert.equal((await fetch(url)).status, 200);
  assert.equal(calls, 1);
  status = 503;
  await app.server.checkReadiness();
  assert.equal((await fetch(url)).status, 503);
  status = 200;
  await app.server.checkReadiness();
  assert.equal((await fetch(url)).status, 200);
  validAuth = false;
  assert.equal((await (await fetch(url)).json()).reason, 'login_required');
});

test('request logs correlate IDs without recording credentials, payloads, or query strings', async t => {
  const home = await tempHome(t);
  const config = { ...loadConfig({}), logFile: join(home, 'proxy.jsonl') };
  const logger = createLogger(config);
  t.after(() => logger.close());
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    sendJson(res, 200, finalResponse(), { 'x-request-id': 'req_upstream' });
  }, { logger });
  const response = await fetch(`${app.baseURL}/responses?private=secret-query`, { method: 'POST', headers: {
    authorization: 'Bearer secret-header', 'content-type': 'application/json', 'x-codex-proxy-request-id': 'secret-client-id',
  }, body: '{"model":"secret-model","input":"secret-prompt"}' });
  await response.json();
  await until(() => app.server.snapshot().active === 0);
  await logger.flush();
  const text = await readFile(config.logFile, 'utf8');
  assert.doesNotMatch(text, /secret|upstream-secret|Hello/);
  const record = JSON.parse(text.trim());
  assert.equal(record.request_id, response.headers.get('x-codex-proxy-request-id'));
  assert.equal(record.upstream_request_id, 'req_upstream');
  assert.equal(record.attempts, 1);
  assert.equal(record.outcome, 'success');
});

test('log rotation bounds disk use; a blocked writer bounds queued records', async t => {
  const home = await tempHome(t);
  const config = { ...loadConfig({}), logFile: join(home, 'proxy.jsonl'), logMaxBytes: 1024, logFiles: 2 };
  const logger = createLogger(config);
  for (let i = 0; i < 3000; i++) logger.log('request_finished', { request_id: `id-${i}`, status: 200 });
  await logger.close();
  assert.ok(logger.snapshot().dropped > 0);
  const files = await readdir(home);
  assert.equal(files.length, 3);
  for (const file of files) {
    const info = await stat(join(home, file));
    assert.ok(info.size <= 1024);
    assert.equal(info.mode & 0o777, 0o600);
    for (const line of (await readFile(join(home, file), 'utf8')).trim().split('\n')) JSON.parse(line);
  }
});

test('local service refuses browser origins and unrelated Host headers before using account auth', async t => {
  let calls = 0;
  const app = await fixture(t, (_req, res) => { calls++; sendJson(res, 200, { models: [] }); });
  for (const headers of [{ host: 'unrelated.invalid' }, { origin: 'https://example.invalid' }]) {
    const response = await requestRaw(`${app.baseURL}/models`, { headers });
    assert.equal(response.statusCode, 403);
    await readBody(response);
  }
  assert.equal(calls, 0);
});

test('service manifest pins a direct runtime, private logs, restart throttling and shutdown grace', () => {
  const config = { ...loadConfig({}), home: '/tmp/a & b', shutdownGraceMs: 35_000 };
  const plist = launchdPlist({ node: '/opt/node/bin/node', directory: '/tmp/code & proxy', config });
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(plist, /code &amp; proxy/);
  assert.match(plist, /<key>ExitTimeOut<\/key><integer>45<\/integer>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.equal(serviceEnvironment(config).CODEX_PROXY_NON_INTERACTIVE, '1');
  assert.equal(serviceEnvironment(config).CODEX_PROXY_LOG_FILE, '/tmp/a & b/logs/proxy.jsonl');
});

test('a complete oversized SSE frame cannot bypass the frame limit in one input chunk', async () => {
  const raw = Buffer.from(`: ${'x'.repeat(16 * 1024 * 1024)}\n\n`);
  await assert.rejects(async () => {
    for await (const _frame of normalizeResponsesStream(Readable.from([raw]))) { /* consume */ }
  }, { code: 'upstream_event_too_large' });
});

test('a native stream adapter failure is recorded as failure after HTTP headers were sent', async t => {
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': first\n\n');
    await delay(20);
    res.end(encodeSSE([{ type: 'response.output_item.done', output_index: -1, item: { type: 'message' } }]));
  });
  const response = await post(app.baseURL, '/responses', { model: 'm', input: 'x', stream: true });
  await assert.rejects(response.text());
  await until(() => app.server.snapshot().active === 0);
  assert.equal(app.server.snapshot().counts.failed, 1);
  assert.equal(app.server.snapshot().counts.cancelled, 0);
});
