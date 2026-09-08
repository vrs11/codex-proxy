# Local Codex Proxy

A local Node.js server exposing OpenAI-compatible inference using your own persistent Codex device login. This repository contains the application code, tests, and package files.

## Start

Requires Node.js **24.20.0 or a newer Node 24 LTS patch**. The application is plain JavaScript and has no runtime npm dependencies or build step.

Run all commands in this README from the repository root—the directory containing `package.json`:

```bash
npm ci --ignore-scripts
npm start
```

With nvm, run `nvm install` first; `.nvmrc` pins the tested LTS release. Alternatively, `npm run runtime:install` uses an existing Node installation to download the official, SHA-256-verified Node 24.20.0 archive into the proxy's private home. It does not replace global Node. The start, login, test, and service scripts automatically select that runtime when global Node is unsupported. Installing npm dependencies is needed for SDK tests, not for serving.

On first startup, open the displayed URL and enter the device code. The server starts after authorization at **http://127.0.0.1:8787/v1**. Enable device-code login in your ChatGPT security settings or workspace permissions if your account requires it.

Subsequent starts reuse the saved login and refresh tokens automatically. To replace the login, stop the server and run:

```bash
npm run login
npm start
```

Credentials live in `~/.codex-proxy/auth.json`, separately from Codex's own login. The directory is mode `0700`, and the credential file is mode `0600`. Writes are atomic. One process may use a credential directory at a time, including the login and smoke commands. The process lock is released on normal shutdown; locks belonging to dead processes are reclaimed. Invalid locks require manual removal after confirming no proxy process is running.

The server binds to loopback by default. Callers share this account's access; there is no separate caller authentication. Host validation and browser-origin rejection prevent unrelated websites from using the account through a browser. Tokens and request/response bodies are not logged. Revoked or expired refresh credentials require another device login.

## Listen on the network

To bind all IPv4 interfaces:

```bash
CODEX_PROXY_HOST=0.0.0.0 npm start
```

For an installed macOS service, apply and persist the setting with:

```bash
CODEX_PROXY_HOST=0.0.0.0 npm run service -- install
```

Other machines use `http://<server-lan-ip>:8787/v1` as the API base URL. Local clients can continue using `http://127.0.0.1:8787/v1`. The bind address `0.0.0.0` is not a client destination. Host validation accepts the receiving interface's IP address; browser-origin requests remain disabled.

**Network access shares your account:** anyone who can reach the port can make API requests. Restrict access to trusted clients using your firewall or an authenticated gateway. Requests use plain HTTP, so use a private network or TLS termination when transmitting over an untrusted network.

## Unattended operation on macOS

After signing in, stop a foreground server and install the per-user launchd service:

```bash
npm run service -- install
npm run service -- status
```

The service runs with your user permissions, starts at user login, and automatically restarts after a crash. It uses the resolved Node LTS executable directly and never opens an interactive login flow. Graceful restart allows active requests 30 seconds to finish. A crash can interrupt those requests; clients decide whether to retry. A per-user LaunchAgent runs while that user is logged in; it does not provide service while the Mac is asleep or the user is logged out.

```bash
npm run service -- restart
npm run service -- stop
npm run service -- start
npm run service -- uninstall
```

`stop` stops the current instance; the installed agent still starts at the next user login. `uninstall` removes automatic startup and retains saved credentials and logs. The installer supports one proxy service per macOS user. Re-run `install` to apply changed environment settings, a new source location, or a new runtime path. Operational procedures are in [OPERATIONS.md](OPERATIONS.md).

## Capacity and monitoring

Four API requests may be active by default, including uploads, authentication waits, streaming, and slow downstream writes. Excess requests receive OpenAI-style HTTP `429`, code `proxy_overloaded`, and `Retry-After: 1`; there is no unbounded queue. API requests have a ten-minute total deadline, and stalled uploads and sockets have separate limits. Health endpoints do not consume API slots. Upstream connections are pooled with a fixed limit; readiness uses at most one additional connection.

