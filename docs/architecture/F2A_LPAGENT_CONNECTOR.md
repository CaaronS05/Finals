# F2-A — LP Agent Connector Foundation

Status: **IMPLEMENTED**. Contracts, validation, mapping, and pagination
bookkeeping are typed and tested offline. No provider request, navigation, or
browser lifecycle exists in this phase.

## 1. Scope

F2-A builds the architecture required to acquire LP Agent pool data in F2-B
(transport) and F2-C (live pagination and acquisition).

| Implemented in F2-A | Deferred |
|---|---|
| Pool address input contract, case-preserving | Provider request execution |
| Typed data contracts from legacy evidence | Browser-context transport |
| Response mapping with unknown-field preservation | Live pagination protocol |
| Transport-independent pagination bookkeeping | Pool discovery execution |
| Typed, normalized connector errors | PostgreSQL schema, ETL |
| Connector orchestrator with injectable transport | Full Scan orchestration |
| Fixture-based offline tests | Fabriq enrichment |

## 2. Legacy workflow evidence

All facts below were read from the local Rahasia repository. Rahasia was not
modified. File and line citations are exact.

### 2.1 Entrypoints

| File | Role |
|---|---|
| `scripts/pool/scan-selected-pools.mjs:951-1100` | Primary multi-worker selected-pool scraper |
| `scripts/pool-scanner-v1.mjs:500-803` | Legacy single-threaded scanner |
| `scripts/lpagent/scrape-smart-lp.mjs:753-1492` | Smart LP discovery scraper |
| `scripts/pool/discover-token-pools.mjs:5-120` | Meteora pool discovery helper |
| `scripts/browser/launch-cloak.mjs:19-70` | CDP port constants and health checks |
| `scripts/bench/rate-limiter.mjs:1-55` | Concurrency and backoff limiter |
| `scripts/pipeline/atomic-json-write.ts:1-40` | Atomic JSON write helper |

### 2.2 Browser and CDP usage

- Attach: `chromium.connectOverCDP(endpoint)` with `DEFAULT_CDP_PORT = 9223`
  (`scripts/pool/scan-selected-pools.mjs:639`, `scripts/browser/launch-cloak.mjs:19`).
- Port `9222` (legacy Brave) is explicitly forbidden
  (`scripts/pool/scan-selected-pools.mjs:630-635`).
- Default connect timeout `30000` ms (`scripts/pool/scan-selected-pools.mjs:591`).
- `browser.close()` and `context.close()` are **never** called
  (`scripts/pool/scan-selected-pools.mjs:1307-1309`,
  `scripts/pool-scanner-v1.mjs:784-788`). The browser process, its tabs, and
  its session survive.
- Tab handling: a dedicated scanner tab is identified by a worker marker and
  reused; a new tab is created only when no matching tab exists
  (`scripts/pool/scan-selected-pools.mjs:93-118`).
- `pool-scanner-v1.mjs` reuses any open tab whose URL contains
  `app.lpagent.io`, else creates one (`scripts/pool-scanner-v1.mjs:534-548`).

### 2.3 HTTP request execution

- Pool top-lper requests run **inside the browser context** via
  `page.evaluate(...)` calling `window.fetch`
  (`scripts/pool/scan-selected-pools.mjs:662-707`,
  `scripts/pool-scanner-v1.mjs:192-230`).
- Smart LP discovery instead captures request headers on reload and issues a
  direct Node `fetch` (`scripts/lpagent/scrape-smart-lp.mjs:476-479`,
  `:847-874`).
- The pool path therefore depends on the browser's ambient cookies and
  Cloudflare clearance. That is why F2-A keeps a browser-context transport in
  the contract rather than a Node-only path.

### 2.4 Confirmed request and response boundaries

Request (`scripts/pool/scan-selected-pools.mjs:667-679`):

```
GET https://api.lpagent.io/api/v1/pools/{poolAddress}/top-lpers
    ?page={n}&pageSize=20&order_by=total_pnl_native&sort_order=desc
Accept: application/json
credentials: include
```

Response (`scripts/pool/scan-selected-pools.mjs:746`, `:850-852`):

```json
{
  "status": "success",
  "data": [ ... ],
  "pagination": { "page": 1, "pageSize": 20, "totalCount": 40, "totalPages": 2 }
}
```

Row fields read by legacy code: `owner`, `wallet`, `total_pnl`, `win_rate`,
`total_lp` (`scripts/pool/scan-selected-pools.mjs:887-916`).

### 2.5 Pool address handling

- Addresses arrive via `--pool <ADDRESS>` (`scripts/pool/scan-selected-pools.mjs:128-132`).
- Whitespace is trimmed (`scripts/pool/scan-selected-pools.mjs:129`).
- Case is **never** transformed. `computeSelectionFingerprint` hashes the raw
  case-preserved string (`scripts/pool/scan-selected-pools.mjs:244`), and
  `row.owner` is only trimmed (`scripts/pool/scan-selected-pools.mjs:891-896`).
- Existence is checked against the Meteora DLMM Data API, not against LP Agent
  (`scripts/pool/scan-selected-pools.mjs:986-993`).

