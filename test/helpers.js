import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { createProxyServer } from '../server.js';

export function jwt(payload) {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

export function tokens(now = Date.now(), suffix = '') {
  return {
    access_token: jwt({ exp: Math.floor(now / 1000) + 3600, nonce: suffix }),
    refresh_token: `refresh${suffix}`,
    id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }),
  };
}

export async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'codex-proxy-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

export async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

export async function mockServer(t, handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => {
      res.destroy(error);
      server.testError = error;
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (server.testError) throw server.testError;
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

export async function fixture(t, handler, options = {}) {
  const upstream = await mockServer(t, handler);
  const config = { ...loadConfig({}), upstream: upstream.url, readinessIntervalMs: 0, ...options.config };
  const auth = options.auth ?? {
    headers: async () => ({ authorization: 'Bearer upstream-secret', 'chatgpt-account-id': 'account-1' }),
    refresh: async () => {},
  };
  const server = createProxyServer(config, auth, { logger: options.logger });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.shutdown());
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, server, upstream };
}

export function finalResponse(overrides = {}) {
  return {
    id: 'resp_test', object: 'response', created_at: 123, model: 'test-model', status: 'completed', error: null,
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Hello 🌍', annotations: [], logprobs: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
      input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
    ...overrides,
  };
}

export function events(response = finalResponse()) {
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello ' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '🌍' },
    { type: 'response.completed', response },
  ];
}

export function encodeSSE(values) {
  return values.map(value => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join('');
}

// Observed Codex wire shape: output items are complete in their own events, but
// the terminal response carries metadata/usage and an empty output array.
export function compactEvents(response = finalResponse()) {
  const item = response.output[0];
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] } },
    ...events(response).slice(1, 3),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...response, output: [] } },
  ];
}

export async function post(baseURL, path, body) {
  return fetch(`${baseURL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
