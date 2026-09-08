import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { fixture, readRequest, sendJson, finalResponse, events, encodeSSE, post } from './helpers.js';

test('SDK Chat Completions maps images, ordered messages, tool round trips and structured output', async t => {
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
  const argumentsText = '{ "city": "Madrid" }';
  const app = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/responses');
    assert.deepEqual(JSON.parse(await readRequest(req)), {
      model: 'test-model', instructions: '', store: false, stream: true,
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Keep the original instructions.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Where is this?' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA=', detail: 'low' }] },
        { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: argumentsText },
        { type: 'function_call_output', call_id: 'call_1', output: '{ "degrees": 20 }' },
      ],
      tools: [{ type: 'function', name: 'weather', description: 'Read weather', parameters: schema, strict: false }],
      tool_choice: { type: 'function', name: 'weather' }, parallel_tool_calls: true,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'place', schema, strict: true } },
    });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'chat-request' });
    res.end(encodeSSE(events()));
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const completion = await client.chat.completions.create({
    model: 'test-model', stream: false,
    messages: [
      { role: 'system', content: 'Keep the original instructions.' },
      { role: 'user', content: [{ type: 'text', text: 'Where is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=', detail: 'low' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: argumentsText } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{ "degrees": 20 }' },
    ],
    tools: [{ type: 'function', function: { name: 'weather', description: 'Read weather', parameters: schema } }],
    tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: true,
    reasoning_effort: 'low', max_completion_tokens: 100, verbosity: 'low',
    response_format: { type: 'json_schema', json_schema: { name: 'place', schema, strict: true } },
  });
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.choices[0].message.content, 'Hello 🌍');
  assert.equal(completion.choices[0].finish_reason, 'stop');
  assert.deepEqual(completion.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } });
});

test('SDK reads streaming text with role, finish, usage and DONE across single-byte UTF-8 chunks', async t => {
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const encoded = Buffer.from(encodeSSE(events()));
    for (const byte of encoded) res.write(Buffer.from([byte]));
    res.end();
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const stream = await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }],
    stream: true, stream_options: { include_usage: true } });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.map(chunk => chunk.choices[0]?.delta.content ?? '').join(''), 'Hello 🌍');
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
  assert.equal(chunks.at(-1).usage.total_tokens, 15);
  assert.deepEqual(chunks.at(-1).choices, []);
  assert.ok(chunks.every(chunk => chunk.id === 'resp_test' && chunk.object === 'chat.completion.chunk'));
});

test('streaming tool calls keep stable indices and original interleaved argument deltas', async t => {
  const tools = [
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'first', arguments: '{ "a": 1 }' },
    { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'second', arguments: '{"b":2}' },
  ];
  const final = finalResponse({ output: tools });
  const sequence = [
    { type: 'response.created', response: { ...final, output: [], status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 1, item: { ...tools[0], arguments: '' } },
    { type: 'response.output_item.added', output_index: 2, item: { ...tools[1], arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{ "a": ' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"b":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '1 }' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '2}' },
    { type: 'response.completed', response: final },
  ];
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(encodeSSE(sequence));
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const stream = await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'call tools' }], stream: true });
  const calls = [];
  let finish;
  for await (const chunk of stream) {
    assert.equal(chunk.usage, undefined);
    finish = chunk.choices[0]?.finish_reason ?? finish;
    for (const call of chunk.choices[0]?.delta.tool_calls ?? []) {
      calls[call.index] ??= { id: call.id, name: call.function.name, arguments: '' };
      calls[call.index].arguments += call.function.arguments;
    }
  }
  assert.deepEqual(calls, tools.map(tool => ({ id: tool.call_id, name: tool.name, arguments: tool.arguments })));
  assert.equal(finish, 'tool_calls');
  const regular = await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'call tools' }] });
  assert.equal(regular.choices[0].message.content, null);
  assert.equal(regular.choices[0].message.tool_calls[0].function.arguments, tools[0].arguments);
});

test('Chat streaming emits the first delta before generation finishes', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const sequence = events();
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSSE(sequence.slice(0, 2)));
    await gate;
    res.end(encodeSSE(sequence.slice(2)));
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const stream = await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'x' }], stream: true });
  let text = '';
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta.content ?? '';
    if (text === 'Hello ') release();
  }
  assert.equal(text, 'Hello 🌍');
});

test('Chat adapter accepts native JSON from upstream in both modes', async t => {
  const app = await fixture(t, async (req, res) => { await readRequest(req); sendJson(res, 200, finalResponse()); });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const params = { model: 'test-model', messages: [{ role: 'user', content: 'x' }] };
  assert.equal((await client.chat.completions.create(params)).choices[0].message.content, 'Hello 🌍');
  const stream = await client.chat.completions.create({ ...params, stream: true });
  let text = '';
  for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
  assert.equal(text, 'Hello 🌍');
});

test('incomplete generation maps to length, while failed and truncated streams are errors', async t => {
  let mode = 'incomplete';
  const app = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'incomplete') res.end(encodeSSE([{ type: 'response.incomplete', response: finalResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) }]));
    else if (mode === 'failed') res.end(encodeSSE([{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'Limit reached' } } }]));
    else if (mode === 'malformed') res.end('data: {broken}\n\n');
    else res.end(encodeSSE(events().slice(0, 2)));
  });
  const client = new OpenAI({ baseURL: app.baseURL, apiKey: 'local', maxRetries: 0 });
  const params = { model: 'test-model', messages: [{ role: 'user', content: 'x' }] };
  assert.equal((await client.chat.completions.create(params)).choices[0].finish_reason, 'length');
  mode = 'failed';
  await assert.rejects(client.chat.completions.create(params), error => error.status === 429 && error.message.includes('Limit reached'));
  for (mode of ['malformed', 'truncated']) {
    await assert.rejects(client.chat.completions.create(params), error => error.status === 502);
    const stream = await client.chat.completions.create({ ...params, stream: true });
    await assert.rejects(async () => { for await (const chunk of stream) assert.notEqual(chunk.choices[0]?.finish_reason, 'stop'); });
  }
});

test('malformed tool requests are rejected and upstream errors are normalized without retry', async t => {
  let count = 0;
  const app = await fixture(t, async (req, res) => {
    count++;
    const body = JSON.parse(await readRequest(req));
    assert.equal(body.temperature, undefined);
    sendJson(res, 400, { detail: 'Invalid tool schema' }, { 'x-request-id': 'failed-1' });
  });
  const params = { model: 'test-model', messages: [{ role: 'user', content: 'x' }] };
  for (const [extra, param] of [
    [{ tools: 'invalid' }, 'tools'], [{ tool_choice: { type: 'function' } }, 'tool_choice'],
    [{ messages: [{ role: 'tool', content: 'x' }] }, 'messages[0]'],
    [{ messages: [{ role: 'function', name: 'missing', content: 'x' }] }, 'messages[0]'],
  ]) {
    const response = await post(app.baseURL, '/chat/completions', { ...params, ...extra });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, param);
  }
  assert.equal(count, 0);
  const response = await post(app.baseURL, '/chat/completions', { ...params, temperature: 0.7 });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('x-request-id'), 'failed-1');
  assert.equal((await response.json()).error.message, 'Invalid tool schema');
  assert.equal(count, 1);
});