### 2.6 Pagination

- Parameters `page`, `pageSize=20`, `order_by=total_pnl_native`,
  `sort_order=desc` (`scripts/pool/scan-selected-pools.mjs:663-667`).
- The provider reports `pagination.totalPages` and `pagination.totalCount`
  (`scripts/pool/scan-selected-pools.mjs:850-852`).
- The legacy walk is `page = 2 .. totalPages`
  (`scripts/pool-scanner-v1.mjs:287-288`).
- Legacy also accepts `total_pages` as an alias in the Smart LP path
  (`scripts/lpagent/scrape-smart-lp.mjs:261-267`).

### 2.7 Error behavior

- HTTP 401/403: fail closed immediately (`scripts/pool/scan-selected-pools.mjs:754`).
- HTTP 429: read `retry-after`, back off, retry up to 3
  (`scripts/pool/scan-selected-pools.mjs:688-746`).
- HTTP 5xx and network status 0: exponential backoff, retry up to 3
  (`scripts/pool/scan-selected-pools.mjs:703-760`).
- In-browser fetch timeout via `AbortController`
  (`scripts/pool/scan-selected-pools.mjs:674-706`).
- Malformed body or a wrong envelope (`status !== "success"` or a non-array
  `data`) throws (`scripts/pool/scan-selected-pools.mjs:746`).

### 2.8 Output shapes (legacy, for reference only)

- `pool-wallets.json`: `{ version, tokenMint, updatedAt, pools[] }`, each pool
  `{ poolAddress, pair, binStep, baseFeePct, status, walletCount, wallets[] }`,
  each wallet `{ wallet, pnlUsd, winRate, positions }`
  (`scripts/pool/scan-selected-pools.mjs:433-438`, `:936-944`).
- `smart-lp-latest.json`: `{ generatedAt, source, filterSignature,
  pagesFetched, totalPages, totalUniqueWallets, wallets[] }`
  (`scripts/lpagent/scrape-smart-lp.mjs:1416-1442`).
- Legacy maps a missing or non-finite `total_pnl`/`win_rate`/`total_lp` to
  `null`, never to `0` (`scripts/pool/scan-selected-pools.mjs:900-930`).

### 2.9 Authentication

- Pool requests use `credentials: "include"` and rely entirely on the ambient
  browser session (`scripts/pool/scan-selected-pools.mjs:676`).
- The Smart LP path forwards intercepted `authorization` and `cookie` headers
  to a Node `fetch` (`scripts/lpagent/scrape-smart-lp.mjs:847-862`).
- No static credential exists in legacy code.

F2-A copies none of this. The contract records that authentication is ambient,
so a future transport must operate inside the browser context.

## 3. Module boundaries

```
src/connectors/lpagent/
├── index.ts          Public surface
├── pool-address.ts   Input contract, case-preserving, syntax only
├── contracts.ts      Typed data contracts + transport seam
├── mapping.ts        Provider envelope → typed page response
├── pagination.ts     Transport-independent page bookkeeping
├── errors.ts         Typed connector errors
└── connector.ts      Orchestrator over an injected transport
```

Responsibilities:

| Module | Owns | Must not own |
|---|---|---|
| `pool-address.ts` | Syntax validation, case preservation | Existence checks |
| `contracts.ts` | Types and the transport interface | Any implementation |
| `mapping.ts` | Envelope and row mapping | Fetching, retrying |
| `pagination.ts` | Page set, totals, duplicates | HTTP or timers |
| `errors.ts` | Typed failure codes | HTTP status mapping policy |
| `connector.ts` | Walking pages, completeness | Transport choice, browser |

No separate runtime service or microservice is introduced. The connector is a
library called by an existing backend process.

## 4. Browser transport separation

`LpAgentTransport` (in `contracts.ts`) is the only seam:

```ts
interface LpAgentTransport {
  fetchPage(request: LpAgentPageRequest): Promise<SourceFetchResult>;
  describe(): string;
}
```

- The connector receives a transport. It never constructs one.
- No Playwright `Browser`, `Page`, or `Context` crosses this seam.
- The connector does not import `playwright-core`, does not import the CDP
  boundary, and does not call `connectOverCDP`. A test asserts this by scanning
  the module sources.
- The connector never owns the CloakBrowser process lifecycle.

F2-B will implement a browser-context transport that:

1. Accepts an already-attached `CdpConnection` (F0/F1) as a constructor
   argument. It does not connect, disconnect, or close the browser.
2. Selects a page without navigating an existing user tab, following the
   legacy marker convention, and opens a dedicated tab only when no marker
   matches.
3. Executes `page.evaluate(() => window.fetch(...))` with the confirmed query
   parameters and `credentials: "include"`.
4. Returns a `SourceFetchResult`. It never returns an empty page on failure.

The F1 attach/detach/reconnect behaviour stays intact and unchanged.

## 5. Typed contracts

