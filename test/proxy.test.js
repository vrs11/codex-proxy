import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import { requestRaw, readBody } from '../transport.js';
import { fixture, readRequest, sendJson, finalResponse, events, encodeSSE, post } from './helpers.js';

test('Responses preserves raw request and response bytes, compressed bodies, query and end-to-end headers', async t => {
  const requestBytes = Buffer.from('{ "model": "test-model", "input": "hello", "store": false, "stream": false, "future": [1,2] }\n');
  const compressedRequest = gzipSync(requestBytes);
  const responseBytes = gzipSync(Buffer.from('{ "object": "response", "future": 17 }\n'));
  const app = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/responses?custom=%2Ffoo&custom=bar');
    assert.deepEqual(await readRequest(req), compressedRequest);
    assert.equal(req.headers.authorization, 'Bearer upstream-secret');
    assert.equal(req.headers['chatgpt-account-id'], 'account-1');
    assert.equal(req.headers['x-custom'], 'preserved');
    assert.equal(req.headers['x-hop'], undefined);
    assert.equal(req.headers['content-encoding'], 'gzip');
    res.writeHead(201, { 'content-type': 'application/json', 'content-encoding': 'gzip',
      'content-length': responseBytes.length, 'x-request-id': 'request-1', 'set-cookie': ['one=1', 'two=2'],
      connection: 'keep-alive, x-upstream-hop', 'x-upstream-hop': 'remove' });
    res.end(responseBytes);
  });
  const response = await requestRaw(`${app.baseURL}/responses?custom=%2Ffoo&custom=bar`, {
    method: 'POST', body: compressedRequest,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: 'Bearer caller-token',
      'chatgpt-account-id': 'caller-account', 'x-custom': 'preserved', connection: 'keep-alive, x-hop', 'x-hop': 'remove' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(response.headers['x-request-id'], 'request-1');
  assert.equal(response.headers['x-upstream-hop'], undefined);
  assert.deepEqual(response.headers['set-cookie'], ['one=1', 'two=2']);
  assert.deepEqual(await readBody(response), responseBytes);
});

test('Responses streams unknown SSE events immediately and without rewriting bytes', async t => {
  const first = ': heartbeat\n\nevent: future.event\ndata: { "odd":true }\n\n';
  const rest = encodeSSE(events());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
    await gate;
    res.end(rest);
  });
  const response = await post(app.baseURL, '/responses', { model: 'test-model', input: 'x', stream: true });
  const reader = response.body.getReader();
  const initial = await reader.read();
  assert.equal(Buffer.from(initial.value).toString(), first);
  release();
  let remaining = '';
  while (true) { const next = await reader.read(); if (next.done) break; remaining += Buffer.from(next.value).toString(); }
  assert.equal(remaining, rest);
});

test('targeted validation repair preserves semantics and aggregates non-streaming output', async t => {
  const requests = [];
  const terminal = finalResponse({ future_field: { preserved: true } });
  const app = await fixture(t, async (req, res) => {
    const body = JSON.parse(await readRequest(req));
    requests.push(body);
    if (body.instructions === undefined) sendJson(res, 400, { detail: 'Instructions are required' });
    else if (body.store === undefined) sendJson(res, 400, { error: { message: 'Store must be set to false', param: 'store' } });
    else if (typeof body.input === 'string') sendJson(res, 400, { detail: 'Input must be a list' });
    else if (body.stream !== true) sendJson(res, 400, { error: { message: 'Stream must be true', param: 'stream' } });
    else {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', etag: 'old' });
      res.end(gzipSync(encodeSSE(events(terminal))));
    }
  });
  const original = { model: 'test-model', input: 'Original prompt', stream: false, client_metadata: { untouched: 'yes' } };
  const response = await post(app.baseURL, '/responses', original);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('etag'), null);
  assert.deepEqual(await response.json(), terminal);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[0], original);
  assert.deepEqual(requests[4], { ...original, stream: true, store: false, instructions: '',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Original prompt' }] }] });
});

test('unrelated upstream validation and rate-limit errors are preserved without retry', async t => {
  let count = 0;
  const bytes = '{ "error": { "message": "Unsupported parameter: future", "param": "future" } }\n';
  const app = await fixture(t, async (req, res) => {
    count++;
    await readRequest(req);
    res.writeHead(400, { 'content-type': 'application/json', 'retry-after': '12' });
    res.end(bytes);
  });
  const response = await post(app.baseURL, '/responses', { model: 'test-model', input: 'hello', future: true });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('retry-after'), '12');
  assert.equal(await response.text(), bytes);
  assert.equal(count, 1);
});

