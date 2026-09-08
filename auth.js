import { setTimeout as sleep } from 'node:timers/promises';
import { loadCredentials, saveCredentials } from './credentials.js';
import { ProxyError } from './errors.js';

function claims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

export class AuthManager {
  constructor(config, { fetchImpl = fetch, now = Date.now, sleepImpl = sleep, loginTimeoutMs = 15 * 60_000, saveImpl = saveCredentials } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleepImpl;
    this.loginTimeoutMs = loginTimeoutMs;
    this.credentials = null;
    this.refreshing = null;
    this.permanentFailure = null;
    this.save = saveImpl;
    this.lifetime = new AbortController();
    this.retryAt = 0;
    this.refreshFailures = 0;
    this.unsaved = false;
  }

  async load() {
    this.credentials = await loadCredentials(this.config.home);
    return Boolean(this.credentials);
  }

  async post(path, body, { form = false, signal } = {}) {
    return this.fetch(`${this.config.issuer}${path}`, {
      method: 'POST',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      redirect: 'error',
    });
  }

  async persist(tokens) {
    if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) {
      throw new ProxyError('Authentication returned incomplete credentials.', 502, 'invalid_auth_response');
    }
    const account = claims(tokens.id_token)['https://api.openai.com/auth'] ?? {};
    const accountId = account.chatgpt_account_id ?? tokens.account_id;
    if (!accountId || typeof accountId !== 'string') {
      throw new ProxyError('Authentication did not return a ChatGPT account ID.', 502, 'invalid_auth_response');
    }
    const previous = this.credentials?.tokens.account_id;
    if (previous && previous !== accountId) throw new ProxyError('Token refresh changed accounts. Run npm run login.', 401, 'login_required');
    const credentials = {
      auth_mode: 'chatgpt',
      tokens: { ...tokens, account_id: accountId },
      last_refresh: new Date(this.now()).toISOString(),
    };
    this.credentials = credentials;
    this.unsaved = true;
    await this.flushCredentials();
    this.permanentFailure = null;
    this.transientFailure = null;
    this.retryAt = 0;
    this.refreshFailures = 0;
  }

  async flushCredentials() {
    if (!this.unsaved) return;
    if (this.saving) return this.saving;
    this.saving = this.save(this.config.home, this.credentials).then(() => { this.unsaved = false; })
      .catch(() => { throw new ProxyError('Cannot persist refreshed credentials. Check available disk space and credential-directory permissions.', 503, 'credentials_persistence_failed'); });
    try { await this.saving; } finally { this.saving = null; }
  }

  status() {
    if (!this.credentials || this.permanentFailure) return { ready: false, reason: 'login_required' };
    if (this.unsaved) return { ready: false, reason: 'credentials_not_saved' };
    if (this.now() < this.retryAt) return { ready: false, reason: 'auth_unavailable' };
    return { ready: true, reason: 'ok' };
  }

  close() { this.lifetime.abort(); }

  async login(onCode, { signal } = {}) {
    const response = await this.post('/api/accounts/deviceauth/usercode', { client_id: this.config.clientId }, { signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 404
        ? 'Device login is unavailable. Enable device-code login in your ChatGPT security or workspace settings.'
        : `Device login request failed (HTTP ${response.status}).`);
    }
    const device = await response.json();
    const code = device.user_code ?? device.usercode;
    if (!code || !device.device_auth_id) throw new Error('Device login returned an invalid code response.');
    const interval = Math.max(1, Number(device.interval) || 5) * 1000;
    const deadline = this.now() + this.loginTimeoutMs;
    await onCode({ url: `${this.config.issuer}/codex/device`, code });
    while (this.now() < deadline) {
      signal?.throwIfAborted();
      const poll = await this.post('/api/accounts/deviceauth/token', {
        device_auth_id: device.device_auth_id, user_code: code,
      }, { signal });
      if (poll.ok) {
        const grant = await poll.json();
        if (!grant.authorization_code || !grant.code_verifier) throw new Error('Device login returned an invalid authorization grant.');
        const exchange = await this.post('/oauth/token', {
          grant_type: 'authorization_code', code: grant.authorization_code,
          redirect_uri: `${this.config.issuer}/deviceauth/callback`,
          client_id: this.config.clientId, code_verifier: grant.code_verifier,
        }, { form: true, signal });
        if (!exchange.ok) {
          await exchange.body?.cancel();
          throw new Error(`Device token exchange failed (HTTP ${exchange.status}).`);
        }
        const tokens = await exchange.json();
        this.credentials = null; // An explicit login may select a different account.
        await this.persist(tokens);
        return;
      }
      await poll.body?.cancel();
      if (![403, 404].includes(poll.status)) throw new Error(`Device authorization failed (HTTP ${poll.status}).`);
      await this.sleep(Math.min(interval, Math.max(0, deadline - this.now())), undefined, { signal });
    }
    throw new Error('Device authorization expired. Run npm run login to try again.');
  }

  needsRefresh() {
    const expiry = claims(this.credentials.tokens.access_token).exp;
    if (typeof expiry === 'number') return expiry * 1000 <= this.now() + 5 * 60_000;
    const last = Date.parse(this.credentials.last_refresh);
    return !Number.isFinite(last) || last < this.now() - 8 * 24 * 3600_000;
  }

  async headers() {
    if (!this.credentials) throw new ProxyError('Sign in with npm run login first.', 401, 'login_required');
    if (this.permanentFailure) throw this.permanentFailure;
    await this.flushCredentials();
    if (this.now() < this.retryAt) throw this.transientFailure;
    if (this.needsRefresh()) await this.refresh();
    const { tokens } = this.credentials;
    const headers = { authorization: `Bearer ${tokens.access_token}`, 'chatgpt-account-id': tokens.account_id };
    if (claims(tokens.id_token)['https://api.openai.com/auth']?.chatgpt_account_is_fedramp) headers['x-openai-fedramp'] = 'true';
    return headers;
  }

  async refresh(rejectedAuthorization) {
    if (this.permanentFailure) throw this.permanentFailure;
    if (!this.credentials) throw new ProxyError('Sign in with npm run login first.', 401, 'login_required');
    await this.flushCredentials();
    if (this.now() < this.retryAt) throw this.transientFailure;
    if (rejectedAuthorization && rejectedAuthorization !== `Bearer ${this.credentials.tokens.access_token}`) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.performRefresh().catch(error => {
      if (this.permanentFailure || this.lifetime.signal.aborted) throw error;
      const failure = error instanceof ProxyError ? error : new ProxyError('Authentication service is unavailable. Try again later.', 503, 'auth_unavailable');
      const delay = Math.min(60_000, 5000 * 2 ** Math.min(this.refreshFailures++, 4));
      this.retryAt = this.now() + delay;
      failure.retryAfter = Math.ceil(delay / 1000);
      this.transientFailure = failure;
      throw failure;
    });
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  async performRefresh() {
    const response = await this.post('/oauth/token', {
      client_id: this.config.clientId, grant_type: 'refresh_token',
      refresh_token: this.credentials.tokens.refresh_token,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const code = typeof body.error === 'string' ? body.error : body.error?.code ?? body.code;
      const permanent = response.status === 401 || ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(code);
      const error = new ProxyError(permanent ? 'Your login has expired or was revoked. Run npm run login.'
        : `Token refresh failed (HTTP ${response.status}). Try again later.`, permanent ? 401 : 503,
      permanent ? 'login_required' : 'auth_unavailable');
      if (permanent) this.permanentFailure = error;
      throw error;
    }
    const refreshed = await response.json();
    if (!refreshed.access_token) throw new ProxyError('Token refresh returned no access token.', 503, 'invalid_auth_response');
    const tokens = { ...this.credentials.tokens };
    for (const key of ['id_token', 'access_token', 'refresh_token']) {
      if (typeof refreshed[key] === 'string' && refreshed[key]) tokens[key] = refreshed[key];
    }
    await this.persist(tokens);
  }
}
