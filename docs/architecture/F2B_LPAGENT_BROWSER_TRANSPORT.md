# F2-B — LP Agent Browser-Context Transport

Status: **IMPLEMENTED, TESTED OFFLINE**. The transport, the browser execution
boundary, and the owned-page lifecycle are implemented and covered by offline
tests. No live provider request and no live browser navigation occurred.

## 1. Status labels

| Component | Status |
|---|---|
| Browser execution boundary (`BrowserExecutor`) | IMPLEMENTED, TESTED OFFLINE |
| Owned-page tracker | IMPLEMENTED, TESTED OFFLINE |
| Request construction from confirmed contract | IMPLEMENTED, TESTED OFFLINE |
| HTTP status classification | IMPLEMENTED, TESTED OFFLINE |
| Timeout and network-failure handling | IMPLEMENTED, TESTED OFFLINE |
| Resource cleanup and double-dispose | IMPLEMENTED, TESTED OFFLINE |
| F2-A connector contracts | PRESERVED, UNCHANGED |
| Playwright executor adapter | IMPLEMENTED, UNVERIFIED LIVE |
| Live LP Agent acquisition | BLOCKED until F2-C |

## 2. Browser execution architecture

```
CDP infrastructure (F0/F1, unchanged)
  CdpConnection ── owns connect/disconnect, attach-only
  PlaywrightCdpTransport ── owns the browser handle

F2-B browser execution boundary
  BrowserExecutor ── executes ONE request in an existing context
  OwnedPageTracker ── creates and closes only DLLM pages
  PlaywrightBrowserExecutor ── the only playwright import in the connector tree

LP Agent domain (F2-A contracts, unchanged)
  LpAgentTransport.fetchPage(request) → SourceFetchResult
  LpAgentBrowserTransport ── implements LpAgentTransport over BrowserExecutor

LP Agent connector (F2-A, unchanged)
  acquirePoolPositions ── pagination, mapping, completeness
```

Responsibility split:

| Layer | Owns |
|---|---|
| `CdpConnection` | Connection lifecycle. Never touched by F2-B. |
| `PlaywrightBrowserExecutor` | Page creation, in-page fetch, page disposal. |
| `OwnedPageTracker` | Which pages DLLM owns, and closing exactly those. |
| `LpAgentBrowserTransport` | URL construction, headers, status classification, envelope mapping. |
| `LpAgentConnector` | Pagination, completeness, input validation. |

## 3. Playwright isolation

`BrowserExecutor` and `BrowserHttpRequest`/`BrowserHttpResponse` contain no
Playwright type. The only import of `playwright-core` inside
`src/connectors/lpagent/` is `playwright-executor.ts`. A test asserts that no
other connector source references playwright, the CDP boundary,
`connectOverCDP`, or a hardcoded provider URL.

Domain code therefore cannot reach `Page.evaluate`, `Page.goto`,
`BrowserContext.cookies`, or `Browser.close` even by accident.

## 4. Dedicated tab ownership

CloakBrowser is user-operated and holds a real session. The confirmed LP Agent
workflow depends on that ambient session (`credentials: "include"`), so the
request must run inside the user's browser context.

`OwnedPageTracker` rules:

- Only pages DLLM creates are recorded.
- A user tab is never matched, adopted, navigated, closed, or mutated.
- `acquirePage()` reuses an owned page that is still open, and creates one only
  when DLLM has none.
- `dispose()` closes owned pages only, is idempotent, and never throws.
- `dispose()` never closes the browser, terminates a process, or disconnects
  CDP.

Context selection is the caller's responsibility and fails closed: a fresh
incognito or isolated context does not carry the user's session, so the
executor requires an explicit `BrowserContext` from an already-attached
`CdpConnection`. F2-B does not guess which context to use.

## 5. HTTP request contract

Confirmed from Rahasia (`scripts/pool/scan-selected-pools.mjs:667-679`):

```
GET https://api.lpagent.io/api/v1/pools/{address}/top-lpers
    ?page={n}&pageSize=20&order_by=total_pnl_native&sort_order=desc
Accept: application/json
credentials: include
```

