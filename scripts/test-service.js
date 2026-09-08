import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../config.js';
import { SERVICE_LABEL } from '../service-config.js';

// Explicitly disruptive verification of this application's installed service.
if (process.argv[2] !== '--restart') throw new Error('This check restarts the local service. Use npm run test:service -- --restart.');
if (process.platform !== 'darwin') throw new Error('Service verification requires macOS launchd.');
const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
const saved = JSON.parse(await readFile(join(config.home, 'service.json'), 'utf8'));
assert.equal(saved.label, SERVICE_LABEL);
const base = `http://127.0.0.1:${saved.environment.CODEX_PROXY_PORT}`;
const target = `gui/${process.getuid()}/${SERVICE_LABEL}`;
const run = promisify(execFile);
const report = { timestamp: new Date().toISOString(), node: process.versions.node, checks: [] };
async function pid() {
  const text = (await run('launchctl', ['print', target])).stdout;
  return Number(text.match(/^\s*pid = (\d+)$/m)?.[1]);
}
async function waitReady(previous) {
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    try {
      const current = await pid();
      const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2000) });
      if (current && current !== previous && response.ok && (await response.json()).ready) {
        const owner = Number((await readFile(join(config.home, 'process.lock'), 'utf8')).split(':')[0]);
        assert.equal(owner, current);
        return { pid: current, recovery_ms: Date.now() - start };
      }
      await response.body?.cancel();
    } catch { /* Allow the supervisor and readiness probe time to recover. */ }
    await delay(500);
  }
  throw new Error('Service did not become ready within 90 seconds.');
}
try {
  const before = await waitReady();
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /^codex_proxy_active_requests 0$/m, 'Wait for current callers to finish before restart testing.');
  await run(process.execPath, [join(root, 'scripts', 'service.js'), 'restart'], { cwd: root });
  const graceful = await waitReady(before.pid);
  report.checks.push({ name: 'graceful restart with saved login', passed: true, ...graceful });
  console.log(`Graceful restart passed; ready in ${graceful.recovery_ms} ms.`);
  await run('launchctl', ['kill', 'SIGKILL', target]);
  const recovered = await waitReady(graceful.pid);
  report.checks.push({ name: 'automatic restart and stale-lock recovery after SIGKILL', passed: true, ...recovered });
  console.log(`Crash recovery passed; ready in ${recovered.recovery_ms} ms.`);
  const catalog = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(catalog.status, 200);
  assert.ok((await catalog.json()).data.length > 0);
  report.checks.push({ name: 'account catalog after crash recovery without device login', passed: true });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results', 'service-latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Service checks ${report.passed ? 'passed' : `failed: ${report.failure}`}.`);
}
