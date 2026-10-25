/**
 * LP Agent connector tests (F2-A).
 *
 * OFFLINE ONLY. No test here opens a socket, imports playwright, attaches to a
 * browser, navigates a tab, or contacts api.lpagent.io. Every provider response
 * is a synthetic fixture written inline, and every transport is a local fake.
 *
 * Fixtures contain no credentials, no cookies, no headers, no browser state,
 * and no production data. Addresses and numbers are invented.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LpAgentInvalidPoolAddressError,
  LpAgentInvalidResponseError,
  LpAgentPaginationError,
  LpAgentTransportUnavailableError,
  acquirePoolPositions,
  isPoolAddress,
  mapEnvelope,
  mapEnvelopeOrThrow,
  mapRow,
  parsePoolAddress,
  type LpAgentPageRequest,
  type LpAgentPageResponse,
  type LpAgentTransport,
  type SourceFetchResult,
} from "../src/connectors/lpagent/index.ts";
import {
  PaginationDuplicateError,
  PaginationTotalChangedError,
  createEmptyPaginationState,
  isFinalPage,
  nextPageState,
  recordPageFailure,
  recordPageSuccess,
  remainingPages,
} from "../src/connectors/lpagent/pagination.ts";

/**
 * Synthetic pool address. Not a real pool, not a real mainnet address, and
 * case-significant on purpose: mixed case proves no lowercasing happens.
 * Exactly 32 base58 characters.
 */
const POOL = "AbCdEfGhJkMnPqRsTuVwXyZ123456789";
const WALLET = "WxYzAbCdEfGhJkMnPqRsTuVwXyZ123456789";

/** Deterministic clock so provenance timestamps never depend on wall time. */
const fixedNow = (): Date => new Date("2026-10-25T00:00:00.000Z");

/**
 * Fake transport. Records what it was asked for and replays a scripted
 * sequence of page results. Never touches the network.
 */
class FakeLpAgentTransport implements LpAgentTransport {
  readonly requests: LpAgentPageRequest[] = [];
  private readonly script: readonly (SourceFetchResult | (() => SourceFetchResult))[];
  private index = 0;

  constructor(script: readonly (SourceFetchResult | (() => SourceFetchResult))[]) {
    this.script = script;
  }

  async fetchPage(request: LpAgentPageRequest): Promise<SourceFetchResult> {
    this.requests.push(request);
    const entry = this.script[Math.min(this.index, this.script.length - 1)]!;
    this.index += 1;
    return typeof entry === "function" ? entry() : entry;
  }

  describe(): string {
    return "fake-lpagent-transport";
  }
}

/** A successful single page, shaped like the confirmed provider envelope. */
function okPage(rows: readonly Record<string, unknown>[], totalPages = 1, totalCount = rows.length): SourceFetchResult {
  return {
    ok: true,
    rows: rows.map((row) => ({
      owner: typeof row.owner === "string" ? row.owner : WALLET,
      wallet: typeof row.wallet === "string" ? row.wallet : null,
      totalPnl: typeof row.total_pnl === "number" ? row.total_pnl : null,
      winRate: typeof row.win_rate === "number" ? row.win_rate : null,
      totalLp: typeof row.total_lp === "number" ? row.total_lp : null,
      extra: {},
    })),
    pagination: { totalPages, totalCount, pageSize: 20 },
  };
}

/** Reason codes a failed page can carry, mirrored from the contract. */
type PageFailureReason = "TRANSPORT" | "HTTP_STATUS" | "TIMEOUT" | "MALFORMED_BODY" | "ENVELOPE";

function failedPage(reason: PageFailureReason, status: number | null = null): SourceFetchResult {
  return { ok: false, status, reason, detail: "synthetic failure" };
}

const pageRequest = (page: number, poolAddress = POOL): LpAgentPageRequest => ({
  poolAddress,
  page,
  pageSize: 20,
  orderBy: "total_pnl_native",
  sortOrder: "desc",
});

const provenance = {
  provider: "lpagent" as const,
  transport: "browser-context-fetch" as const,
  endpointPath: "/api/v1/pools/x/top-lpers",
  fetchedAt: "2026-10-25T00:00:00.000Z",
};

