# DLLM Finals — Backend (F2-B)

Meteora DLMM pool & wallet intelligence backend. Local-first, browser-assisted
data acquisition, PostgreSQL as the eventual primary store.

This repository is in **phase F2-B**: the backend foundation, verified live
CloakBrowser connectivity, the LP Agent connector foundation, and the LP Agent
browser transport. No scraping, no ETL, no database, no scan orchestration, and
no live provider request.

## Status labels

| Label | Meaning |
|---|---|
| IMPLEMENTED | Code exists and the F0 test suite exercises it |
| TESTED | Executed in this phase; command and result recorded below |
| PROPOSED | Designed, not built |
| UNVERIFIED | Depends on an external runtime that was not probed |

## Project purpose

DLLM answers, for a Meteora DLMM operator:

- which wallets are profitable,
- what happened inside a pool,
- what a single wallet's real position lifecycle looks like.

Acquisition runs through a user-operated browser (CloakBrowser / CDP) plus
HTTP calls to reachable web endpoints. No LP Agent Open API key is required,
and no Fabriq API credential is planned. Scanning is manual and on-demand:
one pool per job, at most one active scan job globally.

## Current implementation (F0)

| Area | Status |
|---|---|
| TypeScript / Node ESM package, strict | IMPLEMENTED |
| Local HTTP server, loopback only | IMPLEMENTED, TESTED |
| `GET /health` | IMPLEMENTED, TESTED |
| Validated runtime configuration | IMPLEMENTED, TESTED |
| CDP connection boundary (interface + manager) | IMPLEMENTED, TESTED |
| Fake CDP transport for tests | IMPLEMENTED, TESTED |
| Typed, sanitized error hierarchy | IMPLEMENTED, TESTED |
| Playwright-core CDP adapter | IMPLEMENTED, TESTED (live) |
| CloakBrowser live attach | IMPLEMENTED, TESTED (live) |
| Live CDP regression test (opt-in) | IMPLEMENTED, TESTED |
| LP Agent connector contracts | IMPLEMENTED, TESTED (offline) |
| LP Agent pool address validation | IMPLEMENTED, TESTED (offline) |
| LP Agent response mapping | IMPLEMENTED, TESTED (offline) |
| LP Agent pagination bookkeeping | IMPLEMENTED, TESTED (offline) |
| LP Agent connector errors | IMPLEMENTED, TESTED (offline) |
| LP Agent browser execution boundary | IMPLEMENTED, TESTED (offline) |
| LP Agent owned-page lifecycle | IMPLEMENTED, TESTED (offline) |
| LP Agent browser transport | IMPLEMENTED, TESTED (offline) |
| LP Agent Playwright executor adapter | IMPLEMENTED, UNVERIFIED (live) |
| LP Agent transport execution | IMPLEMENTED, TESTED (offline) |
| Live LP Agent acquisition | BLOCKED until F2-C |
| LP Agent scraping | NOT IMPLEMENTED |
| Fabriq scraping | NOT IMPLEMENTED |
| PostgreSQL, schema, migrations | NOT IMPLEMENTED |
| ETL, raw retention, job queue | NOT IMPLEMENTED |
| Frontend | NOT IMPLEMENTED |

## Repository structure

