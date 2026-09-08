import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function prepareHome(home) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
}

export async function saveCredentials(home, credentials) {
  await prepareHome(home);
  const temporary = join(home, `.auth-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, join(home, 'auth.json'));
    // Make the rename durable before acknowledging successful token rotation.
    const directory = await open(home, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function loadCredentials(home) {
  try {
    const file = await open(join(home, 'auth.json'), 'r');
    let credentials;
    try {
      if ((await file.stat()).size > 1024 * 1024) throw new Error('Credential file is too large.');
      await file.chmod(0o600);
      credentials = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (!['access_token', 'refresh_token', 'id_token', 'account_id'].every(key => typeof credentials.tokens?.[key] === 'string' && credentials.tokens[key])) {
      throw new Error('Missing access or refresh token.');
    }
    return credentials;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read the proxy credential file. Run npm run login to replace it.');
  }
}

// Hold a process lease for both login and serve, preventing token rotation races
// between two proxy processes. A dead process's lease can be reclaimed.
export async function acquireLease(home) {
  await prepareHome(home);
  const path = join(home, 'process.lock');
  const owner = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(owner); } finally { await file.close(); }
      return async () => {
        if (await readFile(path, 'utf8').catch(() => null) === owner) await unlink(path).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readFile(path, 'utf8').catch(() => null);
      if (existing === null) continue;
      const pid = Number(existing.split(':')[0]);
      // Empty/incomplete lock files can belong to a process still acquiring it.
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process lock: ${path}. Remove it only after stopping all proxy processes.`);
      try {
        process.kill(pid, 0);
        throw new Error('Another proxy process is using this credential directory. Stop it before logging in or starting another server.');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      // Reclamation arbitration prevents contenders deleting a newly created lease.
      const stale = `${path}.stale`;
      let guard;
      try { guard = await open(stale, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      try {
        if (await readFile(path, 'utf8').catch(() => null) === existing) await unlink(path);
      } finally { await guard.close(); await unlink(stale).catch(() => {}); }
    }
  }
  throw new Error('Could not acquire the proxy process lock. Another process may be starting.');
}
