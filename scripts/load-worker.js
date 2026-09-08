import { AuthManager } from '../auth.js';
import { loadConfig } from '../config.js';
import { acquireLease } from '../credentials.js';
import { createLogger } from '../observability.js';
import { createProxyServer } from '../server.js';

if (!process.send) throw new Error('This worker is started by test-load.js.');
const config = loadConfig();
const release = await acquireLease(config.home);
const auth = new AuthManager(config);
await auth.load();
const logger = createLogger(config);
const server = createProxyServer(config, auth, { logger });
server.listen(0, config.host, () => process.send({ type: 'started', port: server.address().port }));
process.on('message', message => {
  if (message.type === 'sample') {
    global.gc?.();
    process.send({ type: 'sample', memory: process.memoryUsage(), state: server.snapshot(),
      resources: process.getActiveResourcesInfo(), logs: logger.snapshot() });
  }
});
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await server.shutdown();
    auth.close();
    await logger.close();
    await release();
    if (process.connected) process.disconnect();
  })();
  return stopping;
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('disconnect', stop);
