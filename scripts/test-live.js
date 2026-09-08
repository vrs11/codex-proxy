import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import OpenAI from 'openai';

const baseURL = process.env.CODEX_PROXY_TEST_BASE_URL || 'http://127.0.0.1:8787/v1';
const model = process.env.CODEX_PROXY_TEST_MODEL || 'gpt-5.4-mini';
const client = new OpenAI({ baseURL, apiKey: 'local-test', maxRetries: 0, timeout: 90_000 });
const results = [];
const input = 'Reply with exactly: café 🌍';
const messages = [{ role: 'user', content: input }];
const schema = { type: 'object', properties: { answer: { type: 'integer', const: 7 } }, required: ['answer'], additionalProperties: false };
const add = { type: 'function', name: 'add', description: 'Add two integers.', strict: true,
  parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false } };
const chatTool = { type: 'function', function: Object.fromEntries(Object.entries(add).filter(([key]) => key !== 'type')) };
const toolPrompt = 'Call add with a=2 and b=3. After receiving the result, reply with only the resulting number.';

function brief(error) {
  let message = String(error.error?.message ?? error.message ?? error);
  if (message.includes('data: ') || message.length > 500) message = 'Unexpected response or assertion failure; full payload omitted from the report.';
  return { message, ...(error.status ? { status: error.status } : {}), ...(error.code ? { code: error.code } : {}) };
}

async function check(name, run) {
  const start = performance.now();
  try {
    const details = await run();
    results.push({ name, passed: true, duration_ms: Math.round(performance.now() - start), ...details });
  } catch (error) {
    results.push({ name, passed: false, duration_ms: Math.round(performance.now() - start), error: brief(error) });
  }
  console.log(JSON.stringify(results.at(-1)));
}

function usage(value) {
  return value ? { total_tokens: value.total_tokens } : {};
}

// Deterministic 16x16 red PNG for vision requests; no files or image service.
function redPng() {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name);
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([header, type, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pixels = Buffer.alloc(16 * 49);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels[y * 49 + 1 + x * 3] = 255;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

await check('health and account model catalog', async () => {
  const health = await fetch(new URL('/health', baseURL), { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(await health.json(), { status: 'ok' });
  const catalog = await client.models.list();
  assert.ok(catalog.data.some(item => item.id === model));
  return { models: catalog.data.length, model };
});

await check('Responses regular JSON and Unicode', async () => {
  const response = await client.responses.create({ model, input, store: false });
  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.output_text.trim(), 'café 🌍');
  return usage(response.usage);
});

await check('Responses SSE text and complete terminal output', async () => {
  let text = '', terminal;
  let count = 0, firstDeltaMs;
  const start = performance.now();
  for await (const event of await client.responses.create({ model, input, store: false, stream: true })) {
    count++;
    if (event.type === 'response.output_text.delta') { text += event.delta; firstDeltaMs ??= Math.round(performance.now() - start); }
    if (event.type === 'response.completed') terminal = event.response;
    if (event.type === 'response.failed') throw new Error(event.response?.error?.message || 'Generation failed');
  }
  assert.equal(text.trim(), 'café 🌍');
  assert.equal(terminal?.status, 'completed');
  assert.ok(terminal.output.some(item => item.type === 'message' && item.content.some(part => part.text?.includes('café'))));
  return { events: count, first_delta_ms: firstDeltaMs, ...usage(terminal.usage) };
});

await check('SDK Responses stream finalResponse helper', async () => {
  const response = await client.responses.stream({ model, input, store: false }).finalResponse();
  assert.equal(response.output_text.trim(), 'café 🌍');
  return usage(response.usage);
});

await check('Chat Completions regular JSON and Unicode', async () => {
  const response = await client.chat.completions.create({ model, messages });
  assert.equal(response.object, 'chat.completion');
  assert.equal(response.choices[0].message.content.trim(), 'café 🌍');
  assert.equal(response.choices[0].finish_reason, 'stop');
  return usage(response.usage);
});

await check('Chat SSE role, text, finish and usage', async () => {
  let text = '', role, finish, finalUsage, count = 0, firstDeltaMs;
  const start = performance.now();
  for await (const chunk of await client.chat.completions.create({ model, messages, stream: true, stream_options: { include_usage: true } })) {
    count++;
    assert.equal(chunk.object, 'chat.completion.chunk');
    role ??= chunk.choices[0]?.delta.role;
    if (chunk.choices[0]?.delta.content) { text += chunk.choices[0].delta.content; firstDeltaMs ??= Math.round(performance.now() - start); }
    finish = chunk.choices[0]?.finish_reason ?? finish;
    if (chunk.usage) { finalUsage = chunk.usage; assert.deepEqual(chunk.choices, []); }
  }
  assert.equal(role, 'assistant'); assert.equal(text.trim(), 'café 🌍'); assert.equal(finish, 'stop');
  assert.ok(finalUsage?.total_tokens > 0);
  return { chunks: count, first_delta_ms: firstDeltaMs, ...usage(finalUsage) };
});

await check('Responses strict JSON schema', async () => {
  const response = await client.responses.create({ model, input: 'Return answer equal to 7.', store: false,
    text: { format: { type: 'json_schema', name: 'answer', strict: true, schema } } });
  assert.deepEqual(JSON.parse(response.output_text), { answer: 7 });
  return usage(response.usage);
});

await check('Chat strict JSON schema mapping', async () => {
  const response = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Return answer equal to 7.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } } });
  assert.deepEqual(JSON.parse(response.choices[0].message.content), { answer: 7 });
  return usage(response.usage);
});

