import { ProxyError } from './errors.js';

// Cancelling one caller must not cancel a refresh shared by other callers.
export function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class Readiness {
  constructor(config, auth, probe, logger) {
    Object.assign(this, { config, auth, probe, logger });
    this.state = { ready: false, reason: 'starting', checked_at: null };
    this.stopped = false;
    this.pending = null;
  }

  snapshot() {
    if (this.stopped) return { ...this.state, ready: false, reason: 'draining' };
    const authState = this.auth.status?.();
    if (authState && !authState.ready) return { ...this.state, ready: false, reason: authState.reason };
    if (this.state.checked_at && Date.now() - Date.parse(this.state.checked_at) > this.config.readinessIntervalMs * 2 + this.config.readinessTimeoutMs) {
      return { ...this.state, ready: false, reason: 'stale' };
    }
    return { ...this.state };
  }

  check() {
    if (this.stopped) return Promise.resolve(this.snapshot());
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.config.readinessTimeoutMs)]);
    this.pending = (async () => {
      let reason = 'ok';
      try { await withSignal(this.probe(signal), signal); }
      catch (error) {
        reason = error.code === 'login_required' || error.status === 401 ? 'login_required' : error.status === 429 ? 'rate_limited' : 'upstream_unavailable';
      }
      const next = { ready: reason === 'ok', reason, checked_at: new Date().toISOString() };
      if (next.reason !== this.state.reason) this.logger.log('readiness_changed', { ready: next.ready, reason });
      this.state = next;
      return this.snapshot();
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  start() {
    if (!this.config.readinessIntervalMs) return;
    const tick = async () => {
      await this.check();
      if (!this.stopped) { this.timer = setTimeout(tick, this.config.readinessIntervalMs); this.timer.unref(); }
    };
    void tick();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller?.abort(new ProxyError('Server is draining.', 503, 'server_draining'));
    await this.pending;
  }
}