describe("lpagent pool address contract", () => {
  it("accepts a 32-character base58 address", () => {
    assert.equal(isPoolAddress(POOL), true);
  });

  it("preserves case exactly", () => {
    const parsed = parsePoolAddress(POOL);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.address, POOL);
      assert.equal(parsed.address.toLowerCase(), POOL.toLowerCase());
      assert.notEqual(parsed.address, POOL.toLowerCase());
    }
  });

  it("treats a case change as a different address, not an error", () => {
    assert.equal(parsePoolAddress(POOL.toLowerCase()).ok, true);
    assert.equal(parsePoolAddress(POOL.toLowerCase()).ok && POOL.toLowerCase() !== POOL, true);
  });

  it("rejects empty input", () => {
    const parsed = parsePoolAddress("");
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.reason, "EMPTY");
    }
  });

  it("rejects padded input instead of trimming it", () => {
    const parsed = parsePoolAddress(` ${POOL} `);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.reason, "WHITESPACE");
    }
  });

  it("rejects the wrong length", () => {
    const parsed = parsePoolAddress(POOL.slice(0, 31));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.reason, "WRONG_LENGTH");
    }
  });

  it("rejects non-base58 characters", () => {
    const parsed = parsePoolAddress(`0${POOL.slice(1)}`);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.reason, "INVALID_BASE58");
    }
  });

  it("rejects non-string input", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      const parsed = parsePoolAddress(value);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.equal(parsed.reason, "NOT_A_STRING");
      }
    }
  });

  it("does not claim existence for a syntactically valid address", () => {
    // Validity is syntax only. No provider contact happens in this module, so
    // a valid address is not evidence that a pool exists there.
    assert.equal(isPoolAddress(POOL), true);
    assert.equal(parsePoolAddress(POOL).ok, true);
  });
});

describe("lpagent response mapping", () => {
  it("maps a well-formed envelope", () => {
    const mapped = mapEnvelope(
      {
        status: "success",
        data: [{ owner: WALLET, wallet: WALLET, total_pnl: 12.5, win_rate: 0.5, total_lp: 3 }],
        pagination: { page: 1, pageSize: 20, totalCount: 1, totalPages: 1 },
      },
      pageRequest(1),
      provenance,
    );
    assert.equal(mapped.ok, true);
    if (!mapped.ok) {
      return;
    }
    assert.equal(mapped.response.rows.length, 1);
    assert.equal(mapped.response.rows[0]!.owner, WALLET);
    assert.equal(mapped.response.rows[0]!.totalPnl, 12.5);
    assert.equal(mapped.response.pagination.totalPages, 1);
    assert.equal(mapped.response.pagination.pageSize, 20);
  });

  it("preserves unknown provider fields instead of discarding them", () => {
    const mapped = mapEnvelope(
      {
        status: "success",
        data: [{ owner: WALLET, apr: 0.42, pnl_chart: [1, 2, 3] }],
        pagination: { totalCount: 1, totalPages: 1 },
      },
      pageRequest(1),
      provenance,
    );
    assert.equal(mapped.ok, true);
    if (!mapped.ok) {
      return;
    }
    assert.equal(mapped.response.rows[0]!.extra.apr, 0.42);
    assert.deepEqual(mapped.response.rows[0]!.extra.pnl_chart, [1, 2, 3]);
  });

  it("maps an unreported number to null, never to zero", () => {
    const mapped = mapRow({ owner: WALLET, total_pnl: null, win_rate: undefined, total_lp: "not-a-number" }, 0);
    assert.equal(mapped.ok, true);
    if (!mapped.ok) {
      return;
    }
    assert.equal(mapped.row.totalPnl, null);
    assert.equal(mapped.row.winRate, null);
    assert.equal(mapped.row.totalLp, null);
  });

  it("rejects a non-success envelope", () => {
    const mapped = mapEnvelope({ status: "error", data: [] }, pageRequest(1), provenance);
    assert.equal(mapped.ok, false);
    if (mapped.ok) {
      return;
    }
    assert.equal(mapped.reason, "ENVELOPE");
  });

  it("rejects a non-object body", () => {
    for (const body of [null, "text", 42, [1, 2]]) {
      const mapped = mapEnvelope(body, pageRequest(1), provenance);
      assert.equal(mapped.ok, false);
      if (mapped.ok) {
        continue;
      }
      assert.equal(mapped.reason, "MALFORMED_BODY");
    }
  });

  it("rejects a row with no usable owner", () => {
    const mapped = mapRow({ wallet: WALLET }, 0);
    assert.equal(mapped.ok, false);
    if (mapped.ok) {
      return;
    }
    assert.match(mapped.detail, /owner/);
  });

  it("rejects missing pagination rather than assuming one page", () => {
    const mapped = mapEnvelope({ status: "success", data: [] }, pageRequest(1), provenance);
    assert.equal(mapped.ok, false);
    if (mapped.ok) {
      return;
    }
    assert.match(mapped.detail, /pagination/);
  });

  it("rejects an impossible total page count", () => {
    const mapped = mapEnvelope(
      { status: "success", data: [], pagination: { totalCount: 0, totalPages: -1 } },
      pageRequest(1),
      provenance,
    );
    assert.equal(mapped.ok, false);
  });
});