test('401 refresh retries once with identical request bytes; a second 401 is returned', async t => {
  const sent = [];
  let refreshes = 0;
  const auth = {
    headers: async () => ({ authorization: `Bearer token-${refreshes}`, 'chatgpt-account-id': 'a' }),
    refresh: async rejected => { assert.equal(rejected, 'Bearer token-0'); refreshes++; },
  };
  const app = await fixture(t, async (req, res) => {
    sent.push({ bytes: await readRequest(req), auth: req.headers.authorization });
    sendJson(res, 401, { error: { message: 'Unauthorized' } });
  }, { auth });
  const response = await post(app.baseURL, '/responses', { model: 'test-model', input: 'hello' });
  assert.equal(response.status, 401);
  assert.equal(refreshes, 1);
  assert.deepEqual(sent.map(value => value.auth), ['Bearer token-0', 'Bearer token-1']);
  assert.deepEqual(sent[0].bytes, sent[1].bytes);
});

test('official SDK lists models and reads both native and streamed Responses', async t => {
  const app = await fixture(t, async (req, res) => {
    if (req.url.startsWith('/models?')) {
      assert.ok(req.url.includes('client_version='));
      sendJson(res, 200, { models: [{ slug: 'test-model', display_name: 'Test' }] });
    } else {
      const body = JSON.parse(await readRequest(req));
      if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(encodeSSE(events())); }
      else sendJson(res, 200, finalResponse());
    }
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  assert.deepEqual((await client.models.list()).data, [{ id: 'test-model', object: 'model', created: 0, owned_by: 'openai' }]);
  const result = await client.responses.create({ model: 'test-model', input: 'hello' });
  assert.equal(result.output_text, 'Hello 🌍');
  const stream = await client.responses.create({ model: 'test-model', input: 'hello', stream: true });
  const received = [];
  for await (const event of stream) received.push(event);
  assert.deepEqual(received, events());
});

test('caller cancellation closes the upstream stream', async t => {
  let closed;
  const didClose = new Promise(resolve => { closed = resolve; });
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.once('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': waiting\n\n');
  });
  const controller = new AbortController();
  const response = await fetch(`${app.baseURL}/responses`, { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test-model', input: 'x', stream: true }) });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await Promise.race([didClose, delay(1500).then(() => { throw new Error('Upstream was not cancelled'); })]);
});

test('slow downstream still receives a large response intact', async t => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 'x');
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length });
    res.end(bytes);
  });
  const response = await requestRaw(`${app.baseURL}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: Buffer.from('{"model":"test-model","input":"x"}') });
  response.pause();
  await delay(30);
  assert.deepEqual(await readBody(response), bytes);
});

test('bad requests, oversized bodies and unknown endpoints produce explicit local errors', async t => {
  let calls = 0;
  const app = await fixture(t, () => { calls++; }, { config: { maxBodyBytes: 1024 } });
  for (const [body, status, param] of [
    [{ model: 'm', input: 'x', store: 'true' }, 400, 'store'],
    [{ input: 'x' }, 400, 'model'],
    [{ model: 'm', input: 'x', stream: 'true' }, 400, 'stream'],
    [{ model: 'm', input: 'x'.repeat(2000) }, 413, null],
  ]) {
    const response = await post(app.baseURL, '/responses', body);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.param, param);
  }
  assert.equal((await fetch(`${app.baseURL}/embeddings`)).status, 404);
  assert.equal((await fetch(`${app.baseURL}/responses`)).status, 405);
  assert.equal(calls, 0);
});

test('opaque upstream errors retain unknown encodings and are never retried', async t => {
  let count = 0;
  const bytes = Buffer.from([0, 1, 255, 17]);
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    count++;
    res.writeHead(429, { 'content-type': 'application/octet-stream', 'content-encoding': 'future-encoding', 'retry-after': '20' });
    res.end(bytes);
  });
  const response = await requestRaw(`${app.baseURL}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"model":"m","input":"x"}') });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['content-encoding'], 'future-encoding');
  assert.equal(response.headers['retry-after'], '20');
  assert.deepEqual(await readBody(response), bytes);
  assert.equal(count, 1);
});

test('connection failure and idle timeout return gateway errors without retrying generation', async t => {
  let count = 0;
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    count++;
    if (count === 1) res.destroy();
  }, { config: { idleTimeoutMs: 50 } });
  const disconnected = await post(app.baseURL, '/responses', { model: 'm', input: 'x' });
  assert.equal(disconnected.status, 502);
  await disconnected.json();
  const timeout = await post(app.baseURL, '/responses', { model: 'm', input: 'x' });
  assert.equal(timeout.status, 504);
  assert.equal((await timeout.json()).error.code, 'upstream_timeout');
  assert.equal(count, 2);
});

test('authentication recovery remains bounded across validation repairs', async t => {
  let refreshes = 0;
  let count = 0;
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    count++;
    if (count === 2) sendJson(res, 400, { detail: 'Instructions are required' });
    else sendJson(res, 401, { error: { message: 'Unauthorized' } });
  }, { auth: { headers: async () => ({ authorization: `Bearer ${refreshes}` }), refresh: async () => { refreshes++; } } });
  const response = await post(app.baseURL, '/responses', { model: 'm', input: 'x' });
  assert.equal(response.status, 401);
  await response.json();
  assert.equal(count, 3);
  assert.equal(refreshes, 1);
});
