# F0 — Backend Foundation & CDP Architecture

Status: **IMPLEMENTED**. Test suite green. Playwright CDP adapter **UNVERIFIED**
against a live CloakBrowser.

## 1. Module boundaries

```
src/server.ts            entrypoint: load config → start HTTP → exit-safe
   │
   ├── config.ts         pure function: env map → validated BackendConfig
   │                      throws ConfigError on any malformed value
   │
   ├── errors.ts         typed hierarchy, sanitized messages
   │                      BackendError → ConfigError
   │                                   → CdpUnavailableError
   │                                   → CdpConnectTimeoutError
   │                                   → CdpDisconnectedError
   │                                   → CdpOperationError
   │
   ├── http/server.ts    createBackendHttpServer(config) → BackendServer
   │                      routes: GET /health only. No CDP, no provider, no FS.
   │
   └── cdp/
       ├── connection.ts        CdpConnection (lifecycle) + FakeCdpTransport
       ├── endpoint.ts          validateCdpEndpoint / isPermittedCdpEndpoint
       └── playwright-transport.ts  PlaywrightCdpTransport (real adapter)
```

Dependency direction is strictly downward. `http/` knows `cdp/` exists but
never instantiates it. `cdp/` knows nothing about HTTP.

## 2. Configuration boundary

`loadConfig(env)` is pure and total. Every field is validated:

| Field | Rule | Rejected examples |
|---|---|---|
| `host` | loopback only | `0.0.0.0`, `203.0.113.9` |
| `port` | `/^\d+$/`, `1`–`65535` | `8788abc`, ` 8788 `, `8788.5`, `0`, `65536` |
| `cdpEndpoint` | absolute `http(s)://`, loopback host | `ftp://…`, `127.0.0.1:9223`, `http://10.0.0.5:9223` |
| `cdpConnectTimeoutMs` | `/^\d+$/`, `>= 0` | `-1`, `1e4` |

Values are **not** trimmed before validation. A padded value is a mistake, and
trimming would hide it. Trailing slashes are normalized off the CDP endpoint
only, because that value is used to build URLs.

Failure mode: `ConfigError` carrying the offending `field`. The entrypoint
prints the sanitized message and exits with code 1. No server is started on a
configuration the operator did not intend.

## 3. HTTP boundary

`createBackendHttpServer(config)` returns `{ server, listening, close }`.
Listening is separated from construction so tests bind an ephemeral port
(`port: 0`) and the production entrypoint binds the configured one.

- Binds `config.host` only. Loopback enforcement happens in config, not here.
- One route: `GET /health` → `{ "status": "ok", "service": "dllm-backend" }`.
- Everything else is `404` with a JSON error body.
- No route touches the browser, a provider, or the filesystem.
- `server.on("error")` logs the sanitized form; a raw error can contain a
  local filesystem path.

## 4. Browser lifecycle

```
disconnected ──connect()──► connecting ──ok──► connected
     ▲                          │                  │
     │                          │ fail             │ disconnect()
     └──────────clean───────────┴──────────────────┘
```

Rules enforced by `CdpConnection`:

1. **Lazy.** A session exists only between an explicit `connect()` and the
   matching `disconnect()`. Construction performs no transport work.
2. **Single.** A second `connect()` while connected throws `CdpOperationError`.
   Concurrent attempts throw as well.
3. **Clean on failure.** Any connect failure resets the manager to
   `disconnected` and clears the session, so the instance stays reusable.
4. **Idempotent detach.** `disconnect()` on a never-connected manager is a
   no-op that performs no transport call.
5. **Best-effort detach.** A throwing transport `disconnect()` is swallowed;
   the manager is already logically disconnected, and masking the original
   error would be worse.
6. **Guarded operations.** `requireSession()` throws `CdpNotConnectedError`
   when no session is live.

Timeout handling: `Promise.race([attach, timeout])` with the timer always
cleared in `finally`. `timeoutMs: 0` disables the timeout and skips the race.

Error normalization happens once, at the boundary. A raw transport failure
becomes `CdpUnavailableError` whose message contains the endpoint and a
sanitized reason. The original error is kept as `cause` for local debugging
and is never serialized into a response or an external log.