describe("lpagent pagination bookkeeping", () => {
  it("starts with no declared total and no completeness", () => {
    const state = createEmptyPaginationState(POOL, 20);
    assert.equal(state.totalPages, null);
    assert.equal(isFinalPage(state), false);
    assert.equal(nextPageState(state), 1);
  });

  it("records a successful page and declares the total", () => {
    const state = recordPageSuccess(createEmptyPaginationState(POOL, 20), 1, 3, 60);
    assert.equal(state.totalPages, 3);
    assert.equal(state.totalCount, 60);
    assert.equal(isFinalPage(state), false);
    assert.equal(nextPageState(state), 2);
  });

  it("reports complete only when every declared page returned rows", () => {
    let state = recordPageSuccess(createEmptyPaginationState(POOL, 20), 1, 2, 4);
    state = recordPageSuccess(state, 2, 2, 4);
    assert.equal(isFinalPage(state), true);
    assert.equal(remainingPages(state).length, 0);
    assert.equal(nextPageState(state), null);
  });

  it("never claims completeness from one page", () => {
    const state = recordPageSuccess(createEmptyPaginationState(POOL, 20), 1, 5, 100);
    assert.equal(isFinalPage(state), false);
    assert.deepEqual(remainingPages(state), [2, 3, 4, 5]);
  });

  it("rejects a duplicate page", () => {
    const state = recordPageSuccess(createEmptyPaginationState(POOL, 20), 1, 3, 3);
    assert.throws(() => recordPageSuccess(state, 1, 3, 3), PaginationDuplicateError);
  });

  it("rejects a total that changes mid-acquisition", () => {
    const state = recordPageSuccess(createEmptyPaginationState(POOL, 20), 1, 3, 3);
    assert.throws(() => recordPageSuccess(state, 2, 4, 4), PaginationTotalChangedError);
  });

  it("keeps failed pages out of the completed set", () => {
    let state = recordPageFailure(createEmptyPaginationState(POOL, 20), 2);
    state = recordPageSuccess(state, 1, 3, 3);
    assert.deepEqual(state.completedPages, [1]);
    assert.deepEqual(state.failedPages, [2]);
    assert.deepEqual(remainingPages(state), [2, 3]);
    assert.equal(isFinalPage(state), false);
  });

  it("bounds the walk at the declared total", () => {
    const state = recordPageSuccess(createEmptyPaginationState(POOL, 20), 1, 1, 1);
    assert.equal(nextPageState(state), null);
  });
});