| Endpoint | Meaning |
| --- | --- |
| `GET /health` | Process liveness; always inexpensive and independent of upstream. |
| `GET /ready` | HTTP 200 when cached authenticated model discovery is healthy; HTTP 503 while starting, draining, stale, or unavailable. |
| `GET /metrics` | Prometheus text with active requests, outcomes, durations, memory, readiness, and dropped/failed log writes. |

Readiness probes the account's model catalog every 30 seconds, with a five-second deadline and no generations. Requests to `/ready` read cached state rather than making more upstream calls. A cold connection can temporarily be unready; subsequent probes recover automatically. Readiness confirms authentication and discovery, not availability of every model or feature.

Service logs are JSON lines at `~/.codex-proxy/logs/proxy.jsonl`, mode `0600`, rotating at 10 MiB with five retained files. Logs include generated request IDs, upstream request IDs when supplied, endpoint names, status, outcome, attempts, and duration. The local ID is returned in `X-Codex-Proxy-Request-Id`; upstream `X-Request-Id` is preserved. Bodies, prompts, responses, models, query strings, and authentication headers are excluded. The logging queue is bounded and reports dropped records through metrics if storage cannot keep up.

## Connect clients

Set an OpenAI-compatible client's base URL to `http://127.0.0.1:8787/v1`. If it requires an API key, use any placeholder such as `local`; the proxy replaces upstream authentication with your saved login.

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKey: 'local',
  maxRetries: 0, // Choose retries explicitly in your caller, especially for generations.
});

const models = await client.models.list();
const model = models.data[0].id; // Or select an ID from the returned catalog.

const response = await client.responses.create({
  model,
  input: 'Say hello.',
  store: false,
});
console.log(response.output_text);

