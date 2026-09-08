import { once } from 'node:events';
import { AuthManager } from './auth.js';
import { loadConfig } from './config.js';
import { acquireLease } from './credentials.js';
import { createProxyServer } from './server.js';
import { createLogger } from './observability.js';
import { supportedRuntime } from './runtime.js';

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (['--help', '-h', 'help'].includes(command)) {
    console.log('Usage: node cli.js [serve|login]\n\nserve: reuse saved login, or sign in before serving\nlogin: explicitly sign in using a device code\n\nConfiguration: CODEX_PROXY_PORT, CODEX_PROXY_HOME (see README.md).');
    return;
  }
  if (!['serve', 'login'].includes(command) || process.argv.length > 3) throw new Error('Usage: node cli.js [serve|login]');
  if (!supportedRuntime()) throw new Error('Use Node 24.20.0 or newer Node 24 LTS. Run npm run runtime:install, then npm start.');
  const config = loadConfig();
  const release = await acquireLease(config.home);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let server;
  let auth;
  const logger = createLogger(config);
  try {
    auth = new AuthManager(config);
    const loggedIn = command === 'login' ? false : await auth.load();
    if (!loggedIn) {
      if (config.nonInteractive) throw new Error('Saved login is required for service mode. Stop the service and run npm run login.');
      await auth.login(({ url, code }) => {
        console.log(`\nOpen ${url}\nEnter code: ${code}\n\nWaiting for authorization (expires in 15 minutes)...`);
      }, { signal: controller.signal });
      console.log('Login saved.');
    }
    if (command === 'login') return;
    controller.signal.throwIfAborted();
    server = createProxyServer(config, auth, { logger });
    server.listen(config.port, config.host);
    await once(server, 'listening');
    logger.log('server_started', { port: server.address().port, node: process.versions.node, limit: config.maxConcurrent });
    if (!config.nonInteractive) console.log(`Codex proxy listening at http://${config.host}:${server.address().port}/v1`);
    await new Promise(resolve => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener('abort', resolve, { once: true });
    });
  } catch (error) {
    logger.log('startup_failed', { code: typeof error.code === 'string' ? error.code : 'startup_error' });
    throw error;
  } finally {
    if (server) await server.shutdown();
    auth?.close();
    await auth?.refreshing?.catch(() => {});
    await logger.close();
    await release();
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

main().catch(error => {
  if (error.name === 'AbortError') return;
  // Service stderr may be retained by the supervisor. Do not put arbitrary
  // exception messages or authentication payloads there.
  if (process.env.CODEX_PROXY_NON_INTERACTIVE === '1') console.error('{"event":"startup_failed"}');
  else console.error(error.message);
  process.exitCode = 1;
});
