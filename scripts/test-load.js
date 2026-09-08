import http from 'node:http';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { saveCredentials } from '../credentials.js';
import { parseSSE } from '../sse.js';
import { Readable } from 'node:stream';
import { finalResponse, readRequest, sendJson, tokens, encodeSSE } from '../test/helpers.js';

// Isolated local mock only. This test never uses the user's login or live quota.
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf('--seconds') + 1] ?? 900);
if (args.length && (args[0] !== '--seconds' || args.length !== 2)) throw new Error('Usage: npm run test:load -- --seconds 900');
if (!Number.isInteger(seconds) || seconds < 5 || seconds > 86400) throw new Error('Duration must be 5–86400 seconds.');
const home = await mkdtemp(join(tmpdir(), 'codex-proxy-soak-'));
const limit = 4;
const started = performance.now();
const report = { timestamp: new Date().toISOString(), node: process.versions.node, target: 'isolated localhost mock',
  duration_seconds: seconds, concurrency_limit: limit, phases: [], samples: [], errors: [], counts: {}, upstream_peak: 0 };
let sequence = 0;
let upstreamActive = 0;
let child;
let base;
let exited;
let childFailure;
const upstream = http.createServer((req, res) => {
  void (async () => {
    if (req.url.startsWith('/models')) return sendJson(res, 200, { models: [{ slug: 'test-model' }] });
    if (req.url === '/oauth/token') {
      await readRequest(req);
      return sendJson(res, 200, tokens(Date.now(), '-renewed'));
    }
    const body = JSON.parse(await readRequest(req));
    upstreamActive++;
    report.upstream_peak = Math.max(report.upstream_peak, upstreamActive);
    res.once('close', () => { upstreamActive--; });
    const kind = body.metadata.test_case;
    if (kind === 'failure') return sendJson(res, 503, { error: { message: 'Simulated upstream outage.', code: 'mock_unavailable' } });
    if (kind === 'disconnect') return res.destroy();
    if (kind === 'timeout') return;
    const text = body.input[0].content[0].text;
    const response = finalResponse({ id: `resp_${body.metadata.sequence}` });
    response.output[0].content[0].text = text;
    const wire = encodeSSE([
      { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: text },
      { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
      { type: 'response.completed', response: { ...response, output: [] } },
    ]);
    if (kind === 'cancel') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting\n\n');
      await delay(100);
      if (!res.destroyed) res.end(wire);
    } else {
      await delay(15);
      if (res.destroyed) return;
      // Alternate native, inferred, and compressed SSE representations.
      const compressed = Number(body.metadata.sequence) % 3 === 0;
      res.writeHead(200, compressed ? { 'content-encoding': 'gzip' } : {});
      res.end(compressed ? gzipSync(wire) : wire);
    }
  })().catch(() => res.destroy());
});

function count(name) { report.counts[name] = (report.counts[name] ?? 0) + 1; }
function waitMessage(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker did not send ${type}.`)); }, 10_000);
    const listener = message => { if (message.type === type) { cleanup(); resolve(message); } };
    const onExit = () => { cleanup(); reject(new Error('Worker exited unexpectedly.')); };
    const cleanup = () => { clearTimeout(timer); child.off('message', listener); child.off('exit', onExit); };
    child.on('message', listener);
    child.once('exit', onExit);
  });
}
async function sample() {
  const pending = waitMessage('sample');
  child.send({ type: 'sample' });
  const result = await pending;
  report.samples.push({ elapsed_seconds: Math.round((performance.now() - started) / 1000), ...result });
  return result;
}
async function call(overloadPhase) {
  const id = ++sequence;
  const text = `soak-${id} 🌍`;
  const chat = id % 2 === 0;
  const kind = overloadPhase ? 'normal' : id % 101 === 0 ? 'timeout' : id % 53 === 0 ? 'disconnect'
    : id % 29 === 0 ? 'failure' : id % 23 === 0 ? 'cancel' : 'normal';
  const streaming = kind === 'cancel' || id % 4 < 2;
  const controller = new AbortController();
  const body = { model: 'test-model', stream: streaming, store: false, metadata: { test_case: kind, sequence: String(id) },
    ...(chat ? { messages: [{ role: 'user', content: text }] } : { instructions: '', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] }) };
  const begin = performance.now();
  try {
    const response = await fetch(`${base}/v1/${chat ? 'chat/completions' : 'responses'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
    if (response.status === 429) {
      assert.equal((await response.json()).error.code, 'proxy_overloaded');
      assert.equal(response.headers.get('retry-after'), '1');
      count('overload');
      return performance.now() - begin;
    }
    const expected = { failure: 503, disconnect: 502, timeout: 504 }[kind] ?? 200;
    assert.equal(response.status, expected);
    if (expected !== 200) { await response.json(); count(kind); return performance.now() - begin; }
    if (kind === 'cancel') {
      const reader = response.body.getReader();
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => {});
      count('cancel');
      return performance.now() - begin;
    }
    if (streaming) {
      let output = '';
      let completed = false;
      for await (const event of parseSSE(Readable.fromWeb(response.body))) {
        if (chat) {
          output += event.choices?.[0]?.delta?.content ?? '';
          completed ||= event.choices?.[0]?.finish_reason === 'stop';
        } else if (event.type === 'response.completed') {
          output = event.response.output[0].content[0].text;
          completed = true;
        }
      }
      assert.equal(output, text);
      assert.equal(completed, true);
    } else {
      const result = await response.json();
      assert.equal(chat ? result.choices[0].message.content : result.output[0].content[0].text, text);
    }
    count(`${chat ? 'chat' : 'responses'}_${streaming ? 'stream' : 'json'}`);
    return performance.now() - begin;
  } catch (error) {
    if (report.errors.length < 20) report.errors.push({ sequence: id, kind, message: error.message.slice(0, 200) });
    count('unexpected');
    return performance.now() - begin;
  }
}
async function phase(name, durationMs, clients) {
  const start = performance.now();
  const deadline = start + durationMs;
  const times = [];
  await Promise.all(Array.from({ length: clients }, async () => {
    while (performance.now() < deadline && !childFailure) {
      const duration = await call(name === 'overload');
      // Bounded sample reservoir; avoid making the load generator itself leak.
      if (times.length < 10_000) times.push(duration);
      await delay(name === 'overload' ? 5 : 10);
    }
  }));
  times.sort((a, b) => a - b);
  report.phases.push({ name, clients, elapsed_seconds: (performance.now() - start) / 1000,
    sample_count: times.length, p50_ms: times[Math.floor(times.length * 0.5)], p95_ms: times[Math.floor(times.length * 0.95)] });
}

