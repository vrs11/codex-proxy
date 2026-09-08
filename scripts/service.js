import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../config.js';
import { loadCredentials, prepareHome } from '../credentials.js';
import { launchdPlist, SERVICE_LABEL, serviceEnvironment } from '../service-config.js';

const run = promisify(execFile);
const directory = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${SERVICE_LABEL}`;
const path = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const command = process.argv[2] ?? 'status';
const installed = async () => {
  try { return (await run('launchctl', ['print', target])).stdout; }
  catch (error) { if (/Could not find service|not found/i.test(error.stderr ?? '')) return null; throw error; }
};
async function stop() {
  const current = await installed();
  if (!current) return;
  const pid = Number(current.match(/^\s*pid = (\d+)$/m)?.[1]);
  await run('launchctl', ['bootout', target]);
  const deadline = Date.now() + config.shutdownGraceMs + 15_000;
  while (Date.now() < deadline) {
    let alive = false;
    if (pid) {
      try { process.kill(pid, 0); alive = true; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!alive && !await installed()) return;
    await delay(100);
  }
  throw new Error('Timed out waiting for the service to stop.');
}
async function start() {
  // bootout can return before launchd has released its job registration.
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await run('launchctl', ['bootstrap', domain, path]); return; }
    catch (error) {
      if (attempt === 29 || !/Bootstrap failed: 5:/.test(error.stderr ?? '')) throw error;
      await delay(200);
    }
  }
}

try {
  if (process.platform !== 'darwin') throw new Error('This service installer targets macOS launchd. Run npm start under your platform supervisor elsewhere.');
  if (command === 'install') {
    if (config.port === 0) throw new Error('A managed service requires a fixed CODEX_PROXY_PORT.');
    if (!await loadCredentials(config.home)) throw new Error('Run npm run login before installing the service.');
    await prepareHome(config.home);
    const body = launchdPlist({ node: await realpath(process.execPath), directory, config });
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temp, body, { mode: 0o600, flag: 'wx' });
      await run('plutil', ['-lint', temp]);
      await stop();
      await rename(temp, path);
    } finally { await unlink(temp).catch(() => {}); }
    await writeFile(join(config.home, 'service.json'), `${JSON.stringify({ label: SERVICE_LABEL, environment: serviceEnvironment(config) }, null, 2)}\n`, { mode: 0o600 });
    await run('launchctl', ['enable', target]);
    await start();
    console.log(`Installed and started ${SERVICE_LABEL}. Logs: ${serviceEnvironment(config).CODEX_PROXY_LOG_FILE}`);
  } else if (command === 'start') {
    if (!await installed()) await start();
    console.log('Service started.');
  } else if (command === 'stop') {
    await stop();
    console.log('Service stopped. It will start again at the next user login unless uninstalled.');
  } else if (command === 'restart') {
    await stop();
    await start();
    console.log('Service restarted after draining active requests.');
  } else if (command === 'uninstall') {
    await stop();
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(join(config.home, 'service.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    console.log('Service removed. Saved login and logs retained.');
  } else if (command === 'status') {
    const state = await installed();
    if (!state) { console.log('Service is stopped or not installed.'); process.exitCode = 1; }
    else {
      for (const name of ['state', 'pid', 'runs', 'last exit code']) {
        const match = state.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'));
        if (match) console.log(`${name} = ${match[1]}`);
      }
      const saved = JSON.parse(await readFile(join(config.home, 'service.json'), 'utf8'));
      const port = saved.environment.CODEX_PROXY_PORT;
      const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(6000) });
      const body = await response.json();
      console.log(`Readiness: ${body.ready ? 'ready' : body.reason}`);
      if (!response.ok) process.exitCode = 1;
    }
  } else throw new Error('Usage: npm run service -- install|start|stop|restart|status|uninstall');
} catch (error) {
  // launchctl errors can include the entire service environment; never dump it.
  console.error(error.stderr ? `Service operation failed: ${String(error.stderr).split('\n')[0]}` : error.message);
  process.exitCode = 1;
}