The transport builds exactly this. `buildTopLpersUrl` rejects a malformed
address before any URL exists, so bad input cannot reach the browser. The
address is interpolated verbatim, preserving case. Only
`https://api.lpagent.io` is permitted; any other origin is refused before a
request is constructed.

Only `Accept: application/json` is ever sent. No cookie, token,
`authorization` header, or session value is read, forwarded, or logged.

## 6. Status classification

| Condition | `reason` | `status` | Behaviour |
|---|---|---|---|
| 200 with a valid envelope | success | 200 | rows and pagination returned |
| 200 with malformed JSON | `MALFORMED_BODY` | 200 | failure, body not echoed |
| 200 with an empty body | `MALFORMED_BODY` | 200 | failure |
| 200 with a wrong envelope | `ENVELOPE` | 200 | failure |
| 401 | `HTTP_STATUS` | 401 | fail closed, operator action required |
| 403 | `HTTP_STATUS` | 403 | fail closed, operator action required |
| 429 | `HTTP_STATUS` | 429 | fail closed, `retry-after` preserved in the detail |
| 500/502/503 | `HTTP_STATUS` | status | failure, no automatic retry |
| Timeout | `TIMEOUT` | null | failure |
| Network failure | `TRANSPORT` | null | failure |
| After disposal | `TRANSPORT` | null | failure, no request executed |

No path returns success on an HTTP failure, and no path converts an error into
an empty page. An unreported numeric field becomes `null`, never `0`.

Retry is deliberately not implemented in F2-B. 401/403 require manual browser
action; 429 and 5xx need a bounded budget that belongs with the scan job, not
the transport. The transport reports the facts; a caller decides.

## 7. Timeout and cleanup

- `timeoutMs` is required and must be a positive finite number. Construction
  rejects `0`, negative, `NaN`, and `Infinity`.
- The in-page fetch uses an `AbortController` bounded by `timeoutMs`, matching
  the legacy pattern.
- `dispose()` is idempotent: the executor is disposed exactly once.
- After disposal, `fetchPage` returns a failure without executing anything.
- The owned page is reused across the pages of one acquisition and closed by
  `dispose()`, so a multi-page walk does not create and destroy a tab per page.
- The browser process is never terminated and CDP is never disconnected here.

## 8. Tests

`tests/lpagent-browser-transport.test.ts`, offline only:

- URL construction with confirmed parameters, and case preservation.
- Rejection of empty, padded, non-base58, and non-string addresses before any
  URL exists.
- Origin allowlist.
- Header, method, credential, and timeout transmission.
- No request on construction, import, or transport creation.
- 200 envelope parsing, unknown-field preservation, null-not-zero mapping.
- Full acquisition through the F2-A connector.
- 401/403 fail closed with an operator-action message.
- 429 with `retry-after` preserved.
- 500/502/503 classification.
- Malformed JSON, empty body, wrong envelope, non-array data.
- Timeout and network failure classification.
- No response header or body leaked into an error message.
- Owned-page cleanup, idempotent dispose, refusal after disposal, user page
  never touched.
- Double-dispose safety, and no request after disposal.
- Non-positive timeout rejection at construction.

Fixtures are synthetic. They contain no credentials, cookies, headers, browser
state, or production data. The browser is never attached during the test run.

## 9. What is unverified live

- That a live CloakBrowser context accepts page creation by this executor.
- That the in-context fetch against `api.lpagent.io` succeeds with the ambient
  session.
- The live response envelope, including whether `pagination.page` and
  `pagination.pageSize` are echoed.
- Cloudflare and rate-limit behaviour under a real walk.
- Whether a marker-tagged page survives across processes, since the marker is
  currently recorded in memory only.

## 10. F2-C prerequisites

1. An opt-in live test armed by an environment variable, following the F1
   pattern, excluded from `npm test`.
2. A live attach using `CdpConnection` plus `PlaywrightBrowserExecutor`, with
   cleanup in a `finally` block.
3. Verification that the owned page is created, used, and closed while every
   pre-existing user tab is unchanged.
4. A decision, with approval, on whether the request may navigate an owned page
   first, since F1 and F2-B verified attach and execution but never navigation.
5. A bounded retry budget for 429 and 5xx, and an operator-facing path for
   401/403.

No live acquisition is approved in F2-B.