await check('Responses function-call round trip', async () => {
  const history = [{ role: 'user', content: toolPrompt }];
  const first = await client.responses.create({ model, input: history, store: false, tools: [add],
    tool_choice: { type: 'function', name: 'add' }, include: ['reasoning.encrypted_content'] });
  const call = first.output.find(item => item.type === 'function_call');
  assert.equal(call?.name, 'add');
  const args = JSON.parse(call.arguments); assert.deepEqual(args, { a: 2, b: 3 });
  const second = await client.responses.create({ model, store: false, tools: [add], tool_choice: 'none',
    input: [...history, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: String(args.a + args.b) }] });
  assert.equal(second.output_text.trim(), '5');
  return { total_tokens: first.usage.total_tokens + second.usage.total_tokens };
});

await check('Chat function-call round trip', async () => {
  const history = [{ role: 'user', content: toolPrompt }];
  const first = await client.chat.completions.create({ model, messages: history, tools: [chatTool], tool_choice: { type: 'function', function: { name: 'add' } } });
  const message = first.choices[0].message;
  const call = message.tool_calls?.[0];
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  assert.equal(call?.function.name, 'add');
  const args = JSON.parse(call.function.arguments); assert.deepEqual(args, { a: 2, b: 3 });
  const second = await client.chat.completions.create({ model, tools: [chatTool], tool_choice: 'none',
    messages: [...history, message, { role: 'tool', tool_call_id: call.id, content: String(args.a + args.b) }] });
  assert.equal(second.choices[0].message.content.trim(), '5');
  return { total_tokens: first.usage.total_tokens + second.usage.total_tokens };
});

await check('Chat streamed function-call arguments', async () => {
  const calls = new Map();
  let finish;
  for await (const chunk of await client.chat.completions.create({ model, messages: [{ role: 'user', content: toolPrompt }], tools: [chatTool],
    tool_choice: { type: 'function', function: { name: 'add' } }, stream: true })) {
    finish = chunk.choices[0]?.finish_reason ?? finish;
    for (const part of chunk.choices[0]?.delta.tool_calls ?? []) {
      const call = calls.get(part.index) ?? { id: part.id, name: part.function?.name, arguments: '' };
      call.arguments += part.function?.arguments ?? '';
      calls.set(part.index, call);
    }
  }
  assert.equal(finish, 'tool_calls'); assert.equal(calls.size, 1);
  assert.equal(calls.get(0).name, 'add'); assert.ok(calls.get(0).id);
  assert.deepEqual(JSON.parse(calls.get(0).arguments), { a: 2, b: 3 });
});

await check('image input through Responses and Chat', async () => {
  const image = redPng();
  const question = 'What is the dominant color? Reply with one color word.';
  const response = await client.responses.create({ model, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: question }, { type: 'input_image', image_url: image }] }] });
  assert.match(response.output_text, /red/i);
  const chat = await client.chat.completions.create({ model, messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: image } }] }] });
  assert.match(chat.choices[0].message.content, /red/i);
  return { total_tokens: response.usage.total_tokens + chat.usage.total_tokens };
});

await check('three simultaneous independent callers', async () => {
  const started = performance.now();
  const responses = await Promise.all([1, 2, 3].map(number => client.chat.completions.create({ model,
    messages: [{ role: 'user', content: `Reply with exactly the word PING${number}.` }] })));
  responses.forEach((response, index) => assert.equal(response.choices[0].message.content.trim(), `PING${index + 1}`));
  assert.equal(new Set(responses.map(response => response.id)).size, 3);
  return { concurrency: 3, elapsed_ms: Math.round(performance.now() - started), total_tokens: responses.reduce((sum, response) => sum + response.usage.total_tokens, 0) };
});

