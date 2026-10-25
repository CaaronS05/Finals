# F0 — Backend Foundation & CDP Architecture

Status: **IMPLEMENTED**. Offline suite green. Playwright CDP adapter **TESTED
against a live CloakBrowser** in F1 (2026-10-25).

This document describes the F0 foundation and the F1 live verification that
followed it. Section 6 records the compatibility evidence; section 11 records
the F1 live run.

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

Late-connect handling: winning the race does not stop the browser from attaching
afterwards. When the timeout wins, the manager detaches, and the in-flight
attach is marked abandoned. If that attach then lands, the transport releases
the session it just opened instead of registering it, so nothing survives the
abandoned `connect()`. `CdpConnection` never reports a late-landing session as
connected, and a second `disconnect()` is a no-op.

A late rejection needs no extra handling: `Promise.race` attaches a rejection
handler to every participant at construction, so the loser is already handled.
See section 11 for the correction of the earlier claim.

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
  several places because it attaches to a user's persistent browser. In
  playwright, `close()` on a CDP-attached browser detaches the transport only;
  the browser process, its tabs, and its session survive. This backend relies
  on that distinction and never terminates the browser.
- `playwright-core` installs with no bundled browser (~14 MB), so the
  dependency costs no browser toolchain.

**VERIFIED LIVE (F1, 2026-10-25):**

- A CloakBrowser instance accepted a real `connectOverCDP` attach on `9223`.
- Browser reported `Chrome/145.0.7632.109`, protocol `1.3`.
- Attach, disconnect, and reconnect all succeeded through the existing
  `CdpConnection` / `PlaywrightCdpTransport` pair.
- After detach the browser remained running, the endpoint stayed reachable,
  and no tab was created, closed, or navigated.
- No session handle remained owned by the backend after disconnect.

During F0, port `9223` was confirmed *closed* on the development machine,
which is why the adapter was then documented UNVERIFIED rather than TESTED.
F1 re-ran the same check with a browser running and recorded the result above.

## 7. Endpoint policy

`validateCdpEndpoint` rejects:

- the forbidden port `9222`,
- any non-loopback host,
- a non-absolute or non-`http(s)` URL.

`isPermittedCdpEndpoint` is the non-throwing form. Both live in
`cdp/endpoint.ts` so a caller cannot bypass the rule by constructing a URL
differently.

## 8. Test design

| File | Tests | Covers |
|---|---|---|
| `config.test.ts` | 13 | defaults, overrides, boundary ports, every rejection class, no cross-field leakage in messages |
| `http.test.ts` | 5 | payload shape, loopback bind, 404 route, 404 method, query-string tolerance |
| `cdp-connection.test.ts` | 16 | lazy start, connect, disconnect, idempotent detach, double-connect refusal, failure classification, timeout typing, timer cleanup, no secret leakage into messages |
| `cdp-endpoint.test.ts` | 9 | 9223 default, trailing-slash normalization, 9222 refusal, non-loopback refusal, malformed refusal, boolean helper, health with an unreachable CDP endpoint, startup without a browser |
| `cdp-late-connect.test.ts` | 7 | late-connect release after timeout, single detach, no unhandled rejection, reusability, session-slot hygiene |
| `cdp-failure-recovery.test.ts` | 8 | unreachable endpoint, refused connection, repeated connect/disconnect, in-flight refusal, no handle left owned, forbidden port 9222 |
| `live/cdp-live.test.ts` | 1 | real attach, state recognition, disconnect, reconnect, browser survival — armed only by `LIVE_CDP=1` |

All browser-dependent tests use `FakeCdpTransport`. The suite requires no
CloakBrowser, no network, no LP Agent, no Fabriq, no PostgreSQL, and no
production dataset. No test uses a wall-clock timer: a slow attach is parked
on a promise the test releases explicitly via `land()`, so timing assertions
are deterministic rather than guessed.

58 tests, all passing. The live test is excluded from `npm test` by glob
(`tests/*.test.ts`, not `tests/**/*.test.ts`) and runs only under
`npm run test:live`.

## 9. Verification record

Node v24.22.1, macOS, run from `backend/`:

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | no diagnostics |
| `npm run build` | 0 | emits `dist/` (11 modules) |
| `npm test` | 0 | 58 tests, 58 pass, 0 fail |
| `npm run test:live` (unarmed) | 0 | 1 test, 1 pass, 0 fail; no browser touched |
| `LIVE_CDP=1 npm run test:live` | 0 | 1 test, 1 pass, 0 fail; real attach verified |
| `node dist/server.js` + `curl /health` | 0 | `{"status":"ok","service":"dllm-backend"}` |
| `node dist/server.js` with port 9223 closed | 0 | server starts and serves; no CDP attempt |

## 10. F1 live run (2026-10-25)

Executed against a locally started CloakBrowser. The backend never launched,
terminated, or reconfigured it.

| Step | Result |
|---|---|
| Probe `GET /json/version` (read-only) | HTTP 200, `Chrome/145.0.7632.109`, protocol `1.3` |
| Read-only tab snapshot before attach | 1 target, `about:blank` |
| Real `connectOverCDP` attach | succeeded |
| Manager state after attach | `connected`, `isConnected() === true`, session info present with a non-empty browser version |
| Disconnect | succeeded |
| Manager state after disconnect | `disconnected`, session info `null` |
| Browser survival after disconnect | endpoint still HTTP 200, same browser version, same PID |
| Reconnect | succeeded |
| Final state | detached, browser alive, no session owned |
| Tabs created, closed, or navigated | none |
| Provider requests (LP Agent, Fabriq) | none |

The live test lives in `tests/live/cdp-live.test.ts` and is armed only by
`LIVE_CDP=1`. `npm test` cannot reach it: the glob is `tests/*.test.ts`, which
excludes the `live/` subdirectory. Unarmed, it reports that it did not run
rather than silently passing.

## 11. Corrected finding: `Promise.race` and unhandled rejections

The F0 correction commit added `attached.catch(() => {})` with a comment
claiming a losing promise in `Promise.race` would otherwise raise
`unhandledRejection` and could kill the process. That claim is **wrong**.

`Promise.race` attaches a rejection handler to every participant at the moment
it is constructed. A losing attach that rejects after the race has settled is
therefore already handled and never becomes an unhandled rejection. Verified
directly: a losing promise rejecting 100 ms after a 10 ms timeout produced no
`unhandledRejection` and the process survived.

The handler was harmless but misleading, so it was removed in F1. The
regression test that guards the behaviour was kept, with its rationale
corrected to state what `Promise.race` actually guarantees.

## 12. What F2 must do

1. Add the LP Agent connector behind the existing CDP boundary. It receives a
   `CdpConnection` and must not reach for a transport of its own.
2. The first LP Agent step is read-only observation: navigate a tab the user
   already has open, or open one explicitly, and record the observed page
   contract before writing extraction logic.
3. Live verification follows the F1 pattern: an opt-in test armed by an
   environment variable, never part of `npm test`, with cleanup in a `finally`
   block.
4. Any navigation or session interaction needs explicit approval, because F1
   verified attach and detach only — not that touching a page is safe for the
   user's session.

No scraping, ETL, database, or scan work is authorized in F2 until step 2
produces a recorded result.