let sampling;
try {
  await saveCredentials(home, { tokens: { ...tokens(), account_id: 'account-1' }, last_refresh: new Date().toISOString() });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  child = fork(join(root, 'scripts', 'load-worker.js'), [], { cwd: root, execArgv: ['--expose-gc', '--max-old-space-size=512'],
    env: { ...process.env, CODEX_PROXY_HOME: home, CODEX_PROXY_UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}`,
      CODEX_PROXY_AUTH_ISSUER: `http://127.0.0.1:${upstream.address().port}`,
      CODEX_PROXY_HOST: '127.0.0.1', CODEX_PROXY_PORT: '0', CODEX_PROXY_MAX_CONCURRENT: String(limit), CODEX_PROXY_MAX_CONNECTIONS: '64',
      CODEX_PROXY_REQUEST_TIMEOUT_MS: '1000', CODEX_PROXY_READINESS_INTERVAL_MS: '5000', CODEX_PROXY_SHUTDOWN_GRACE_MS: '1000',
      CODEX_PROXY_LOG_FILE: join(home, 'logs', 'proxy.jsonl'), CODEX_PROXY_LOG_MAX_BYTES: '65536', CODEX_PROXY_LOG_FILES: '2' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  exited = once(child, 'exit');
  child.on('exit', (code, signal) => { if (!report.stopping) childFailure = `Worker exited: ${code ?? signal}. ${stderr}`; });
  base = `http://127.0.0.1:${(await waitMessage('started')).port}`;
  await phase('warmup', 3000, limit);
  await sample();
  await phase('overload', Math.min(15_000, seconds * 1000 / 4), 12);
  sampling = (async () => {
    while (!report.stopSampling) {
      await delay(Math.min(30_000, seconds * 1000 / 3));
      if (report.stopSampling) break;
      const result = await sample();
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      assert.equal(health.status, 200);
      await health.json();
      console.log(`Soak ${Math.round((performance.now() - started) / 1000)}s: ${sequence} requests, ${Math.round(result.memory.rss / 1024 / 1024)} MiB RSS, ${report.counts.unexpected ?? 0} unexpected errors`);
    }
  })();
  await phase('soak', seconds * 1000, limit);
  report.stopSampling = true;
  await sampling;
  await delay(1200);
  const last = await sample();
  assert.equal(childFailure, undefined);
  assert.equal(report.counts.unexpected ?? 0, 0);
  assert.equal(last.state.active, 0);
  assert.equal(last.logs.failures, 0);
  assert.equal(last.logs.dropped, 0);
  assert.ok(report.counts.overload > 0);
  assert.ok(report.upstream_peak <= limit, `Upstream capacity exceeded: ${report.upstream_peak}`);
  for (const name of ['responses_json', 'responses_stream', 'chat_json', 'chat_stream', 'failure', 'disconnect', 'timeout', 'cancel']) assert.ok(report.counts[name] > 0, `${name} was not exercised`);
  const warm = report.samples[0].memory;
  report.retained_heap_growth_bytes = last.memory.heapUsed - warm.heapUsed;
  report.peak_rss_bytes = Math.max(...report.samples.map(value => value.memory.rss));
  assert.ok(report.retained_heap_growth_bytes < 32 * 1024 * 1024, 'Retained heap grew more than 32 MiB after warmup.');
  assert.ok(report.peak_rss_bytes < 512 * 1024 * 1024, 'Proxy RSS exceeded the 512 MiB test budget.');
  const files = await readdir(join(home, 'logs'));
  assert.ok(files.length <= 3);
  for (const file of files) assert.ok((await stat(join(home, 'logs', file))).size <= 65536);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  report.stopSampling = true;
  await sampling?.catch(() => {});
  report.stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  await rm(home, { recursive: true, force: true });
  report.elapsed_seconds = (performance.now() - started) / 1000;
  delete report.stopSampling;
  delete report.stopping;
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results', 'load-latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, elapsed_seconds: report.elapsed_seconds, counts: report.counts,
    peak_rss_bytes: report.peak_rss_bytes, retained_heap_growth_bytes: report.retained_heap_growth_bytes, failure: report.failure }, null, 2));
}
