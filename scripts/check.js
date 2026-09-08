import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { NODE_VERSION } from '../runtime.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
let count = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'test-results'].includes(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (entry.name.endsWith('.js')) { await run(process.execPath, ['--check', path]); count++; }
  }
}
await check(root);
for (const name of ['.node-version', '.nvmrc']) assert.equal((await readFile(join(root, name), 'utf8')).trim(), NODE_VERSION, `${name} must match the managed runtime pin.`);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.engines.node, `>=${NODE_VERSION} <25`);
console.log(`Syntax checks passed for ${count} JavaScript files.`);