```
.
├── backend/
│   ├── src/
│   │   ├── config.ts                    Validated runtime configuration
│   │   ├── errors.ts                    Typed, sanitized error hierarchy
│   │   ├── server.ts                    Entrypoint
│   │   ├── http/
│   │   │   └── server.ts                Minimal loopback HTTP server
│   │   └── cdp/
│   │       ├── connection.ts            Connection boundary + fake transport
│   │       ├── endpoint.ts              Endpoint policy (9223, no 9222)
│   │       ├── playwright-transport.ts  Real adapter (verified live)
│   │       ├── fake-transport.ts        In-memory fake for tests
│   │       └── index.ts
│   └── connectors/
│       └── lpagent/
│           ├── pool-address.ts          Case-preserving input contract
│           ├── contracts.ts             Typed contracts + transport seam
│           ├── mapping.ts               Provider envelope mapping
│           ├── pagination.ts            Page bookkeeping
│           ├── errors.ts                Typed connector errors
│           ├── connector.ts             Orchestrator over injected transport
│           ├── browser-execution.ts     Browser seam, origin allowlist
│           ├── owned-pages.ts           DLLM-owned page lifecycle
│           ├── browser-transport.ts     LpAgentTransport implementation
│           ├── playwright-executor.ts   Real adapter (UNVERIFIED live)
│           └── fake-browser-executor.ts  In-memory fake for tests
│   └── tests/
│       ├── config.test.ts
│       ├── http.test.ts
│       ├── cdp-connection.test.ts
│       ├── cdp-endpoint.test.ts
│       ├── cdp-late-connect.test.ts
│       ├── cdp-failure-recovery.test.ts
│       ├── lpagent-connector.test.ts
│       ├── lpagent-browser-transport.test.ts
│       └── live/
│           └── cdp-live.test.ts         Opt-in, LIVE_CDP=1 only
├── docs/
│   └── architecture/
│       ├── F0_BACKEND_FOUNDATION.md
│       ├── F2A_LPAGENT_CONNECTOR.md
│       └── F2B_LPAGENT_BROWSER_TRANSPORT.md
├── .env.example
└── .gitignore
```

## Runtime prerequisites

- Node.js `>= 22.6.0` (developed on 24.22.1). TypeScript is executed directly
  by Node's built-in type stripping; no compile step is needed to run.
- A package manager: npm.
- CloakBrowser is **not** required for F0. The server starts and serves
  `/health` without it.

## Installation

```bash
git clone https://github.com/CaaronS05/Finals.git
cd Finals
npm --prefix backend install
cp .env.example backend/.env   # optional; defaults are safe
```

No `.env` file is committed. `.env.example` contains safe values only.

## Commands

Run from `backend/`, or prefix with `npm --prefix backend` from the repo root.

