import { join } from 'node:path';

export const SERVICE_LABEL = 'local.codex-proxy';

export function serviceEnvironment(config) {
  const names = {
    host: 'HOST', port: 'PORT', home: 'HOME', issuer: 'AUTH_ISSUER', upstream: 'UPSTREAM_URL', clientVersion: 'CLIENT_VERSION',
    maxBodyBytes: 'MAX_BODY_BYTES', idleTimeoutMs: 'IDLE_TIMEOUT_MS', maxConcurrent: 'MAX_CONCURRENT',
    maxConnections: 'MAX_CONNECTIONS', requestTimeoutMs: 'REQUEST_TIMEOUT_MS', bodyTimeoutMs: 'BODY_TIMEOUT_MS',
    headersTimeoutMs: 'HEADERS_TIMEOUT_MS', upstreamHeadersTimeoutMs: 'UPSTREAM_HEADERS_TIMEOUT_MS',
    shutdownGraceMs: 'SHUTDOWN_GRACE_MS', readinessIntervalMs: 'READINESS_INTERVAL_MS', readinessTimeoutMs: 'READINESS_TIMEOUT_MS',
    logMaxBytes: 'LOG_MAX_BYTES', logFiles: 'LOG_FILES',
  };
  return { NODE_ENV: 'production',
    ...Object.fromEntries(Object.entries(names).map(([key, name]) => [`CODEX_PROXY_${name}`, String(config[key])])),
    ...(config.reasoningEffortOverride ? { CODEX_PROXY_REASONING_EFFORT: config.reasoningEffortOverride } : {}),
    CODEX_PROXY_LOG_FILE: config.logFile || join(config.home, 'logs', 'proxy.jsonl'),
    CODEX_PROXY_NON_INTERACTIVE: '1',
  };
}

function xml(value) {
  return String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
}

export function launchdPlist({ node, directory, config }) {
  const args = [node, '--max-old-space-size=1024', join(directory, 'cli.js'), 'serve'];
  const environment = serviceEnvironment(config);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(directory)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([name, value]) => `<key>${name}</key><string>${xml(value)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>${Math.ceil(config.shutdownGraceMs / 1000) + 10}</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}
