# Validation record — 2026-09-08

Release **1.0.0** passed the functional and operational checks for the intended single-user localhost deployment. The installed macOS LaunchAgent runs on **Node 24.20.0 LTS**.

| Verification | Result |
| --- | --- |
| Automated tests (`npm test`) | **52 passed, 0 failed** |
| Live functional checks (`npm run test:live`) | 17 passed, 0 failed |
| Syntax and runtime-pin checks (`npm run check`) | 33 JavaScript files passed; runtime pins consistent |
| Real OAuth token refresh | Passed on Node 24 LTS |
| Reload of refreshed credentials from disk | Passed |
| Credential file permissions | `0600` |
| Server restart using saved credentials | Passed; no device login requested |
| Graceful supervised restart | Passed; readiness recovered in 1,059 ms |
| Automatic restart after deliberate SIGKILL | Passed; readiness recovered in 10,255 ms |
| Stale-lock recovery and account discovery after crash | Passed without device login |
| Isolated load and soak run | **105,120 requests; 0 unexpected errors** |
| Sustained four-client soak phase | **900.2 seconds**, following warmup and a 12-client overload phase |
| Peak simultaneous mock upstream API requests | **4**, matching admission capacity |
| Peak sampled proxy RSS | **220.4 MiB** |
| Retained heap change after warmup | **−31,296 bytes** after garbage collection |
| Active requests after load drained | **0** |
| Dropped logs / failed log writes during soak | **0 / 0** |
| Log rotation and retention limits | Passed |
| Reproducible dependency installation | `npm ci --ignore-scripts` passed |
| Dependency audit | **0 reported vulnerabilities**; no production npm dependencies |

The final service was running and ready at `http://127.0.0.1:8787/v1` after verification. Live checks used the official OpenAI Node SDK 7.10.0 and `gpt-5.4-mini` from the account's catalog. Credential, service configuration and launchd manifest files were mode `0600`.

Evidence: [live API checks](test-results/live-latest.json), [load and memory samples](test-results/load-latest.json), [supervisor recovery](test-results/service-latest.json), [real authentication refresh](test-results/auth-latest.json), and [release source checksums](test-results/source-sha256.json). These generated reports contain operational results and synthetic identifiers, not account credentials or user prompts, and are ignored by Git.

## Operational coverage

Tests verify admission over a stream's entire lifetime, immediate 429 responses with `Retry-After`, monitoring during saturation, stalled uploads, absolute deadlines despite continuing SSE heartbeats, cancellation during shared authentication, graceful draining, forced shutdown, cached readiness and recovery, private metadata-only logs, bounded logging queues, rotation, Host/origin checks, and oversized SSE frames.

Authentication tests additionally cover temporary-failure cooldown and failed persistence after token rotation. New tokens remain in memory and are saved before another refresh occurs. Real refresh and reloading those tokens were verified under an exclusive process lease. Supervisor tests use the installed launchd service, deliberately kill its process, and verify recovery with saved login.

## Load and soak workload

The test uses a separate proxy process, synthetic credentials, and a local mock upstream. A 12-client saturation phase competes for four API slots, followed by 15 minutes of sustained four-client traffic. It validates unique Unicode output through both APIs and both response modes, including inferred media types, compressed SSE, and compact terminal output.

| Scenario | Count |
| --- | ---: |
| Responses streaming | 21,225 |
| Responses regular JSON | 21,254 |
| Chat streaming | 21,269 |
| Chat regular JSON | 21,217 |
| Caller cancellation attempts | 3,720 |
| Simulated upstream 503 responses | 3,056 |
| Simulated upstream disconnects | 1,705 |
| Simulated request timeouts | 903 |
| Expected local overload rejections | 10,771 |
| **Total** | **105,120** |

Cancellation can race with a completed response; the report separately records actual cancellations and completed requests. Expected errors are checked and counted separately from unexpected failures. Assertions cover drained capacity, bounded memory, log retention, and continued health. Memory samples come from the proxy process after explicit garbage collection; RSS is sampled rather than a continuous maximum.

## Live coverage

- Account model discovery and process health.
- Regular JSON and SSE responses through both inference APIs, including Unicode.
- The SDK's `responses.stream().finalResponse()` helper and complete terminal output.
- Strict JSON-schema output through both APIs.
- Function-call/result round trips through both APIs and streamed function arguments.
- Image input through both APIs, using a generated red PNG fixture.
- Three concurrent independent callers, with separate response IDs and correct results.
- Client cancellation followed by continued service availability.
- Invalid models, unsupported options, malformed JSON, incorrect media types, and unknown endpoints.
- Explicit upstream rejection of output-limit parameters, returned with an OpenAI error envelope.

## Issues found and corrected

The first live run exposed SSE replies without `Content-Type`; these had been mistaken for JSON. The proxy now infers the framing from a short prefix and supplies the missing media type.

The backend also sent completed items in separate events while leaving the terminal response's `output` array empty. The proxy now restores that output from the exact completed items, in index order. This fixes regular replies, Chat Completions, and the SDK final-response helper. Other SSE frames retain their payload bytes. Compressed SSE is decoded for inspection and repair.

Codex errors using a `detail` field and missing JSON media types are now presented as OpenAI error objects. Existing standard error payloads remain intact. Each behavior has regression coverage.

## Observed limits and scope

The tested backend rejects `max_output_tokens` with HTTP 400. Its Chat Completions aliases, `max_tokens` and `max_completion_tokens`, consequently fail explicitly. They are never silently omitted. Incomplete-generation handling is covered by mocks; the live output-limit path is an unsupported-parameter error.

Automated coverage additionally includes expiry/revocation, refresh races, byte preservation, compression, split SSE/UTF-8 boundaries, malformed and truncated streams, slow consumers, connection failures, timeouts, and process locking.

Live inference coverage is for one account and one model. The isolated 15-minute soak establishes behavior for its fixture workload; real upstream throughput, multi-day operation, every model variant, and maximum-size payload combinations are outside these measurements. API endpoints and features excluded in the README remain unsupported. Operating and recovery procedures are in [OPERATIONS.md](OPERATIONS.md).

Hardening also corrected a launchd stop/start registration race, a complete SSE frame bypassing its size check, and native adapter failures being misclassified after streaming headers were sent. Regression and operational tests passed after those fixes.

CI configuration is provided for Linux and macOS when this product folder is the repository root. Hosted CI itself was not executed in this local workspace. Runtime and action versions were checked against current official release sources; dependency auditing is a point-in-time result.

## Repeat the checks

The network-binding follow-up adds `CODEX_PROXY_HOST=0.0.0.0` while retaining the loopback default. **54 automated tests and syntax checks passed** after this change, including connections through loopback and this machine's IPv4 interfaces, service-setting persistence, and continued rejection of unrelated Host headers and browser origins. The live and soak evidence above records the earlier localhost deployment; its stored source checksums describe that snapshot. Network exposure requires the access controls described in the README.

With the server running, execute from this directory:

```bash
npm test
npm run check
npm audit --audit-level=high
npm run test:load -- --seconds 900
npm run test:live
```

The live suite uses the account for small generations and overwrites its JSON report. It does not stop the server or rotate credentials directly. The separate `npm run smoke` command owns and restarts its own server, so an existing server must be stopped before using that command.

To repeat disruptive supervisor verification on an idle installed service, run `npm run test:service -- --restart`.
