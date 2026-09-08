import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NODE_VERSION, managedNode } from '../runtime.js';

// Install an official, checksum-verified runtime without changing global Node.
const run = promisify(execFile);
const binary = managedNode();
const root = dirname(dirname(dirname(binary)));
const archiveName = `node-v${NODE_VERSION}-${process.platform}-${process.arch}.tar.gz`;
let temporary;
try {
  if (!['darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Use an official Node 24 LTS installation for this platform.');
  const present = await stat(binary).catch(() => null);
  if (present) {
    const { stdout } = await run(binary, ['--version']);
    if (stdout.trim() !== `v${NODE_VERSION}`) throw new Error('Installed runtime version does not match its directory.');
  } else {
    const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
    const download = async name => {
      const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
      if (!response.ok) throw new Error(`Official Node download failed (HTTP ${response.status}).`);
      return Buffer.from(await response.arrayBuffer());
    };
    const [archive, sums] = await Promise.all([download(archiveName), download('SHASUMS256.txt')]);
    const expected = sums.toString().split('\n').find(line => line.endsWith(`  ${archiveName}`))?.split(' ')[0];
    if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Official Node archive checksum mismatch.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    temporary = join(root, `.install-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    const path = join(temporary, archiveName);
    await writeFile(path, archive, { mode: 0o600 });
    await run('tar', ['-xzf', path, '-C', temporary]);
    await rename(join(temporary, archiveName.slice(0, -7)), dirname(dirname(binary)));
    await writeFile(join(root, 'verified-runtime.json'), `${JSON.stringify({ version: NODE_VERSION, archive: archiveName, sha256: expected, source: base })}\n`, { mode: 0o600 });
  }
  console.log(`Node ${NODE_VERSION} ready: ${binary}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