describe("lpagent connector acquisition", () => {
  it("acquires a complete single-page result", async () => {
    const transport = new FakeLpAgentTransport([okPage([{ owner: WALLET }], 1, 1)]);
    const result = await acquirePoolPositions(transport, { poolAddress: POOL, now: fixedNow });
    assert.equal(result.completeness, "complete");
    assert.deepEqual(result.completedPages, [1]);
    assert.deepEqual(result.missingPages, []);
    assert.equal(result.pages.length, 1);
    assert.equal(result.error, null);
    assert.equal(result.declaredTotalPages, 1);
  });

  it("requests the confirmed query parameters", async () => {
    const transport = new FakeLpAgentTransport([okPage([], 1, 0)]);
    await acquirePoolPositions(transport, { poolAddress: POOL });
    assert.equal(transport.requests.length, 1);
    const request = transport.requests[0]!;
    assert.equal(request.page, 1);
    assert.equal(request.pageSize, 20);
    assert.equal(request.orderBy, "total_pnl_native");
    assert.equal(request.sortOrder, "desc");
  });

  it("walks every declared page", async () => {
    const transport = new FakeLpAgentTransport([
      okPage([{ owner: WALLET }], 3, 3),
      okPage([{ owner: WALLET }], 3, 3),
      okPage([{ owner: WALLET }], 3, 3),
    ]);
    const result = await acquirePoolPositions(transport, { poolAddress: POOL });
    assert.equal(result.completeness, "complete");
    assert.deepEqual(result.completedPages, [1, 2, 3]);
    assert.deepEqual(result.pages.map((p) => p.page), [1, 2, 3]);
  });

  it("marks the result partial when a page fails and names the missing pages", async () => {
    const transport = new FakeLpAgentTransport([
      okPage([{ owner: WALLET }], 3, 3),
      failedPage("HTTP_STATUS", 500),
    ]);
    const result = await acquirePoolPositions(transport, { poolAddress: POOL });
    assert.equal(result.completeness, "partial");
    assert.deepEqual(result.completedPages, [1]);
    assert.deepEqual(result.missingPages, [2, 3]);
    assert.match(result.error ?? "", /page 2 failed/);
    // A failure is never an empty success.
    assert.notEqual(result.completeness, "complete");
  });

  it("never reports a failed acquisition as an empty valid result", async () => {
    const transport = new FakeLpAgentTransport([failedPage("TRANSPORT")]);
    const result = await acquirePoolPositions(transport, { poolAddress: POOL });
    assert.equal(result.completeness, "empty");
    assert.deepEqual(result.completedPages, []);
    assert.equal(result.pages.length, 0);
    assert.notEqual(result.error, null);
  });

  it("treats a provider-reported empty result set as complete, not incomplete", async () => {
    const transport = new FakeLpAgentTransport([okPage([], 0, 0)]);
    const result = await acquirePoolPositions(transport, { poolAddress: POOL });
    // totalPages 0 means the provider reported no rows at all. That is a
    // complete answer about an empty pool, and no page is missing.
    assert.equal(result.completeness, "complete");
    assert.equal(result.declaredTotalPages, 0);
    assert.deepEqual(result.missingPages, []);
    assert.equal(result.pages.length, 1);
    assert.equal(result.error, null);
  });

  it("reports empty when no page ever landed", async () => {
    const transport = new FakeLpAgentTransport([failedPage("TRANSPORT")]);
    const result = await acquirePoolPositions(transport, { poolAddress: POOL });
    assert.equal(result.completeness, "empty");
    assert.equal(result.declaredTotalPages, null);
    assert.equal(result.pages.length, 0);
    assert.notEqual(result.error, null);
  });

  it("rejects a malformed pool address before any request", async () => {
    const transport = new FakeLpAgentTransport([okPage([], 1, 0)]);
    await assert.rejects(
      () => acquirePoolPositions(transport, { poolAddress: "not-an-address" }),
      LpAgentInvalidPoolAddressError,
    );
    assert.equal(transport.requests.length, 0);
  });

  it("refuses to run without a transport", async () => {
    await assert.rejects(
      // Cast is deliberate: the point is that the connector detects a missing
      // transport rather than crashing on an undefined import.
      () => acquirePoolPositions(undefined as unknown as LpAgentTransport, { poolAddress: POOL }),
      LpAgentTransportUnavailableError,
    );
  });

  it("preserves pool address case through the request", async () => {
    const transport = new FakeLpAgentTransport([okPage([], 1, 0)]);
    await acquirePoolPositions(transport, { poolAddress: POOL });
    assert.equal(transport.requests[0]!.poolAddress, POOL);
  });

  it("stops on inconsistent pagination instead of continuing", async () => {
    const transport = new FakeLpAgentTransport([
      okPage([], 3, 0),
      okPage([], 4, 0),
    ]);
    await assert.rejects(
      () => acquirePoolPositions(transport, { poolAddress: POOL }),
      LpAgentPaginationError,
    );
  });

  it("honours a page cap", async () => {
    const transport = new FakeLpAgentTransport([
      okPage([], 99, 0),
      okPage([], 99, 0),
      okPage([], 99, 0),
    ]);
    const result = await acquirePoolPositions(transport, { poolAddress: POOL, maxPages: 2 });
    assert.equal(result.completeness, "partial");
    assert.deepEqual(result.completedPages, [1, 2]);
    assert.match(result.error ?? "", /page cap/);
  });

  it("uses the injected clock for provenance", async () => {
    const transport = new FakeLpAgentTransport([okPage([{ owner: WALLET }], 1, 1)]);
    const result = await acquirePoolPositions(transport, { poolAddress: POOL, now: fixedNow });
    assert.equal(result.pages[0]!.response.provenance.fetchedAt, "2026-10-25T00:00:00.000Z");
    assert.equal(result.pages[0]!.response.provenance.provider, "lpagent");
  });

  it("makes no provider request when the address is rejected", async () => {
    const transport = new FakeLpAgentTransport([okPage([], 1, 0)]);
    await assert.rejects(
      () => acquirePoolPositions(transport, { poolAddress: "" }),
      LpAgentInvalidPoolAddressError,
    );
    assert.equal(transport.requests.length, 0);
  });
});