const stream = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'Say hello.' }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}
```

Both inference endpoints support regular JSON and SSE streaming.

## Compatibility and preservation

| Endpoint | Upstream behavior |
| --- | --- |
| `POST /v1/responses` | Calls Codex `/responses`, normalizing known incompatible options and retaining original bytes when no conversion is needed. |
| `POST /v1/chat/completions` | Converts Chat Completions into a streaming Responses request, then converts the result into the requested Chat Completions format. |
| `GET /v1/models` | Calls Codex `/models` with its client-version query parameter and converts its catalog into an OpenAI model list. |

**Responses passthrough:** Compatible request bodies, JSON replies, and SSE frames retain their original payload bytes, including unknown fields/events and whitespace. Upstream status and end-to-end headers are preserved unless adaptation affects their meaning. HTTP connection headers are regenerated, `Host` targets the upstream, and bearer/account headers come from saved credentials. Missing Codex `originator`, `version`, and user-agent headers receive compatibility defaults. Query strings are forwarded.

The tested Codex deployment omits `Content-Type` on SSE responses, so the proxy identifies the framing from a short prefix and supplies the media type. It also sends completed output items in `response.output_item.done` events while leaving the terminal response's `output` empty. The proxy fills that missing terminal output using those exact completed items, preserving order and their fields. Other SSE frames remain unchanged. This makes regular replies and the SDK's `responses.stream().finalResponse()` helper work. SSE compression is decoded to inspect and, when necessary, repair terminal events; compatible JSON compression remains untouched. Codex-specific error envelopes such as `{"detail":"..."}` become OpenAI error objects, retaining upstream status and details.

Only explicit upstream HTTP 400/422 validation rejections can trigger these bounded repairs, before generation has been accepted:

- Missing instructions → an empty instructions string.
- Missing `store` → `false` when required by the backend.
- String input → an equivalent user input item when the backend requires a list.
- Non-streaming or omitted `stream` → `true` when the backend explicitly requires streaming. The final Responses object becomes the caller's regular JSON reply.

The proxy does not retry successful generations, transport failures, rate limits, or unrelated validation errors. An upstream 401 permits one token refresh and request retry. It never adds an agent prompt, rewrites message text, executes tools, or changes model IDs. Unsupported optional settings are ignored before the first upstream call, as described below. For the smallest number of upstream attempts, Responses callers can supply `instructions:""`, `store:false`, and an array of input items. Use `stream:true` for fully native SSE delivery.

**Chat Completions mapping:** Supports system/developer/user/assistant messages, text, user image URLs/data URLs, function tools and tool-result messages, tool choice, parallel tool calls, structured output, reasoning effort, and verbosity. `reasoning_effort` becomes `reasoning.effort`, `verbosity` becomes `text.verbosity`, and `response_format` becomes `text.format`. These control aliases are also accepted on the Responses endpoint; native Responses controls take precedence there. Chat callers may also supply native `reasoning` and `text` controls; explicit Chat control aliases take precedence. Function argument strings remain unchanged. Tool schema strictness defaults to `false`, matching Chat Completions.

`CODEX_PROXY_REASONING_EFFORT` forces one reasoning effort for all Chat Completions and Responses requests, including streaming. It overrides both `reasoning_effort` and `reasoning.effort`, supplies the value when omitted, and preserves other reasoning options such as `summary`. Accepted values are `none`, `low`, `medium`, `high`, `xhigh`, and `max`; choose a value supported by the requested model. Unset or empty disables the override; `none` explicitly requests no reasoning. Invalid settings stop startup with a configuration error.

System messages are translated to `developer` messages on both inference endpoints because the Codex backend rejects the `system` role. Their content and position in the input are preserved, along with existing developer messages and native top-level instructions.

Legacy `functions` and `function_call` are translated into function tools and tool choice. Legacy assistant function calls and `role:"function"` results are paired with generated call IDs. Replies use the legacy `message.function_call`, streamed `delta.function_call`, and `finish_reason:"function_call"` format when the caller uses legacy function options. Parallel calls are disabled in that mode. Modern `tools` and `tool_choice` take precedence over their legacy counterparts.

**Ignored settings:** Both APIs omit `temperature`, `top_p`, all three token-limit names (`max_tokens`, `max_completion_tokens`, `max_output_tokens`), `stop`, `seed`, frequency/presence penalties, logit bias, logprob options, `metadata`, `user`, `safety_identifier`, `prompt_cache_retention`, and `prompt_cache_options`. Output-length limits, stop strings and other omitted settings are not enforced locally. Native `client_metadata` remains available on Responses; it does not replace stored OpenAI metadata. `prompt_cache_key` is supported. `service_tier:"auto"` is omitted so the backend chooses its default; other supplied tiers are forwarded. For GPT-5.6 models, reasoning effort `minimal` is mapped to `low`, which may use more reasoning than the original setting.

Chat returns one choice regardless of `n`. Unknown optional Chat fields, including message `name`/`reasoning_content`, are ignored. Unknown properties of supported function definitions are ignored, while the supplied JSON Schema is preserved. `stream_options` is ignored for non-streaming Chat requests; streaming supports its boolean `include_usage` field and ignores other options. Malformed messages, tool calls, schemas and supported control values can still produce validation errors.

Chat output includes text, refusals, function calls, URL citations, finish reasons, and token usage. Streaming sends role/text/tool deltas, an optional final usage chunk, and `[DONE]` only after successful or recognized incomplete completion. Output-token exhaustion maps to `length`; content filtering maps to `content_filter`. Malformed, failed, or interrupted adapted streams produce errors, never a fabricated successful completion. Responses-only reasoning items remain available through `/v1/responses`; Chat Completions has no equivalent reasoning-item field.

For converted model entries, `slug` becomes `id`, `object` is `model`, `owned_by` defaults to `openai`, and an unavailable creation timestamp is represented as `0`. The catalog is fetched from the account, not hardcoded.

**Boundaries:** This is an inference compatibility layer, not the entire OpenAI platform. `store:true` becomes `false`; `previous_response_id`, `conversation`, and `background` are ignored. Send complete conversation input on each turn: the proxy does not restore stored history or run background jobs. Optional `audio`, `modalities`, and `prediction` settings are ignored; Chat produces text and function calls. Unsupported input content still produces an error. Native Responses fields outside the known ignored options otherwise reach the backend unchanged, including future fields; backend restrictions may still apply. Use Responses for Codex-specific built-in tools and output types. WebSockets, uploads, audio generation, embeddings, and browser CORS integration are outside this version.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_PROXY_HOST` | `127.0.0.1` | Bind loopback, or `0.0.0.0` for all IPv4 interfaces. |
| `CODEX_PROXY_PORT` | `8787` | Local port; `0` chooses a free port. |
| `CODEX_PROXY_HOME` | `~/.codex-proxy` | Separate credentials and process lock. |
| `CODEX_PROXY_REASONING_EFFORT` | unset | Force reasoning effort on every inference request, overriding caller values. |
| `CODEX_PROXY_MAX_BODY_BYTES` | `33554432` | Maximum incoming body, including decoded size. |
| `CODEX_PROXY_IDLE_TIMEOUT_MS` | `300000` | Upstream socket inactivity timeout. |
| `CODEX_PROXY_MAX_CONCURRENT` | `4` | Active API request limit; excess callers receive 429. |
| `CODEX_PROXY_MAX_CONNECTIONS` | `64` | Total local TCP connection ceiling, including idle connections. |
| `CODEX_PROXY_REQUEST_TIMEOUT_MS` | `600000` | Total deadline including upload, auth, upstream and delivery. |
| `CODEX_PROXY_BODY_TIMEOUT_MS` | `30000` | Deadline for receiving the request body. |
| `CODEX_PROXY_HEADERS_TIMEOUT_MS` | `10000` | Deadline for receiving local request headers. |
| `CODEX_PROXY_UPSTREAM_HEADERS_TIMEOUT_MS` | `30000` | Deadline for upstream response headers. |
| `CODEX_PROXY_SHUTDOWN_GRACE_MS` | `30000` | Graceful shutdown deadline before active work is cancelled. |
| `CODEX_PROXY_READINESS_INTERVAL_MS` | `30000` | Interval between authenticated model-discovery probes. |
| `CODEX_PROXY_READINESS_TIMEOUT_MS` | `5000` | Deadline for each readiness probe. |
| `CODEX_PROXY_LOG_FILE` | stderr / service home `logs/proxy.jsonl` | Structured log destination. |
| `CODEX_PROXY_LOG_MAX_BYTES` | `10485760` | Maximum size of each log file before rotation. |
| `CODEX_PROXY_LOG_FILES` | `5` | Number of rotated log files retained, plus the active file. |
| `CODEX_PROXY_NON_INTERACTIVE` | unset / `1` in service | Require saved login instead of prompting. |
| `CODEX_PROXY_CLIENT_VERSION` | `0.153.4` | Codex compatibility version for headers and model discovery. |
| `CODEX_PROXY_UPSTREAM_URL` | `https://chatgpt.com/backend-api/codex` | Trusted upstream base URL. |
| `CODEX_PROXY_AUTH_ISSUER` | `https://auth.openai.com` | Trusted authentication issuer. |

