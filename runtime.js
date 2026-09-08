import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const NODE_VERSION = '24.20.0';

export function supportedRuntime(version = process.versions.node) {
  const [major, minor, patch] = version.split('.').map(Number);
  return major === 24 && (minor > 20 || (minor === 20 && patch >= 0));
}

export function managedNode(env = process.env) {
  const home = resolve(env.CODEX_PROXY_HOME || join(homedir(), '.codex-proxy'));
  return join(home, 'runtime', `node-v${NODE_VERSION}-${process.platform}-${process.arch}`, 'bin', 'node');
}