| Command | Effect |
|---|---|
| `npm run dev` | Development server with restart on change |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/` |
| `npm run build` | Emit `dist/` from `src/` |
| `npm start` | Run the built server from `dist/server.js` |
| `npm test` | Offline suite over `tests/*.test.ts` (no browser needed) |
| `npm run test:live` | Live CDP verification; needs `LIVE_CDP=1` and a running CloakBrowser |

The LP Agent connector tests run inside `npm test` and are fully offline. They
never open a socket, import playwright, attach to a browser, or contact
`api.lpagent.io`.

## Health endpoint

`GET /health` on the configured loopback host:

```json
{ "status": "ok", "service": "dllm-backend" }
```

Verified against a live local process:

```bash
node backend/dist/server.js
curl -s http://127.0.0.1:8788/health
# {"status":"ok","service":"dllm-backend"}
```

## Configuration

Read from the environment; `.env` is not required.

| Variable | Default | Notes |
|---|---|---|
| `BACKEND_HOST` | `127.0.0.1` | Loopback only. Any other value is rejected at startup. |
| `BACKEND_PORT` | `8788` | `1`–`65535`. Chosen to avoid the legacy DLLM control server on `8787`. |
| `CDP_ENDPOINT` | `http://127.0.0.1:9223` | Loopback only. |
| `CDP_CONNECT_TIMEOUT_MS` | `15000` | `0` disables the timeout. |

Malformed values fail fast with a typed `ConfigError` instead of silently
defaulting, so a typo cannot bind the server to an unintended host or port.

**Port 9223 is a historical DLLM convention, not a verified active endpoint.**
Port 9222 (legacy Brave) is forbidden and rejected outright.

## CDP configuration

The CDP boundary lives in `backend/src/cdp/`. It is a contract with an
injected transport:

- `connect(options)` — explicit attach, rejects on unreachable endpoint or timeout
- `getStatus()` / `isConnected()` — lifecycle state
- `getSessionInfo()` — endpoint and browser version while connected
- `disconnect()` — detach, idempotent, never terminates the browser

Connections are **opt-in and lazy**. Nothing connects at import time, at
server startup, or on any HTTP route. A missing endpoint produces a typed
`CdpUnavailableError`; the server keeps running.

If a connect times out but the browser attaches anyway, that late session is
released rather than left attached with no owner. `close()` on a CDP-attached
browser detaches the transport only; the browser process is never terminated.

The real adapter uses `playwright-core`'s `chromium.connectOverCDP`, the same
mechanism the legacy repository uses.

## Live verification (F1)

The adapter was verified against a real CloakBrowser on 2026-10-25.

| Item | Observed |
|---|---|
| CDP endpoint | `http://127.0.0.1:9223` reachable, `/json/version` returned HTTP 200 |
| Browser | Chrome/145.0.7632.109 |
| Protocol | 1.3 |
| Real attach | succeeded |
| Connected state recognized | yes |
| Disconnect | succeeded |
| Disconnected state recognized | yes |
| Reconnect | succeeded |
| Browser after detach | still running, same version, endpoint still reachable |
| Tabs modified | none |
| Sessions left owned by DLLM | none |

Run the live test explicitly. It is disabled by default and never runs as part
of `npm test`:

```bash
# 1. Start CloakBrowser with CDP on 9223 (do this yourself, outside this repo)
# 2. Arm and run the live verification
LIVE_CDP=1 npm --prefix backend run test:live
```

The live test is read-only with respect to the browser: it attaches, checks
state, detaches, and reattaches. It never navigates a tab, reads cookies or
session state, creates or deletes a profile, or changes a persistent setting.
A failure always detaches in a `finally` block, so no session outlives the run.

`npm test` runs only `tests/*.test.ts`, so the live test is excluded by glob
and needs no browser.

## What is NOT implemented

- LP Agent or Fabriq scraping, and any request to an external provider
- LP Agent navigation, live acquisition, and retry orchestration (F2-C)
- Wallet enrichment, pool scanning, scan jobs or orchestration
- PostgreSQL, schema, migrations, raw production storage, ETL
- A frontend application
- Historical data import
- Any write to the legacy Rahasia repository or its data

## Roadmap

| Phase | Scope |
|---|---|
| F1 | Live CloakBrowser attach verification — DONE |
| F2-A | LP Agent connector foundation (contracts, mapping, pagination) — DONE |
| F2-B | LP Agent browser transport behind the CDP boundary — DONE |
| F2-C | Live pagination and acquisition verification |
| F3 | Fabriq workflow; HTTP endpoint integration |
| F4 | PostgreSQL schema and migrations; canonical write durability |
| F5 | One-pool scan job; global single-job lock; Latest State + Historical Evidence |
| F6 | Selective raw retention; wallet enrichment for pool-local LP activity |
| F7 | Frontend as a separate application |

F1, F2-A, and F2-B are implemented and verified offline. Nothing above F2-B is
built. Each phase needs its own design and approval.

## Data safety

This repository is public. Never commit: API secrets, cookies, browser
sessions, `.env` files, PostgreSQL data files, raw scraping responses, or
wallet private keys. `.gitignore` excludes `.env`, `node_modules/`, and `dist/`.
The legacy Rahasia repository and its datasets remain untouched.

## F0 verification

Executed in this phase on Node v24.22.1:

| Command | Result |
|---|---|
| `npm --prefix backend run typecheck` | exit 0 |
| `npm --prefix backend run build` | exit 0, emits `dist/` |
| `npm --prefix backend test` | exit 0, 136 tests, 136 pass, 0 fail |
| `node backend/dist/server.js` + `curl /health` | exit 0, `{"status":"ok","service":"dllm-backend"}` |
| Server startup with no CloakBrowser | exit 0, port 9223 confirmed closed, server unaffected |