URL overrides are for trusted deployments or local tests: your credentials are sent to them. HTTPS is required except for loopback HTTP. Standard Node.js TLS configuration, such as `NODE_EXTRA_CA_CERTS`, applies. No `.env` loader is used; export variables in your shell or service configuration.

For example, start a foreground proxy with a forced reasoning effort:

```bash
CODEX_PROXY_REASONING_EFFORT=high npm start
```

For the managed service, set this variable alongside your other desired `CODEX_PROXY_*` settings and run `npm run service -- install`. Installation snapshots the supplied environment, so include existing settings you want to retain, such as concurrency and host binding. A plain `restart` uses the previously installed settings. To remove the override, reinstall with `CODEX_PROXY_REASONING_EFFORT=` and the other settings retained.

Local HTTP headers are limited to 16 KiB. SSE frames/events are limited to 16 MiB; accumulated output items, adapted Chat output, and buffered upstream responses are limited to 64 MiB. Streaming proceeds event by event without waiting for the whole response. The managed runtime uses a 1 GiB V8 old-space ceiling; Buffers and native allocations sit outside that ceiling, so request/body/concurrency limits still matter. Increase capacity only after testing your intended payload sizes and concurrency.

Refresh requests are shared across concurrent callers. Temporary refresh failures use a five-to-sixty-second cooldown; permanent revocation requires login. Cancellation releases the caller's slot without cancelling a refresh needed by others. Rotated credentials are persisted with atomic rename and file/directory synchronization. If persistence fails, the new tokens remain in process memory and disk writes are retried before serving or rotating again.

