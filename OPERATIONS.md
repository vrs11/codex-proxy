# Operating the local proxy

The supported production deployment is one trusted user on localhost, with macOS launchd supervising the process. The proxy is an inference adapter for the Codex backend; it is not a public or multi-tenant OpenAI service. OpenAI-compatible features and explicit exclusions are listed in the README.

## Install and control

Use Node 24.20.0 or a later Node 24 LTS patch. `npm run runtime:install` installs the pinned official runtime privately without changing the machine's global Node. `npm start` requires no npm runtime dependencies and performs device login if needed. Stop it with Ctrl-C before installing the service:

```bash
npm run service -- install
npm run service -- status
```

The launchd manifest is `~/Library/LaunchAgents/local.codex-proxy.plist`. The service's saved environment is in `~/.codex-proxy/service.json`. Both are private files. Credentials are separate in `auth.json` and never copied into the manifest. The source directory must remain at its installed path; reinstall after moving it.

The service starts at user login and restarts after crashes, with a ten-second restart throttle. Stop or restart through the service command so requests can drain; sending a signal directly to its process permits launchd to restart it. `npm run service -- uninstall` disables future automatic startup without deleting credentials.

## Monitor

```bash
curl --fail http://127.0.0.1:8787/health
curl --fail http://127.0.0.1:8787/ready
curl --fail http://127.0.0.1:8787/metrics
tail -f ~/.codex-proxy/logs/proxy.jsonl
```

Use `/health` for process liveness and `/ready` for cached upstream discovery. `/ready` can initially return 503 until a probe succeeds. Treat failures across three consecutive probe intervals as sustained unavailability; a single probe can time out during connection establishment. No health endpoint performs an LLM generation.

| Readiness reason | Action |
| --- | --- |
| `starting` | Wait for the initial model-discovery probe. |
| `ok` | Saved authentication and the model catalog are available. |
| `login_required` | Stop the service, complete device login, then start it again. |
| `credentials_not_saved` | Restore free disk space and write access to the credential directory while retaining the running process if possible. |
| `auth_unavailable` | The auth service is temporarily unavailable; refresh uses a bounded cooldown. |
| `rate_limited` | Respect account limits and reduce caller activity. |
| `upstream_unavailable` | Check network access and upstream availability; the next probe retries discovery. |
| `stale` | No recent successful probe completion is available; inspect process health and logs. |
| `draining` | Shutdown is in progress. |

Metrics use fixed labels and contain no request content. `codex_proxy_requests_total` separates successful HTTP/adapter completion, overload rejections, failures, cancellations, and timeouts. It does not inspect the semantic correctness of model output. Durations cover the request's entire local lifetime; `/metrics` itself is excluded. Counters reset on process restart.

Monitor readiness, memory, overload/timeouts, and `codex_proxy_log_dropped_total` / `codex_proxy_log_failures_total`. Increasing overload generally calls for less caller concurrency, longer spacing between requests, or a tested capacity change. Health endpoints bypass API admission, but the total TCP connection ceiling applies to all connections.

Logs contain one completion record per API request, including the response's `X-Codex-Proxy-Request-Id` and an upstream request ID if provided. An adapter error after streaming headers can retain HTTP status 200 while recording outcome `failed`; the connection or SSE error tells the caller that delivery failed. Never enable request-body logging to troubleshoot this service. Use IDs, times, endpoint names and status instead.

Each log file is bounded to 10 MiB by default, with one active and five rotated files (about 60 MiB maximum). Record buffers are also bounded. Storage errors do not turn successful model responses into failures; logging metrics expose the loss. If the process cannot start, `startup_failed` includes an operational error code in the log; `launchctl print gui/$(id -u)/local.codex-proxy` exposes supervisor state. Service stdout/stderr are discarded to avoid unbounded secondary logs or crash dumps containing sensitive state.

## Recover authentication

```bash
npm run service -- stop
npm run login
npm run service -- start
npm run service -- status
```

Device login is the only interactive step. Normal restarts use the saved credentials. Refresh tokens rotate: never run another proxy process, another login, or the standalone smoke test against the same credential directory while the service is running. The process lease enforces this.

Credential writes are private, atomic and synchronized to disk. When a write fails after refresh, the process retains the rotated tokens and retries saving them before permitting more requests. Restore storage before restarting if possible: stopping while the only copy of a rotated token remains in memory can require device login again. A power failure, revoked authorization or lost credentials can also require login.

A stale lock owned by a dead process is reclaimed automatically. An incomplete lock, reused PID, or interrupted lock-reclamation guard may require manual recovery. Stop the managed service and any foreground proxy first, then verify that no other proxy uses that home before removing only `process.lock` and, if present, `process.lock.stale`. Keep `auth.json` intact. Do not remove a live process's lock.

## Capacity, timeouts and callers

Defaults are four active API requests, 64 local connections, 32 MiB incoming bodies, 16 MiB incoming SSE events, and 64 MiB accumulated adapter output. The supervised V8 old-space ceiling is 1 GiB, not a total RSS limit. Large JSON parsing and Buffers need additional memory. The recorded soak test uses small representative protocol fixtures; run another with your application's expected large payloads before increasing limits.

The local header deadline is ten seconds, upload deadline thirty seconds, upstream-header deadline thirty seconds, idle deadline five minutes, and total admitted-request deadline ten minutes. Streaming activity does not bypass the total deadline. Once SSE headers have been sent, a deadline closes the connection rather than manufacturing a successful completion. Caller disconnects cancel upstream work. Graceful shutdown waits thirty seconds before cancelling remaining requests and closing connections.

HTTP 429 with `proxy_overloaded` and `Retry-After: 1` comes from local admission. Upstream rate-limit status and headers pass through. Callers should apply an explicit retry policy with jitter; do not automatically replay an interrupted generation unless your application accepts potentially duplicated generation. This proxy retries only a bounded authentication recovery and recognized pre-generation validation repairs.

To change service settings, export the documented `CODEX_PROXY_*` variables and run `npm run service -- install` again. Installation snapshots settings; later shell exports do not modify a running service. Use fixed ports. URL overrides receive account credentials and must point to a trusted upstream. The service installer deliberately inherits only documented proxy settings, not arbitrary shell environment. Custom TLS trust should be configured and reviewed explicitly in the launchd environment.

## Update and verify

Keep the source and lockfile under version control. Preserve `auth.json` separately and never commit it. Use `npm ci --ignore-scripts` for reproducible SDK/test dependency installation; there are no production npm dependencies. CI and Dependabot configuration are provided under `.github` for a repository rooted in this product folder. CI execution itself has not been performed in this local workspace.

Before deploying an update:

```bash
npm run check
npm test
npm audit --audit-level=high
npm run test:load -- --seconds 900
```

Restart the service, check readiness, and run `npm run test:live` to validate the real backend. To repeat disruptive supervisor verification on an idle service, run `npm run test:service -- --restart`. Live tests use a small amount of account quota. The isolated load test uses only a local mock and synthetic credentials; it cannot establish upstream rate capacity or multi-model compatibility.

Review supported Node releases and security updates regularly. Runtime version pins are in `runtime.js`, `.node-version`, `.nvmrc`, and the minimum `engines.node` in `package.json`; update them together, install the new runtime, run checks, and reinstall the service to change its executable. Update SDK and action pins through reviewed dependency changes. Codex backend changes may require compatibility fixes even when this proxy's code is unchanged.

Rollback by stopping the service, restoring the previously validated source and lockfile, then reinstalling or starting the service with the intended LTS runtime. Retain the newest saved credentials; restoring old refresh tokens can invalidate authentication.
