import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate, brotliDecompress, gunzip, inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { ProxyError } from './errors.js';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'];

export function forwardHeaders(headers, { transformed = false, request = false } = {}) {
  const result = { ...headers };
  const connection = String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...connection]) delete result[name];
  if (request) {
    for (const name of ['host', 'authorization', 'chatgpt-account-id', 'x-openai-fedramp', 'expect', 'x-codex-proxy-request-id']) delete result[name];
  }
  if (transformed) {
    for (const name of ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest', 'content-digest', 'repr-digest']) delete result[name];
  }
  return result;
}

// Deliberately use http(s).request: fetch transparently decompresses responses.
export function requestRaw(url, { method = 'GET', headers = {}, body, signal,
  headersTimeoutMs = 30_000, idleTimeoutMs = 300_000, agent } = {}) {
  return new Promise((resolve, reject) => {
    const client = new URL(url).protocol === 'https:' ? https : http;
    const request = client.request(url, { method, headers, signal, agent }, response => {
      clearTimeout(timer);
      resolve(response);
    });
    const timer = setTimeout(() => request.destroy(new ProxyError('Upstream response headers timed out.', 504, 'upstream_timeout')), headersTimeoutMs);
    timer.unref();
    request.setTimeout(idleTimeoutMs, () => request.destroy(new ProxyError('Upstream connection timed out.', 504, 'upstream_timeout')));
    request.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(body);
  });
}

export async function readBody(stream, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new ProxyError('Body exceeds the configured size limit.', 413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Only adapter paths decode content. Raw relays retain the original encoding.
export function decodedStream(response) {
  const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
  const factory = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
  if (encoding === 'identity' || encoding === '') return response;
  if (!factory) throw new ProxyError(`Cannot adapt upstream Content-Encoding: ${encoding}`, 502, 'unsupported_encoding');
  const decoder = factory();
  response.on('error', error => decoder.destroy(error));
  decoder.on('error', () => response.destroy());
  decoder.on('close', () => { if (!response.complete) response.destroy(); });
  response.pipe(decoder);
  return decoder;
}

export async function readJsonResponse(response, limit) {
  const body = await readBody(decodedStream(response), limit);
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw new ProxyError('Upstream returned invalid JSON.', 502, 'invalid_upstream_response'); }
}

export async function decodeBuffer(body, encoding, limit = 64 * 1024 * 1024) {
  const name = String(encoding ?? 'identity').toLowerCase();
  if (name === 'identity' || name === '') return body;
  const decoder = { gzip: gunzip, deflate: inflate, br: brotliDecompress }[name];
  if (!decoder) throw new ProxyError(`Unsupported Content-Encoding: ${name}`, 415, 'unsupported_encoding');
  try { return await promisify(decoder)(body, { maxOutputLength: limit }); }
  catch { throw new ProxyError('Invalid compressed body or decoded body exceeds the size limit.', 413, 'invalid_compressed_body'); }
}

// Some Codex deployments omit Content-Type, even for SSE. Peek only far enough
// to identify the framing, then replay every inspected byte to the consumer.
export async function inspectResponse(response) {
  const type = String(response.headers['content-type'] ?? '').toLowerCase();
  if (/^text\/event-stream(?:\s*;|$)/.test(type)) return { body: response, headers: response.headers, streaming: true };
  if (/^application\/json(?:\s*;|$)/.test(type)) return { body: response, headers: response.headers, streaming: false };
  const source = decodedStream(response);
  const iterator = source[Symbol.asyncIterator]();
  const prefix = [];
  let size = 0;
  let format;
  let ended = false;
  try {
    while (size < 1024) {
      const next = await iterator.next();
      if (next.done) { ended = true; break; }
      prefix.push(next.value);
      size += next.value.length;
      const text = Buffer.concat(prefix).subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
      if (/^(?:event:|data:|id:|retry:|:)/.test(text)) { format = 'text/event-stream'; break; }
      if (/^[{[]/.test(text)) { format = 'application/json'; break; }
    }
  } catch (error) { await iterator.return?.(); throw error; }
  const body = Readable.from((async function* () {
    try {
      yield* prefix;
      while (!ended) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
    } finally { await iterator.return?.(); }
  })());
  body.headers = { ...forwardHeaders(response.headers, { transformed: source !== response }),
    ...(format ? { 'content-type': format } : {}) };
  return { body, headers: body.headers, streaming: format === 'text/event-stream' };
}
