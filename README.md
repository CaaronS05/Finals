# DLLM Finals — Backend (F0)

Meteora DLMM pool & wallet intelligence backend. Local-first, browser-assisted
data acquisition, PostgreSQL as the eventual primary store.

This repository is in **phase F0**: a backend foundation only. No scraping,
no ETL, no database, no scan orchestration.

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
| Playwright-core CDP adapter | IMPLEMENTED, UNVERIFIED |
| CloakBrowser live attach | UNVERIFIED |
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
│   │       ├── playwright-transport.ts  Real adapter (UNVERIFIED)
│   │       └── index.ts
│   └── tests/
│       ├── config.test.ts
│       ├── http.test.ts
│       ├── cdp-connection.test.ts
│       └── cdp-endpoint.test.ts
├── docs/
│   └── architecture/
│       └── F0_BACKEND_FOUNDATION.md
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
| `npm test` | Node test runner over `tests/` |

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
mechanism the legacy repository uses. **Its compatibility with the current
CloakBrowser build is UNVERIFIED** — no live instance was probed during F0.
Verification requires a running CloakBrowser on `9223` and is deferred to F1.

## What is NOT implemented

- LP Agent or Fabriq scraping, and any request to an external provider
- Wallet enrichment, pool scanning, scan jobs or orchestration
- PostgreSQL, schema, migrations, raw production storage, ETL
- A frontend application
- Historical data import
- Any write to the legacy Rahasia repository or its data

## Roadmap (PROPOSED)

| Phase | Scope |
|---|---|
| F1 | Live CloakBrowser attach verification; LP Agent workflow behind the CDP boundary |
| F2 | Fabriq workflow; HTTP endpoint integration |
| F3 | PostgreSQL schema and migrations; canonical write durability |
| F4 | One-pool scan job; global single-job lock; Latest State + Historical Evidence |
| F5 | Selective raw retention; wallet enrichment for pool-local LP activity |
| F6 | Frontend as a separate application |

Nothing above F0 is built. Each phase needs its own design and approval.

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
| `npm --prefix backend test` | exit 0, 50 tests, 50 pass, 0 fail |
| `node backend/dist/server.js` + `curl /health` | exit 0, `{"status":"ok","service":"dllm-backend"}` |
| Server startup with no CloakBrowser | exit 0, port 9223 confirmed closed, server unaffected |