## 5. Transport seam

```ts
interface CdpTransport {
  connect(options: CdpConnectOptions): Promise<CdpSessionInfo>;
  disconnect(): Promise<void>;
}
```

Two implementations:

- `FakeCdpTransport` — in-memory, configurable delay and failure. Used by the
  whole CDP test suite. Opens no socket, imports no browser library.
- `PlaywrightCdpTransport` — real attach via `playwright-core`
  `chromium.connectOverCDP(endpoint, { timeout, isLocal: true })`.

The seam is what makes the tests browser-free: the manager's lifecycle logic
is tested against a fake, and the real adapter is a separate, unexercised unit
until F1.

## 6. CloakBrowser compatibility status

**VERIFIED (by reading legacy sources, Rahasia repository):**

- `playwright-core` is the CDP client library. Confirmed at
  `scripts/lpagent/scrape-smart-lp.mjs`,
  `scripts/discovery/core/fabriq-position-history.ts`,
  `scripts/fabriq/enrich-wallets.mjs`,
  `scripts/pool/scan-selected-pools.mjs`,
  `scripts/pool-scanner-v1.mjs`.
- The call form is `chromium.connectOverCDP("http://127.0.0.1:9223")`, with an
  optional `{ timeout }`.
- Port `9223` is the CloakBrowser convention; port `9222` (legacy Brave) is
  treated as a security violation and refused.
- Attach semantics: the legacy code deliberately avoids `browser.close()` in
  several places because it attaches to a user's persistent browser.
- `playwright-core` installs with no bundled browser (~14 MB), so the
  dependency costs no browser toolchain.

**UNVERIFIED:**

- That a CloakBrowser instance currently accepts a CDP attach on `9223`. No
  live probe was performed in F0. Port 9223 was confirmed *closed* on the
  development machine during F0 testing, which is why the adapter is
  documented UNVERIFIED rather than TESTED.

## 7. Endpoint policy

`validateCdpEndpoint` rejects:

- the forbidden port `9222`,
- any non-loopback host,
- a non-absolute or non-`http(s)` URL.

`isPermittedCdpEndpoint` is the non-throwing form. Both live in
`cdp/endpoint.ts` so a caller cannot bypass the rule by constructing a URL
differently.

## 8. Test design

| File | Covers |
|---|---|
| `config.test.ts` | defaults, overrides, boundary ports, every rejection class, no cross-field leakage in messages |
| `http.test.ts` | payload shape, loopback bind, 404 route, 404 method, query-string tolerance |
| `cdp-connection.test.ts` | lazy start, connect, disconnect, idempotent detach, double-connect refusal, failure classification, timeout typing, timer cleanup, no secret leakage into messages |
| `cdp-endpoint.test.ts` | 9223 default, trailing-slash normalization, 9222 refusal, non-loopback refusal, malformed refusal, boolean helper, health with an unreachable CDP endpoint, startup without a browser |

All browser-dependent tests use `FakeCdpTransport`. The suite requires no
CloakBrowser, no network, no LP Agent, no Fabriq, no PostgreSQL, and no
production dataset.

43 tests, all passing.

## 9. Verification record

Node v24.22.1, macOS, run from `backend/`:

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | no diagnostics |
| `npm run build` | 0 | emits `dist/` (10 modules) |
| `npm test` | 0 | 43 tests, 43 pass, 0 fail |
| `node dist/server.js` + `curl /health` | 0 | `{"status":"ok","service":"dllm-backend"}` |
| `node dist/server.js` with port 9223 closed | 0 | server starts and serves; no CDP attempt |

## 10. What F1 must do

1. Start CloakBrowser locally and probe `http://127.0.0.1:9223/json/version`.
2. Run a real `PlaywrightCdpTransport` attach and record the outcome.
3. If attach succeeds, promote the adapter from UNVERIFIED to TESTED and add a
   live-marked test that is skipped by default.
4. If attach fails, diagnose (browser build, CDP flags, port) before any
   scraping code is written.

No scraping, ETL, database, or scan work is authorized in F1 until step 2
produces a recorded result.