await check('client cancellation and continued availability', async () => {
  const stream = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Print the numbers 1 through 100, separated by spaces.' }], stream: true });
  let cancelled = false;
  for await (const chunk of stream) {
    if (chunk.choices[0]?.delta.content) { stream.controller.abort(); cancelled = true; break; }
  }
  assert.ok(cancelled);
  assert.ok((await client.models.list()).data.length > 0);
});

await check('invalid model is returned as an upstream error', async () => {
  await assert.rejects(client.chat.completions.create({ model: 'codex-proxy-nonexistent-test-model', messages }), error => error.status >= 400 && error.status < 500 && Boolean(error.message));
});

await check('unsupported generation settings are ignored in both inference APIs', async () => {
  const ignored = { temperature: 0.7, top_p: 0.9, metadata: { test: 'compatibility' }, user: 'synthetic-test',
    safety_identifier: 'synthetic-test', prompt_cache_retention: '24h', service_tier: 'auto', store: true };
  const response = await client.responses.create({ model, input: 'Reply with exactly OK.', max_output_tokens: 1, ...ignored });
  assert.equal(response.output_text.trim(), 'OK');
  const chat = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    max_tokens: 1, max_completion_tokens: 1, n: 2, stop: ['OK'], seed: 1, frequency_penalty: 0,
    reasoning_effort: /^gpt-5\.6(?:-|$)/.test(model) ? 'minimal' : 'low', ...ignored });
  assert.equal(chat.choices.length, 1);
  assert.equal(chat.choices[0].message.content.trim(), 'OK');
  return { unsupported_settings_ignored: true };
});

await check('legacy function calling supports regular replies, history and streaming', async () => {
  const params = { model, messages: [{ role: 'user', content: toolPrompt }], functions: [chatTool.function], function_call: { name: 'add' } };
  const first = await client.chat.completions.create(params);
  const message = first.choices[0].message;
  assert.equal(first.choices[0].finish_reason, 'function_call');
  assert.equal(message.function_call.name, 'add');
  assert.deepEqual(JSON.parse(message.function_call.arguments), { a: 2, b: 3 });
  const second = await client.chat.completions.create({ ...params, function_call: 'none',
    messages: [...params.messages, message, { role: 'function', name: 'add', content: '5' }] });
  assert.equal(second.choices[0].message.content.trim(), '5');
  const stream = await client.chat.completions.create({ ...params, stream: true });
  let name = '', args = '', finish;
  for await (const chunk of stream) {
    name += chunk.choices[0]?.delta.function_call?.name ?? '';
    args += chunk.choices[0]?.delta.function_call?.arguments ?? '';
    finish = chunk.choices[0]?.finish_reason ?? finish;
  }
  assert.equal(name, 'add');
  assert.deepEqual(JSON.parse(args), { a: 2, b: 3 });
  assert.equal(finish, 'function_call');
});

await check('system messages are accepted through both inference APIs', async () => {
  const chat = await client.chat.completions.create({ model,
    messages: [{ role: 'system', content: 'Reply with exactly SYSTEM_OK.' }, { role: 'user', content: 'Hello.' }] });
  assert.equal(chat.choices[0].message.content.trim(), 'SYSTEM_OK');
  const response = await client.responses.create({ model, instructions: 'Follow the supplied instructions.',
    input: [{ role: 'system', content: 'Reply with exactly SYSTEM_OK.' }, { role: 'user', content: 'Hello.' }] });
  assert.equal(response.output_text.trim(), 'SYSTEM_OK');
});

await check('invalid request structure and HTTP requests return clear errors', async () => {
  for (const [params, param] of [[{ messages: [] }, 'messages'], [{ stream: 'true' }, 'stream'], [{ tools: 'invalid' }, 'tools']]) {
    await assert.rejects(client.chat.completions.create({ model, messages, ...params }), error => error.status === 400 && error.param === param);
  }
  const invalidJson = await fetch(`${baseURL}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken', signal: AbortSignal.timeout(5000) });
  assert.equal(invalidJson.status, 400); assert.equal((await invalidJson.json()).error.code, 'invalid_json');
  const wrongType = await fetch(`${baseURL}/responses`, { method: 'POST', body: 'plain text', signal: AbortSignal.timeout(5000) });
  assert.equal(wrongType.status, 415); await wrongType.text();
  const missing = await fetch(`${baseURL}/embeddings`, { signal: AbortSignal.timeout(5000) });
  assert.equal(missing.status, 404); await missing.text();
});

const report = { tested_at: new Date().toISOString(), base_url: baseURL, model, passed: results.filter(result => result.passed).length,
  failed: results.filter(result => !result.passed).length, results };
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
await writeFile(new URL('../test-results/live-latest.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(`Live checks: ${report.passed} passed, ${report.failed} failed. Report: test-results/live-latest.json`);
process.exitCode = report.failed ? 1 : 0;