| Contract | Purpose |
|---|---|
| `PoolIdentity` | Case-preserved address plus its source |
| `PoolMetadataResult` | Metadata with an explicit `resolved` flag |
| `LpPositionReference` | One position row, confirmed fields typed, extras preserved |
| `WalletOwnerIdentity` | Wallet address, with owner-vs-delegate unverified |
| `PaginationMetadata` | `totalPages`, `totalCount`, `pageSize` |
| `SourceProvenance` | Provider, transport kind, endpoint path, fetch timestamp |
| `SourceFetchResult` | Success with rows, or a typed failure |
| `AcquisitionCompleteness` | `complete` \| `partial` \| `empty` |
| `LpAgentPageRequest` | One fully specified page request |
| `LpAgentPageResponse` | Mapped page plus the raw envelope |

Confirmed fields are `owner`, `wallet`, `total_pnl`, `win_rate`, `total_lp`,
`pagination.totalPages`, `pagination.totalCount`. Everything else a provider
sends is preserved under `extra` and never coerced or dropped.

`binStep` and `baseFeePct` are present but null: legacy sources them from the
Meteora Data API, not from LP Agent, so the connector does not claim an LP
Agent origin for them.

No PostgreSQL entity, SQL schema, or migration exists in F2-A.

## 6. Pagination design

State is immutable and explicit:

```ts
interface PaginationState {
  poolAddress: string;
  pageSize: number;
  totalPages: number | null;
  totalCount: number | null;
  completedPages: readonly number[];
  failedPages: readonly number[];
}
```

Rules enforced:

- **Explicit end.** `isFinalPage` is true only when every declared page
  returned rows. Completeness is never claimed from one page.
- **Duplicate detection.** A page that already returned rows throws
  `PaginationDuplicateError`.
- **Total consistency.** A declared total that changes mid-acquisition throws
  `PaginationTotalChangedError`.
- **Beyond total.** A page past the declared total throws
  `PaginationBeyondTotalError`.
- **No infinite loops.** `nextPageState` is bounded by `totalPages`, and the
  connector also caps one call at `MAX_PAGES_GUARD = 500` pages plus an
  optional caller-supplied `maxPages`.
- **Zero total.** A declared `totalPages: 0` is the provider reporting an empty
  result set. It is accepted on page 1 and treated as complete; it is rejected
  on any later page because it contradicts pages already returned.

F2-A does not invent a pagination protocol. The live protocol is verified in
F2-C.

## 7. Error handling

| Error | Raised when |
|---|---|
| `LpAgentInvalidPoolAddressError` | Address is empty, padded, wrong length, or non-base58 |
| `LpAgentTransportUnavailableError` | No usable transport was supplied |
| `LpAgentRequestError` | Provider request failed (carries `status`) |
| `LpAgentInvalidResponseError` | Envelope or row cannot be mapped |
| `LpAgentPaginationError` | Pagination bookkeeping contradicts itself |
| `LpAgentPartialResultError` | Acquisition stopped before the declared range |

Connector codes extend the F0 `BackendError` hierarchy. Messages are sanitized;
`cause` is retained locally and never serialized.

Invariants:

- A failed request is never an empty but valid result.
- An unreported numeric field becomes `null`, never `0`.
- A missing pagination block is an error, not a default of one page.
- A partial acquisition names the missing pages.

## 8. Tests

`tests/lpagent-connector.test.ts`, offline only:

- Valid, padded, empty, wrong-length, non-base58, and non-string pool input.
- Case preservation, and that a case change is a different valid address.
- Envelope mapping, unknown-field preservation, null-not-zero mapping.
- Malformed body, wrong envelope, missing pagination, impossible totals.
- Pagination completeness, duplicates, changed totals, failed pages.
- Full acquisition walks, partial results with named missing pages, page caps,
  empty result sets, inconsistent pagination, injected clock.
- Error normalization and status retention.
- Transport injection and the absence of any playwright/CDP/provider-URL
  reference in the connector sources.

Fixtures are synthetic. They contain no credentials, cookies, headers, browser
state, or production data. Pool and wallet addresses are invented mixed-case
base58 strings.

## 9. What remains unverified

- The live LP Agent response shape. The contract is derived from legacy code
  and legacy data, not from a request made in F2-A.
- Whether `pagination.page` and `pagination.pageSize` are always echoed.
  The connector falls back to the request's page size.
- The `total_pages` alias used only in the Smart LP path.
- Owner-versus-delegate semantics for `owner` and `wallet`.
- Whether `binStep` and `baseFeePct` are ever present in an LP Agent response.
- Rate limits, retry budgets, and Cloudflare behaviour under load.

## 10. F2-B readiness

F2-B may proceed on:

1. The transport seam in `contracts.ts`.
2. The attach-only rule: an injected `CdpConnection`, never a connect or close.
3. The confirmed query parameters and envelope shape.
4. The tab discipline in section 4.

F2-B must still decide, with approval:

- Whether to reuse a marker-tagged tab or always open a dedicated one.
- The retry and backoff budget, bounded by the legacy 401/403 fail-closed rule.
- How a 401/403 surfaces to the operator, since it requires manual browser
  action.

No live acquisition is approved in F2-A.