describe("lpagent connector isolation", () => {
  it("makes no provider request when the transport is missing", async () => {
    // The connector must detect the absence of a transport, not reach for a
    // default browser connection.
    await assert.rejects(
      () => acquirePoolPositions(undefined as unknown as LpAgentTransport, { poolAddress: POOL }),
      LpAgentTransportUnavailableError,
    );
  });

  it("requests every page through the injected transport only", async () => {
    const transport = new FakeLpAgentTransport([
      okPage([], 2, 0),
      okPage([], 2, 0),
    ]);
    await acquirePoolPositions(transport, { poolAddress: POOL });
    // Two pages, two transport calls, and no third call to anywhere else.
    assert.equal(transport.requests.length, 2);
    assert.deepEqual(transport.requests.map((r) => r.page), [1, 2]);
  });

  it("holds no reference to Playwright or CdpConnection", async () => {
    // Proven by import graph: the connector module tree must not pull in
    // playwright-core or the CDP boundary. Verified by the source scan below.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../src/connectors/lpagent", import.meta.url));
    const files = ["connector.ts", "contracts.ts", "pagination.ts", "pool-address.ts", "mapping.ts", "errors.ts"];
    for (const file of files) {
      const source = readFileSync(`${dir}/${file}`, "utf8");
      assert.ok(!source.includes("playwright"), `${file} must not import playwright`);
      assert.ok(!source.includes("cdp/"), `${file} must not import the CDP boundary`);
      assert.ok(!source.includes("connectOverCDP"), `${file} must not call connectOverCDP`);
      assert.ok(!source.includes("api.lpagent.io"), `${file} must not hardcode a provider URL`);
    }
  });
});

describe("lpagent error normalization", () => {
  it("maps a bad envelope to a typed invalid-response error", () => {
    assert.throws(
      () => mapEnvelopeOrThrow({ status: "error", data: [] }, pageRequest(1), provenance),
      LpAgentInvalidResponseError,
    );
  });

  it("returns a failed mapping instead of throwing when called as a union", () => {
    const mapped = mapEnvelope({ status: "error", data: [] }, pageRequest(1), provenance);
    assert.equal(mapped.ok, false);
  });

  it("keeps the status code on a request failure", async () => {
    const transport = new FakeLpAgentTransport([failedPage("HTTP_STATUS", 429)]);
    const result = await acquirePoolPositions(transport, { poolAddress: POOL });
    assert.match(result.error ?? "", /HTTP 429/);
  });
});
