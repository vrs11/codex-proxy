import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import OpenAI from 'openai';
import { fixture, readRequest, sendJson, finalResponse, encodeSSE, post } from './helpers.js';

const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const fn = { name: 'weather', description: 'Read weather', parameters: schema };
const argumentsText = '{ "city": "Madrid 🌍" }';
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: fn.name, arguments: argumentsText };

test('configured reasoning effort overrides missing and conflicting caller values on both APIs and response modes', async t => {
  for (const effort of ['high', 'none']) {
    const requests = [];
    const app = await fixture(t, async (req, res) => {
      const body = JSON.parse(await readRequest(req));
      requests.push(body);
      assert.equal(body.model, 'gpt-5.6-sol');
      assert.equal(body.reasoning.effort, effort);
      assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(encodeSSE([{ type: 'response.completed', response: finalResponse() }]));
    }, { config: { reasoningEffortOverride: effort } });
    for (const path of ['/chat/completions', '/responses']) {
      for (const stream of [false, true]) {
        for (const controls of [
          {},
          { reasoning_effort: 'minimal' },
          { reasoning: { effort: 'low', summary: 'auto' } },
          { reasoning_effort: 'invalid', reasoning: { effort: 'max', summary: 'auto' } },
        ]) {
          const input = path === '/responses' ? { input: [{ role: 'user', content: 'Keep this text.' }] }
            : { messages: [{ role: 'user', content: 'Keep this text.' }] };
          const response = await post(app.baseURL, path, { model: 'gpt-5.6-sol', stream, ...input, ...controls });
          assert.equal(response.status, 200);
          if (stream) assert.match(await response.text(), path === '/responses' ? /response.completed/ : /\[DONE\]/);
          else {
            const result = await response.json();
            assert.equal(path === '/responses' ? result.status : result.choices[0].message.content,
              path === '/responses' ? 'completed' : 'Hello 🌍');
          }
          assert.deepEqual(requests.at(-1).reasoning, { ...controls.reasoning, effort });
        }
      }
    }
    assert.equal(requests.length, 16);
  }
});

test('reasoning override rewrites compressed Responses headers and survives validation repair', async t => {
  const requests = [];
  const app = await fixture(t, async (req, res) => {
    const bytes = await readRequest(req);
    assert.equal(req.headers['content-encoding'], undefined);
    assert.equal(Number(req.headers['content-length']), bytes.length);
    const body = JSON.parse(bytes);
    requests.push(body);
    assert.deepEqual(body.reasoning, { effort: 'max', summary: 'auto' });
    if (body.instructions === undefined) sendJson(res, 400, { detail: 'Instructions are required' });
    else sendJson(res, 200, finalResponse());
  }, { config: { reasoningEffortOverride: 'max' } });
  const original = { model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'Keep this text.' }],
    reasoning: { effort: 'low', summary: 'auto' }, future: { preserved: true } };
  const response = await fetch(`${app.baseURL}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gzipSync(JSON.stringify(original)) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), finalResponse());
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], { ...original, reasoning: { effort: 'max', summary: 'auto' }, instructions: '' });
});

test('disabled or matching overrides preserve compatible native request bytes and caller reasoning', async t => {
  const cases = [
    { override: null },
    { override: null, reasoning: { effort: 'high', summary: 'auto' } },
    { override: 'high', reasoning: { effort: 'high', summary: 'auto' } },
  ];
  for (const { override, reasoning } of cases) {
    const original = { model: 'gpt-5.6-sol', input: 'Keep this text.', ...(reasoning ? { reasoning } : {}) };
    const bytes = gzipSync(Buffer.from(`${JSON.stringify(original, null, 2)}\n`));
    const app = await fixture(t, async (req, res) => {
      assert.equal(req.headers['content-encoding'], 'gzip');
      assert.deepEqual(await readRequest(req), bytes);
      sendJson(res, 200, finalResponse());
    }, { config: { reasoningEffortOverride: override } });
    const response = await fetch(`${app.baseURL}/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: bytes });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), finalResponse());
  }
});

test('system instructions become developer messages in order on both endpoints, including streaming tool calls', async t => {
  const requests = [];
  const final = finalResponse({ output: [call] });
  const app = await fixture(t, async (req, res) => {
    const body = JSON.parse(await readRequest(req));
    requests.push(body);
    assert.deepEqual(body.input.map(item => item.role), ['developer', 'user', 'developer', 'developer']);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(encodeSSE([{ type: 'response.completed', response: final }]));
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const messages = [
    { role: 'system', content: 'Keep this instruction.\n🌍' },
    { role: 'user', content: 'Read weather.' },
    { role: 'system', content: [{ type: 'text', text: 'Keep this later instruction too.' }] },
    { role: 'developer', content: 'Keep the existing developer message.' },
  ];
  for (const stream of [false, true]) {
    const response = await client.chat.completions.create({ model: 'gpt-5.6-sol', messages, tools: [{ type: 'function', function: fn }], stream });
    if (stream) {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    } else assert.equal(response.choices[0].finish_reason, 'tool_calls');
  }
  assert.deepEqual(requests[0].input, [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: messages[0].content }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: messages[1].content }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: messages[2].content[0].text }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: messages[3].content }] },
  ]);
  const input = [
    { role: 'system', content: 'Native instruction.' },
    { role: 'user', content: 'Read weather.' },
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Native later instruction.', future: 'preserved' }] },
    { type: 'message', role: 'developer', content: 'Native developer message.' },
  ];
  const response = await client.responses.create({ model: 'gpt-5.6-sol', instructions: 'Keep top-level instructions.', input });
  assert.equal(response.status, 'completed');
  assert.deepEqual(requests[2].input, input.map(item => item.role === 'system' ? { ...item, role: 'developer' } : item));
  assert.equal(requests[2].instructions, 'Keep top-level instructions.');
});