## Verification

```bash
npm test
npm run check
npm audit --audit-level=high
```

The automated suite uses local mock auth/upstream servers and the official OpenAI Node SDK. It verifies login and process restart, token refresh and races, exact passthrough, gzip, immediate streaming, UTF-8/SSE boundaries, function calls, model listing, errors, cancellation, and slow consumers. It never contacts an actual account.

Run the isolated load and soak test with:

```bash
npm run test:load -- --seconds 900
```

It starts a separate proxy process and local mock upstream with synthetic credentials. It covers both APIs and response modes, twelve competing callers against four slots, sustained four-client traffic, compression, cancellations, simulated outages, disconnects, timeouts, memory measurements, log rotation, and recovery. It does not use your login or quota. Assertions check response integrity, capacity, drained requests, bounded retained memory, and logging. The report is `test-results/load-latest.json`.

To explicitly test the installed macOS service, including a deliberate crash and brief interruption:

```bash
npm run test:service -- --restart
```

This checks graceful restart, launchd crash recovery, stale-lock reclamation, and account discovery with the saved login. It writes `test-results/service-latest.json`. The service must be idle before this test.

The `.github` directory contains this repository's CI and weekly dependency-update configuration. CI runs syntax checks, automated tests, dependency auditing, and a short local load check on Linux and macOS. It does not run live account tests.

To test a server that is already running:

```bash
npm run test:live
```

This runs live SDK checks for both APIs, Unicode, regular/streaming output, the Responses stream helper, structured output, modern and legacy function-call round trips, images, three concurrent callers, cancellation, ignored settings, and error handling. It uses `gpt-5.4-mini` by default and makes small generations against your account. Set `CODEX_PROXY_TEST_MODEL` or `CODEX_PROXY_TEST_BASE_URL` to override the test model or server URL. Results are written to `test-results/live-latest.json`; the suite verifies that unsupported token limits and generation options no longer reject requests. See `TESTING.md` for the recorded validation and its scope.

For an explicit live check, stop the server, sign in, and run:

```bash
npm run login
npm run smoke
```

This uses your account for four small generations covering both inference APIs and both response modes, then restarts the server and checks saved authentication. It selects the first model in your account catalog; set `CODEX_PROXY_TEST_MODEL` to choose one. The smoke command requires dev dependencies installed by `npm install`. Mock test success does not establish availability or acceptance by the live Codex backend.

## Documentation

Protocol references: [OpenAI authentication](https://learn.chatgpt.com/docs/auth) and [Responses / Chat Completions differences](https://developers.openai.com/api/docs/guides/migrate-to-responses).

Operational guidance reviewed on 2026-09-08: [Node.js supported LTS releases](https://nodejs.org/en/about/previous-releases), [Node HTTP limits and shutdown](https://nodejs.org/api/http.html), [OpenAI request IDs](https://developers.openai.com/api/reference/overview), and [Apple per-user launchd services](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).
