import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import OpenAI from 'openai';
import { collectResponse } from '../sse.js';
import { normalizeResponsesStream } from '../responses-stream.js';
import { fixture, readRequest, finalResponse, compactEvents, encodeSSE, post } from './helpers.js';

test('all four SDK modes handle missing SSE Content-Type and compact terminal output', async t => {
  const final = finalResponse({ unknown_metadata: { preserved: true } });
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200); // Real deployment omitted Content-Type.
    res.end(encodeSSE(compactEvents(final)));
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const regular = await client.responses.create({ model: 'test-model', input: 'hello' });
  assert.equal(regular.output_text, 'Hello 🌍');
  assert.deepEqual(regular.output, final.output);
  assert.deepEqual(regular.unknown_metadata, final.unknown_metadata);
  const stream = await client.responses.create({ model: 'test-model', input: 'hello', stream: true });
  const received = [];
  for await (const event of stream) received.push(event);
  assert.deepEqual(received.at(-1).response, final);
  const params = { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] };
  assert.equal((await client.chat.completions.create(params)).choices[0].message.content, 'Hello 🌍');
  let text = '';
  for await (const chunk of await client.chat.completions.create({ ...params, stream: true })) text += chunk.choices[0]?.delta.content ?? '';
  assert.equal(text, 'Hello 🌍');
  const helper = client.responses.stream({ model: 'test-model', input: 'hello' });
  assert.equal((await helper.finalResponse()).output_text, 'Hello 🌍');
});

test('header inference replays small split prefixes and preserves native JSON bytes', async t => {
  const native = Buffer.from('{ "model": "test-model", "output": [] }\n');
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200);
    res.write(native.subarray(0, 1));
    res.end(native.subarray(1));
  });
  const response = await post(app.baseURL, '/responses', { model: 'test-model', input: 'x' });
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), native);
});

test('compressed SSE without a media type is decoded and completed for JSON and SSE callers', async t => {
  const final = finalResponse();
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end(gzipSync(encodeSSE(compactEvents(final))));
  });
  const regular = await post(app.baseURL, '/responses', { model: 'test-model', input: 'x' });
  assert.deepEqual(await regular.json(), final);
  const stream = await post(app.baseURL, '/responses', { model: 'test-model', input: 'x', stream: true });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.equal(stream.headers.get('content-encoding'), null);
  assert.deepEqual(await collectResponse(Readable.fromWeb(stream.body)), final);
});

test('stream normalization changes only missing terminal output and retains unknown frames', async () => {
  const final = finalResponse();
  const sequence = compactEvents(final);
  const untouched = Buffer.from(': heartbeat\r\n\r\nevent: future\r\ndata: null\r\n\r\n' + encodeSSE(sequence.slice(0, -1)));
  const terminal = Buffer.from(`id: event-9\r\nevent: response.completed\r\ndata: ${JSON.stringify(sequence.at(-1))}\r\n\r\n`);
  const output = [];
  for await (const chunk of normalizeResponsesStream(Readable.from([...Buffer.concat([untouched, terminal])].map(byte => Buffer.from([byte]))))) output.push(chunk);
  const bytes = Buffer.concat(output);
  assert.deepEqual(bytes.subarray(0, untouched.length), untouched);
  const repaired = bytes.subarray(untouched.length).toString();
  assert.ok(repaired.startsWith('id: event-9\r\nevent: response.completed\r\n'));
  assert.deepEqual(JSON.parse(repaired.split('\r\n').find(line => line.startsWith('data: ')).slice(6)).response, final);
});

test('compact terminal output retains complete reasoning and function items in index order', async () => {
  const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'opaque-ciphertext' };
  const call = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'sum', arguments: '{ "a": 2 }' };
  const final = finalResponse({ output: [reasoning, call] });
  const sequence = [
    { type: 'response.output_item.done', output_index: 1, item: call },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.completed', response: { ...final, output: [] } },
  ];
  assert.deepEqual(await collectResponse(Readable.from([encodeSSE(sequence)])), final);
  sequence[0].type = 'response.output_item.added';
  await assert.rejects(collectResponse(Readable.from([encodeSSE(sequence)])), { code: 'incomplete_upstream_stream' });
});

test('Responses normalizes Codex error envelopes and supplies missing JSON media types', async t => {
  let count = 0;
  const standard = '{ "error": { "message": "Rate limited", "code": "rate_limit_exceeded" } }\n';
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(++count === 1 ? 400 : 429);
    res.end(count === 1 ? '{"detail":"Invalid input"}' : standard);
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  await assert.rejects(client.responses.create({ model: 'test-model', input: 'x' }), error => {
    assert.equal(error.status, 400);
    assert.equal(typeof error.error, 'object');
    assert.equal(error.error.message, 'Invalid input');
    return true;
  });
  const response = await post(app.baseURL, '/responses', { model: 'test-model', input: 'x' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(await response.text(), standard);
});