test('Chat accepts common client defaults while preserving supported controls and message content', async t => {
  const app = await fixture(t, async (req, res) => {
    assert.deepEqual(JSON.parse(await readRequest(req)), {
      model: 'gpt-5.6-sol', instructions: '', store: false, stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep this text.' }] }],
      reasoning: { effort: 'low' }, text: { verbosity: 'low' }, prompt_cache_key: 'cache-key',
    });
    sendJson(res, 200, finalResponse());
  });
  const response = await post(app.baseURL, '/chat/completions', {
    model: 'gpt-5.6-sol', messages: [{ role: 'user', name: 'someone', reasoning_content: 'ignored', content: 'Keep this text.' }],
    temperature: 0.7, top_p: 0.9, max_tokens: 1, max_completion_tokens: 2, max_output_tokens: 3,
    frequency_penalty: 0, presence_penalty: 0, seed: 1, stop: ['Keep'], logit_bias: {}, logprobs: false, top_logprobs: 0,
    metadata: { tag: 'ignored' }, user: 'ignored', safety_identifier: 'ignored', prompt_cache_retention: '24h',
    prompt_cache_options: { ttl: '30m' }, n: 3, store: true, background: true, previous_response_id: 'old', conversation: 'old',
    audio: {}, modalities: ['text'], prediction: {}, future_option: true, stream_options: { include_usage: true },
    reasoning_effort: 'minimal', verbosity: 'low', prompt_cache_key: 'cache-key', service_tier: 'auto',
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.choices.length, 1);
  assert.equal(result.choices[0].message.content, 'Hello 🌍');
});

test('Responses normalizes compressed requests and regenerates headers without changing native content', async t => {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Keep this text.' }] }];
  const app = await fixture(t, async (req, res) => {
    const bytes = await readRequest(req);
    assert.equal(req.headers['content-encoding'], undefined);
    assert.equal(Number(req.headers['content-length']), bytes.length);
    assert.deepEqual(JSON.parse(bytes), {
      model: 'gpt-5.6-sol', input, stream: false, store: false, future: { preserved: true },
      client_metadata: { native: 'preserved' }, service_tier: 'default', prompt_cache_key: 'cache-key',
      reasoning: { effort: 'low', summary: 'auto' }, text: { verbosity: 'low', format: { type: 'json_object' } },
    });
    sendJson(res, 200, finalResponse());
  });
  const bytes = gzipSync(JSON.stringify({
    model: 'gpt-5.6-sol', input, stream: false, store: true, future: { preserved: true },
    temperature: 0.5, top_p: 0.9, max_output_tokens: 100, metadata: {}, user: 'ignored', safety_identifier: 'ignored',
    prompt_cache_retention: '24h', prompt_cache_options: {}, stop: ['END'], seed: 1,
    n: 2, background: true, previous_response_id: 'old', conversation: 'old',
    client_metadata: { native: 'preserved' }, service_tier: 'default', prompt_cache_key: 'cache-key',
    reasoning: { effort: 'minimal', summary: 'auto' }, verbosity: 'low', response_format: { type: 'json_object' },
  }));
  const response = await fetch(`${app.baseURL}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: bytes });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), finalResponse());
});

test('legacy function definitions, choices, results and repeated calls complete a full SDK round trip', async t => {
  const requests = [];
  const app = await fixture(t, async (req, res) => {
    const body = JSON.parse(await readRequest(req));
    requests.push(body);
    assert.deepEqual(body.tools, [{ type: 'function', ...fn, strict: false }]);
    assert.equal(body.parallel_tool_calls, false);
    assert.deepEqual(body.tool_choice, requests.length % 2 ? { type: 'function', name: fn.name } : 'none');
    sendJson(res, 200, requests.length % 2 ? finalResponse({ output: [call] }) : finalResponse());
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const messages = [{ role: 'user', content: 'Read weather.' }];
  for (let index = 0; index < 2; index++) {
    const first = await client.chat.completions.create({ model: 'test-model', messages, functions: [fn], function_call: { name: fn.name }, parallel_tool_calls: true });
    assert.equal(first.choices[0].finish_reason, 'function_call');
    assert.deepEqual(first.choices[0].message.function_call, { name: fn.name, arguments: argumentsText });
    assert.equal(first.choices[0].message.tool_calls, undefined);
    messages.push(first.choices[0].message, { role: 'function', name: fn.name, content: '{ "degrees": 20 }' });
    const second = await client.chat.completions.create({ model: 'test-model', messages, functions: [fn], function_call: 'none' });
    assert.equal(second.choices[0].message.content, 'Hello 🌍');
    if (index === 0) messages.push({ role: 'user', content: 'Read weather again.' });
  }
  assert.deepEqual(requests[3].input.filter(item => item.type.startsWith('function_call')), [
    { type: 'function_call', call_id: 'call_legacy_1', name: fn.name, arguments: argumentsText },
    { type: 'function_call_output', call_id: 'call_legacy_1', output: '{ "degrees": 20 }' },
    { type: 'function_call', call_id: 'call_legacy_4', name: fn.name, arguments: argumentsText },
    { type: 'function_call_output', call_id: 'call_legacy_4', output: '{ "degrees": 20 }' },
  ]);
});

test('legacy function streams translate argument deltas, terminal-only calls and usage', async t => {
  let mode = 'sse';
  const final = finalResponse({ output: [call] });
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    if (mode === 'json') { sendJson(res, 200, final); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(encodeSSE([
      { type: 'response.created', response: { ...final, output: [], status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: argumentsText.slice(0, 10) },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: argumentsText.slice(10) },
      { type: 'response.completed', response: final },
    ]));
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  for (mode of ['sse', 'json']) {
    const stream = await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'Read weather.' }],
      functions: [fn], function_call: 'auto', stream: true, stream_options: { include_usage: true, include_obfuscation: false } });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const deltas = chunks.flatMap(chunk => chunk.choices.map(choice => choice.delta));
    assert.ok(deltas.every(delta => delta.tool_calls === undefined));
    assert.equal(deltas.map(delta => delta.function_call?.name ?? '').join(''), fn.name);
    assert.equal(deltas.map(delta => delta.function_call?.arguments ?? '').join(''), argumentsText);
    assert.equal(chunks.at(-2).choices[0].finish_reason, 'function_call');
    assert.equal(chunks.at(-1).usage.total_tokens, 15);
  }
});

test('modern tools take precedence over legacy options and keep modern response fields', async t => {
  const app = await fixture(t, async (req, res) => {
    const body = JSON.parse(await readRequest(req));
    assert.deepEqual(body.tools, [{ type: 'function', ...fn, strict: false }]);
    assert.deepEqual(body.tool_choice, { type: 'function', name: fn.name });
    assert.equal(body.parallel_tool_calls, true);
    sendJson(res, 200, finalResponse({ output: [call] }));
  });
  const response = await post(app.baseURL, '/chat/completions', {
    model: 'test-model', messages: [{ role: 'user', content: 'Read weather.' }],
    tools: [{ type: 'function', function: { ...fn, unsupported_option: true }, unsupported_option: true }],
    tool_choice: { type: 'function', function: { name: fn.name } }, parallel_tool_calls: true,
    functions: [{ name: 'ignored' }], function_call: { name: 'ignored' },
  });
  const result = await response.json();
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.function_call, undefined);
  assert.deepEqual(result.choices[0].message.tool_calls, [{ id: call.call_id, type: 'function', function: { name: fn.name, arguments: argumentsText } }]);
});

test('legacy history IDs do not collide with existing modern tool-call IDs', async t => {
  const app = await fixture(t, async (req, res) => {
    const body = JSON.parse(await readRequest(req));
    assert.deepEqual(body.input.filter(item => item.call_id).map(item => item.call_id), ['call_legacy_1_', 'call_legacy_1_', 'call_legacy_1', 'call_legacy_1']);
    sendJson(res, 200, finalResponse());
  });
  const response = await post(app.baseURL, '/chat/completions', { model: 'test-model', messages: [
    { role: 'user', content: 'Read weather.' },
    { role: 'assistant', function_call: { name: fn.name, arguments: argumentsText } },
    { role: 'function', name: fn.name, content: '20' },
    { role: 'assistant', tool_calls: [{ id: 'call_legacy_1', type: 'function', function: { name: fn.name, arguments: argumentsText } }] },
    { role: 'tool', tool_call_id: 'call_legacy_1', content: '21' },
  ] });
  assert.equal(response.status, 200);
  await response.json();
});

test('legacy callers receive an error if upstream violates the single-call constraint', async t => {
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    sendJson(res, 200, finalResponse({ output: [call, { ...call, id: 'fc_2', call_id: 'call_2' }] }));
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const params = { model: 'test-model', messages: [{ role: 'user', content: 'Read weather.' }], functions: [fn] };
  await assert.rejects(client.chat.completions.create(params), error => error.status === 502);
  const stream = await client.chat.completions.create({ ...params, stream: true });
  await assert.rejects(async () => { for await (const chunk of stream) assert.notEqual(chunk.choices[0]?.finish_reason, 'function_call'); });
});
