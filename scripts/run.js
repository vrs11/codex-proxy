import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { managedNode, supportedRuntime } from '../runtime.js';

const binary = supportedRuntime() ? process.execPath : managedNode();
try {
  await access(binary);
  const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Cannot start the Node runtime. Run npm run runtime:install.'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
} catch {
  console.error('Node 24 LTS is required. Run npm run runtime:install, then repeat this command.');
  process.exitCode = 1;
}
