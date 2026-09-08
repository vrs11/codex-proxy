import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

const fields = new Set(['request_id', 'upstream_request_id', 'route', 'method', 'status', 'outcome',
  'duration_ms', 'attempts', 'active', 'limit', 'port', 'node', 'code', 'ready', 'reason', 'forced']);

// Only explicitly allowed operational metadata can enter logs. No bodies,
// headers, query strings, model names, error messages, or credentials.
export function createLogger(config, { output = process.stderr } = {}) {
  let file;
  let size = 0;
  let pending = 0;
  let chain = Promise.resolve();
  let closed = false;
  let dropped = 0;
  let failures = 0;
  async function write(line) {
    if (!config.logFile) {
      if (output.writableLength > 256 * 1024 || output.destroyed) { dropped++; return; }
      output.write(line);
      return;
    }
    if (!file) {
      await mkdir(dirname(config.logFile), { recursive: true, mode: 0o700 });
      file = await open(config.logFile, 'a', 0o600);
      await file.chmod(0o600);
      size = (await file.stat()).size;
    }
    if (size + Buffer.byteLength(line) > config.logMaxBytes) {
      await file.close();
      file = null;
      await unlink(`${config.logFile}.${config.logFiles}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
      for (let i = config.logFiles - 1; i >= 0; i--) {
        await rename(i ? `${config.logFile}.${i}` : config.logFile, `${config.logFile}.${i + 1}`)
          .catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      file = await open(config.logFile, 'a', 0o600);
      size = 0;
    }
    await file.writeFile(line);
    size += Buffer.byteLength(line);
  }
  return {
    log(event, values = {}) {
      if (closed || pending >= 1024) { dropped++; return; }
      const record = { time: new Date().toISOString(), event };
      for (const [key, value] of Object.entries(values)) {
        if (!fields.has(key)) continue;
        if (typeof value === 'string') record[key] = value.slice(0, 160).replace(/[^\x20-\x7e]/g, '?');
        else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) record[key] = value;
      }
      const line = `${JSON.stringify(record)}\n`;
      pending++;
      chain = chain.then(() => write(line)).catch(async () => {
        failures++;
        await file?.close().catch(() => {});
        file = null;
        if (failures === 1 && !output.destroyed && output.writableLength < 256 * 1024) output.write('{"event":"log_write_failed"}\n');
      }).finally(() => { pending--; });
    },
    snapshot: () => ({ dropped, failures, pending }),
    async flush() { await chain; },
    async close() {
      closed = true;
      await chain;
      if (file) { await file.sync().catch(() => {}); await file.close(); file = null; }
    },
  };
}

export const quietLogger = { log() {}, snapshot: () => ({ dropped: 0, failures: 0, pending: 0 }) };

export class Metrics {
  constructor() {
    this.started = performance.now();
    this.counts = { success: 0, rejected: 0, failed: 0, cancelled: 0, timeout: 0 };
    this.duration = 0;
    this.peak = 0;
  }

  finish(outcome, duration) { this.counts[outcome]++; this.duration += duration / 1000; }

  render({ active, limit, ready, logger }) {
    const values = {
      codex_proxy_active_requests: active,
      codex_proxy_concurrency_limit: limit,
      codex_proxy_peak_active_requests: this.peak,
      codex_proxy_ready: Number(ready),
      codex_proxy_uptime_seconds: (performance.now() - this.started) / 1000,
      codex_proxy_resident_memory_bytes: process.memoryUsage().rss,
      codex_proxy_heap_used_bytes: process.memoryUsage().heapUsed,
      codex_proxy_request_duration_seconds_sum: this.duration,
      codex_proxy_request_duration_seconds_count: Object.values(this.counts).reduce((a, b) => a + b, 0),
      codex_proxy_log_dropped_total: logger.snapshot().dropped,
      codex_proxy_log_failures_total: logger.snapshot().failures,
    };
    return Object.entries(values).map(([name, value]) => `${name} ${value}\n`).join('')
      + Object.entries(this.counts).map(([outcome, value]) => `codex_proxy_requests_total{outcome="${outcome}"} ${value}\n`).join('');
  }
}
