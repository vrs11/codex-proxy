import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pipeline, finished } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { chatToResponses } from './chat-request.js';
import { responseToChat, streamChat } from './chat-response.js';
import { ProxyError, errorBody, invalid } from './errors.js';
import { repairValidation, validateResponseRequest } from './responses.js';
import { normalizeResponsesStream } from './responses-stream.js';
import { collectResponse, writeSSE } from './sse.js';
import { decodeBuffer, decodedStream, forwardHeaders, inspectResponse, readBody, readJsonResponse, requestRaw } from './transport.js';
import { Metrics, quietLogger } from './observability.js';
import { Readiness, withSignal } from './lifecycle.js';

function json(response, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { ...forwardHeaders(headers, { transformed: true }),
    'content-type': 'application/json', 'content-length': bytes.length });
  response.end(bytes);
}

function sseHeaders(response, headers) {
  response.writeHead(200, { ...forwardHeaders(headers, { transformed: true }),
    'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  response.flushHeaders();
}

async function sendUpstreamError(response, upstream, bytes, chat) {
  {
    // If the representation cannot be decoded, preserve the upstream error.
    const decoded = await decodeBuffer(bytes, upstream.headers['content-encoding']).catch(() => null);
    if (!decoded) {
      response.writeHead(upstream.statusCode, forwardHeaders(upstream.headers));
      response.end(bytes);
      return;
    }
    let parsed;
    try { parsed = JSON.parse(decoded.toString('utf8')); } catch { /* Preserve text below. */ }
    const standardError = parsed?.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string';
    const recognizedError = parsed && typeof parsed === 'object' && ('detail' in parsed || 'error' in parsed || 'message' in parsed);
    if (!standardError && (chat || recognizedError)) {
      const detail = parsed?.detail ?? parsed?.error ?? parsed;
      const message = typeof detail === 'string' ? detail : detail?.message ?? decoded.toString('utf8').slice(0, 8192);
      const error = new ProxyError(message || 'Upstream request failed.', upstream.statusCode,
        detail?.code ?? 'upstream_error', detail?.param);
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) error.upstreamError = detail;
      json(response, upstream.statusCode, errorBody(error), upstream.headers);
      return;
    }
    if (parsed && typeof parsed === 'object' && !upstream.headers['content-type']) {
      response.writeHead(upstream.statusCode, { ...forwardHeaders(upstream.headers), 'content-type': 'application/json' });
      response.end(bytes);
      return;
    }
  }
  response.writeHead(upstream.statusCode, forwardHeaders(upstream.headers));
  response.end(bytes);
}

async function callUpstream(config, auth, request, { path, bytes, transformed, stream, signal, recovery = { refreshed: false } }) {
  signal.throwIfAborted();
  const headers = {
    ...forwardHeaders(request.headers, { transformed, request: true }),
    ...await withSignal(auth.headers(), signal),
  };
  headers.originator ??= 'codex_cli_rs';
  headers.version ??= config.clientVersion;
  headers['user-agent'] ??= 'codex-proxy/1.0.0';
  if (transformed) {
    headers['content-type'] = 'application/json';
    headers['accept-encoding'] = 'identity';
    if (stream) headers.accept = 'text/event-stream';
  }
  if (bytes !== undefined) headers['content-length'] = bytes.length;
  const url = `${config.upstream}${path}`;
  const dispatch = async () => {
    signal.throwIfAborted();
    if (request.proxyContext) request.proxyContext.attempts++;
    const result = await requestRaw(url, { method: request.method, headers, body: bytes, signal,
      idleTimeoutMs: config.idleTimeoutMs, headersTimeoutMs: config.upstreamHeadersTimeoutMs, agent: config.agent });
    const id = result.headers['x-request-id'];
    if (request.proxyContext && typeof id === 'string' && /^[\w.:-]{1,128}$/.test(id)) request.proxyContext.upstream_request_id = id;
    return result;
  };
  let upstream = await dispatch();
  if (upstream.statusCode === 401 && !recovery.refreshed) {
    recovery.refreshed = true;
    upstream.destroy();
    await withSignal(auth.refresh(headers.authorization), signal);
    Object.assign(headers, await withSignal(auth.headers(), signal));
    signal.throwIfAborted();
    upstream = await dispatch();
  }
  return upstream;
}

export function createProxyServer(config, auth, { logger = quietLogger } = {}) {
  const Agent = new URL(config.upstream).protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new Agent({ keepAlive: true, maxSockets: config.maxConcurrent + 1,
    maxTotalSockets: config.maxConcurrent + 1, maxFreeSockets: Math.min(8, config.maxConcurrent + 1), scheduling: 'lifo' });
  config = { ...config, agent };
  const active = new Set();
  const tasks = new Set();
  const metrics = new Metrics();
  let draining = false;
  let shuttingDown;
  const readiness = new Readiness(config, auth, async signal => {
    const upstream = await callUpstream(config, auth, { method: 'GET', headers: {} }, {
      path: `/models?client_version=${encodeURIComponent(config.clientVersion)}`, signal,
    });
    try {
      if (upstream.statusCode !== 200) throw new ProxyError('Model discovery is unavailable.', upstream.statusCode);
      const catalog = await readJsonResponse(upstream, 4 * 1024 * 1024);
      if (!Array.isArray(catalog.models) && !(catalog.object === 'list' && Array.isArray(catalog.data))) throw new ProxyError('Invalid model catalog.');
    } finally { if (!upstream.readableEnded) upstream.destroy(); }
  }, logger);
  const server = http.createServer({ maxHeaderSize: 16 * 1024,
    headersTimeout: config.headersTimeoutMs, requestTimeout: config.bodyTimeoutMs,
    keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 }, (request, response) => {
    const task = handle(request, response).catch(() => response.destroy());
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  async function handle(request, response) {
    const controller = new AbortController();
    const context = { request_id: randomUUID(), method: ['GET', 'POST'].includes(request.method) ? request.method : 'OTHER', route: 'unknown', attempts: 0 };
    request.proxyContext = context;
    response.setHeader('x-codex-proxy-request-id', context.request_id);
    const start = performance.now();
    const flushed = finished(response, { cleanup: true }).catch(() => {});
    let admitted = false;
    let observed = true;
    let timer;
    let bodyTimer;
    let failure;
    let upstream;
    let adaptedSSE = false;
    const cancel = () => {
      if (!response.writableFinished) controller.abort(new ProxyError('Caller disconnected.', 499, 'client_disconnected'));
    };
    const timeout = (message, status, code) => {
      failure = new ProxyError(message, status, code);
      controller.abort(failure);
      if (response.headersSent) response.destroy();
      else {
        response.setHeader('connection', 'close');
        json(response, status, errorBody(failure));
        request.resume();
      }
    };
    request.once('aborted', cancel);
    response.once('close', cancel);
    response.once('error', error => {
      if (!controller.signal.aborted && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') failure ??= error;
    });
    response.once('finish', () => { if (!request.complete) request.destroy(); });
    try {
      if (!request.url.startsWith('/') || request.url.startsWith('//')) throw invalid('Invalid request target.', null, 'invalid_request');
      const port = server.address()?.port;
      const hosts = ['127.0.0.1', 'localhost'];
      // A wildcard bind is reached through a concrete interface address.
      // Use the receiving socket's address, never an arbitrary caller Host.
      if (config.host === '0.0.0.0') hosts.push(request.socket.localAddress);
      const authorities = hosts.flatMap(host => port === 80 ? [host, `${host}:${port}`] : [`${host}:${port}`]);
      if (!authorities.includes(request.headers.host?.toLowerCase())) {
        throw new ProxyError('Host must match a proxy interface address or localhost.', 403, 'invalid_host');
      }
      if (request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new ProxyError('Browser-origin requests are not enabled.', 403, 'browser_access_disabled');
      const url = new URL(request.url, 'http://localhost');
      context.route = ['/health', '/ready', '/metrics', '/v1/models', '/v1/chat/completions', '/v1/responses'].includes(url.pathname) ? url.pathname : 'unknown';
      observed = !['/health', '/ready', '/metrics'].includes(context.route);
      if (url.pathname === '/health' && request.method === 'GET') {
        json(response, 200, { status: 'ok' });
        return;
      }
      if (url.pathname === '/ready' && request.method === 'GET') {
        const state = readiness.snapshot();
        json(response, state.ready ? 200 : 503, state, { 'cache-control': 'no-store' });
        return;
      }
      if (url.pathname === '/metrics' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        response.end(metrics.render({ active: active.size, limit: config.maxConcurrent, ready: readiness.snapshot().ready, logger }));
        return;
      }
      const isModels = url.pathname === '/v1/models';
      const chat = url.pathname === '/v1/chat/completions';
      if (!isModels && !chat && url.pathname !== '/v1/responses') throw new ProxyError('Unknown endpoint.', 404, 'not_found');
      if (request.method !== (isModels ? 'GET' : 'POST')) throw new ProxyError('Method not allowed.', 405, 'method_not_allowed');
      if (draining) throw new ProxyError('Server is draining. Retry after restart.', 503, 'server_draining');
      if (active.size >= config.maxConcurrent) {
        const error = new ProxyError('The local proxy is at its concurrency limit. Retry later.', 429, 'proxy_overloaded');
        error.retryAfter = 1;
        throw error;
      }
      active.add(controller);
      admitted = true;
      metrics.peak = Math.max(metrics.peak, active.size);
      timer = setTimeout(() => timeout('The request exceeded its time limit.', 504, 'request_timeout'), config.requestTimeoutMs);
      timer.unref();
      response.setTimeout(config.idleTimeoutMs, () => {
        if (response.headersSent) timeout('The connection exceeded its idle time limit.', 504, 'downstream_timeout');
      });
      if (isModels) {
        if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) throw invalid('GET /v1/models does not accept a request body.', null, 'unexpected_body');
        let query = url.search;
        if (!url.searchParams.has('client_version')) query += `${query ? '&' : '?'}client_version=${encodeURIComponent(config.clientVersion)}`;
        upstream = await callUpstream(config, auth, request, { path: `/models${query}`, signal: controller.signal });
        const bytes = await readBody(upstream);
        if (upstream.statusCode >= 300) { await sendUpstreamError(response, upstream, bytes, true); return; }
        const decoded = await decodeBuffer(bytes, upstream.headers['content-encoding']);
        let catalog;
        try { catalog = JSON.parse(decoded.toString('utf8')); }
        catch { throw new ProxyError('Upstream returned an invalid model catalog.', 502, 'invalid_upstream_response'); }
        if (catalog.object === 'list' && Array.isArray(catalog.data)) {
          response.writeHead(upstream.statusCode, forwardHeaders(upstream.headers));
          response.end(bytes);
          return;
        }
        if (!Array.isArray(catalog.models)) throw new ProxyError('Upstream returned an invalid model catalog.', 502, 'invalid_upstream_response');
        const data = catalog.models.map(model => {
          if (typeof model.slug !== 'string') throw new ProxyError('Upstream model is missing its ID.', 502, 'invalid_upstream_response');
          return { id: model.slug, object: 'model', created: model.created ?? 0, owned_by: model.owned_by ?? 'openai' };
        });
        json(response, 200, { object: 'list', data }, upstream.headers);
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new ProxyError('Content-Type must be application/json.', 415, 'unsupported_media_type');
      if (Number(request.headers['content-length'] ?? 0) > config.maxBodyBytes) throw new ProxyError('Body exceeds the configured size limit.', 413, 'body_too_large');
      bodyTimer = setTimeout(() => timeout('Request body upload timed out.', 408, 'body_timeout'), config.bodyTimeoutMs);
      bodyTimer.unref();
      const original = await readBody(request, config.maxBodyBytes);
      clearTimeout(bodyTimer);
      const decoded = await decodeBuffer(original, request.headers['content-encoding'], config.maxBodyBytes);
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)); }
      catch { throw invalid('Request body must contain valid UTF-8 JSON.', null, 'invalid_json'); }
      validateResponseRequest(body);
      const wantsStream = body.stream === true;
      const includeUsage = body.stream_options?.include_usage === true;
      let outgoing = chat ? chatToResponses(body) : body;
      let transformed = chat;
      let bytes = chat ? Buffer.from(JSON.stringify(outgoing)) : original;
      const recovery = { refreshed: false };
      for (let attempt = 0; attempt < 5; attempt++) {
        controller.signal.throwIfAborted();
        upstream = await callUpstream(config, auth, request, {
          path: `/responses${url.search}`, bytes, transformed, stream: outgoing.stream, signal: controller.signal, recovery,
        });
        if (upstream.statusCode < 300) break;
        const errorType = upstream.headers['content-type'];
        if (!chat && ![400, 422].includes(upstream.statusCode) && errorType && !/^application\/json(?:\s*;|$)/i.test(errorType)) {
          response.writeHead(upstream.statusCode, forwardHeaders(upstream.headers));
          response.flushHeaders();
          await pipeline(upstream, response);
          return;
        }
        const errorBytes = await readBody(upstream);
        // Decoding for inspection never changes a relayed error's original bytes.
        const errorDecoded = await decodeBuffer(errorBytes, upstream.headers['content-encoding']).catch(() => null);
        const repaired = errorDecoded && repairValidation(outgoing, upstream.statusCode, errorDecoded);
        if (repaired && attempt < 4) {
          outgoing = repaired;
          bytes = Buffer.from(JSON.stringify(outgoing));
          transformed = true;
          continue;
        }
        await sendUpstreamError(response, upstream, errorBytes, chat);
        return;
      }
      const { body: upstreamBody, headers: bodyHeaders, streaming } = await inspectResponse(upstream);
      if (!chat && (wantsStream || !streaming)) {
        if (streaming) {
          const headers = forwardHeaders(bodyHeaders, { transformed: true });
          response.writeHead(upstream.statusCode, headers);
          response.flushHeaders();
          await pipeline(decodedStream(upstreamBody), normalizeResponsesStream, response);
          return;
        }
        response.writeHead(upstream.statusCode, forwardHeaders(bodyHeaders));
        response.flushHeaders();
        await pipeline(upstreamBody, response);
        return;
      }
      if (chat && wantsStream) {
        // Decode/validate a native JSON response before committing SSE headers.
        const stream = streaming ? decodedStream(upstreamBody) : Readable.from([
          `data: ${JSON.stringify({ type: 'response.completed', response: await readJsonResponse(upstreamBody) })}\n\n`,
        ]);
        sseHeaders(response, upstream.headers);
        adaptedSSE = true;
        await streamChat(stream, response, { includeUsage });
        return;
      }
      const result = streaming ? await collectResponse(decodedStream(upstreamBody)) : await readJsonResponse(upstreamBody);
      json(response, upstream.statusCode, chat ? responseToChat(result) : result, upstream.headers);
    } catch (error) {
      // pipeline may close the downstream before surfacing an adapter error.
      // Retain that explicit failure instead of labeling it a caller abort.
      if (error instanceof ProxyError) failure ??= error;
      if (controller.signal.aborted || response.destroyed) return;
      failure = error instanceof ProxyError ? error : new ProxyError(
        error.name === 'TimeoutError' ? 'Upstream operation timed out.' : 'The upstream connection or response failed.',
        error.name === 'TimeoutError' ? 504 : 502, 'upstream_connection_error');
      if (!response.headersSent) {
        if (!request.complete) response.setHeader('connection', 'close');
        if (failure.retryAfter) response.setHeader('retry-after', failure.retryAfter);
        request.resume();
        json(response, failure.status, errorBody(failure));
      } else if (adaptedSSE) {
        try { await writeSSE(response, errorBody(failure)); response.end(); }
        catch { response.destroy(); }
      } else response.destroy();
    } finally {
      clearTimeout(bodyTimer);
      if (upstream && !upstream.readableEnded) upstream.destroy();
      await flushed;
      clearTimeout(timer);
      if (admitted) active.delete(controller);
      if (draining) server.closeIdleConnections();
      request.off('aborted', cancel);
      response.off('close', cancel);
      if (observed) {
        const reason = failure ?? (controller.signal.aborted ? controller.signal.reason : null);
        const status = response.headersSent ? response.statusCode : reason?.status ?? 499;
        const outcome = ['request_timeout', 'body_timeout', 'downstream_timeout', 'upstream_timeout'].includes(reason?.code) ? 'timeout'
          : reason?.code === 'proxy_overloaded' ? 'rejected'
            : reason?.code === 'client_disconnected' ? 'cancelled'
              : reason || status >= 400 ? 'failed' : 'success';
        const duration = Math.round((performance.now() - start) * 100) / 100;
        metrics.finish(outcome, duration);
        logger.log('request_finished', { ...context, status, outcome, duration_ms: duration, active: active.size });
      }
    }
  }
  server.maxConnections = config.maxConnections;
  server.maxRequestsPerSocket = 1000;
  server.setTimeout(config.idleTimeoutMs);
  // Unsupported upgraded protocols must never leave untracked sockets alive.
  for (const event of ['connect', 'upgrade']) server.on(event, (_request, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.once('listening', () => readiness.start());
  server.checkReadiness = () => readiness.check();
  server.snapshot = () => ({ active: active.size, draining, counts: { ...metrics.counts }, ready: readiness.snapshot() });
  server.shutdown = () => {
    if (shuttingDown) return shuttingDown;
    draining = true;
    logger.log('shutdown_started', { active: active.size });
    shuttingDown = (async () => {
      const stoppingMonitor = readiness.stop();
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        for (const controller of active) controller.abort(new ProxyError('Server is draining.', 503, 'server_draining'));
        server.closeAllConnections();
      }, config.shutdownGraceMs);
      timer.unref();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...tasks]);
      clearTimeout(timer);
      await stoppingMonitor;
      agent.destroy();
      logger.log('shutdown_finished', { forced, active: active.size });
    })();
    return shuttingDown;
  };
  return server;
}
