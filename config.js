import { homedir } from 'node:os';
import { resolve } from 'node:path';

function integer(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return result;
}

function baseUrl(value, name) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS base URL (HTTP is allowed only for local tests).`);
  }
  return url.href.replace(/\/$/, '');
}

export function loadConfig(env = process.env) {
  const config = {
    host: env.CODEX_PROXY_HOST ?? '127.0.0.1',
    port: integer(env.CODEX_PROXY_PORT, 8787, 0, 65535, 'CODEX_PROXY_PORT'),
    home: resolve(env.CODEX_PROXY_HOME || `${homedir()}/.codex-proxy`),
    issuer: baseUrl(env.CODEX_PROXY_AUTH_ISSUER || 'https://auth.openai.com', 'CODEX_PROXY_AUTH_ISSUER'),
    upstream: baseUrl(env.CODEX_PROXY_UPSTREAM_URL || 'https://chatgpt.com/backend-api/codex', 'CODEX_PROXY_UPSTREAM_URL'),
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    clientVersion: env.CODEX_PROXY_CLIENT_VERSION || '0.153.4',
    maxBodyBytes: integer(env.CODEX_PROXY_MAX_BODY_BYTES, 32 * 1024 * 1024, 1024, 1024 ** 3, 'CODEX_PROXY_MAX_BODY_BYTES'),
    idleTimeoutMs: integer(env.CODEX_PROXY_IDLE_TIMEOUT_MS, 300_000, 1000, 3600_000, 'CODEX_PROXY_IDLE_TIMEOUT_MS'),
    maxConcurrent: integer(env.CODEX_PROXY_MAX_CONCURRENT, 4, 1, 64, 'CODEX_PROXY_MAX_CONCURRENT'),
    maxConnections: integer(env.CODEX_PROXY_MAX_CONNECTIONS, 64, 8, 1024, 'CODEX_PROXY_MAX_CONNECTIONS'),
    requestTimeoutMs: integer(env.CODEX_PROXY_REQUEST_TIMEOUT_MS, 600_000, 1000, 3600_000, 'CODEX_PROXY_REQUEST_TIMEOUT_MS'),
    bodyTimeoutMs: integer(env.CODEX_PROXY_BODY_TIMEOUT_MS, 30_000, 1000, 300_000, 'CODEX_PROXY_BODY_TIMEOUT_MS'),
    headersTimeoutMs: integer(env.CODEX_PROXY_HEADERS_TIMEOUT_MS, 10_000, 1000, 30_000, 'CODEX_PROXY_HEADERS_TIMEOUT_MS'),
    upstreamHeadersTimeoutMs: integer(env.CODEX_PROXY_UPSTREAM_HEADERS_TIMEOUT_MS, 30_000, 1000, 300_000, 'CODEX_PROXY_UPSTREAM_HEADERS_TIMEOUT_MS'),
    shutdownGraceMs: integer(env.CODEX_PROXY_SHUTDOWN_GRACE_MS, 30_000, 1000, 300_000, 'CODEX_PROXY_SHUTDOWN_GRACE_MS'),
    readinessIntervalMs: integer(env.CODEX_PROXY_READINESS_INTERVAL_MS, 30_000, 5000, 300_000, 'CODEX_PROXY_READINESS_INTERVAL_MS'),
    readinessTimeoutMs: integer(env.CODEX_PROXY_READINESS_TIMEOUT_MS, 5000, 1000, 30_000, 'CODEX_PROXY_READINESS_TIMEOUT_MS'),
    logFile: env.CODEX_PROXY_LOG_FILE ? resolve(env.CODEX_PROXY_LOG_FILE) : null,
    logMaxBytes: integer(env.CODEX_PROXY_LOG_MAX_BYTES, 10 * 1024 * 1024, 1024, 100 * 1024 * 1024, 'CODEX_PROXY_LOG_MAX_BYTES'),
    logFiles: integer(env.CODEX_PROXY_LOG_FILES, 5, 1, 20, 'CODEX_PROXY_LOG_FILES'),
    nonInteractive: env.CODEX_PROXY_NON_INTERACTIVE === '1',
  };
  if (!['127.0.0.1', '0.0.0.0'].includes(config.host)) throw new Error('CODEX_PROXY_HOST must be 127.0.0.1 or 0.0.0.0.');
  if (config.headersTimeoutMs > config.bodyTimeoutMs) throw new Error('CODEX_PROXY_HEADERS_TIMEOUT_MS must not exceed CODEX_PROXY_BODY_TIMEOUT_MS.');
  if (config.maxConnections < config.maxConcurrent + 4) throw new Error('CODEX_PROXY_MAX_CONNECTIONS must leave at least four connections beyond CODEX_PROXY_MAX_CONCURRENT for monitoring.');
  return config;
}
