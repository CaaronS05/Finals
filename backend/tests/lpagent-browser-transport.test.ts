/**
 * F2-B tests: LP Agent browser-context transport.
 *
 * OFFLINE ONLY. No test here opens a socket, imports playwright, attaches to a
 * browser, navigates a tab, or contacts api.lpagent.io. Every provider response
 * is a synthetic fixture, and every executor is a local fake.
 *
 * Fixtures contain no credentials, cookies, headers, browser state, or
 * production data. Pool addresses are invented mixed-case base58.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FakeBrowserExecutor,
  LpAgentBrowserTransport,
  LpAgentInvalidPoolAddressError,
  OwnedPageTracker,
  buildTopLpersUrl,
  isAllowedLpAgentUrl,
  okResponse,
  statusResponse,
  type BrowserContextHandle,
  type BrowserPageHandle,
  type FakeOutcome,
  type LpAgentPageRequest,
} from "../src/connectors/lpagent/index.ts";
import {
  LP_AGENT_BASE_URL,
  LP_AGENT_ORDER_BY,
  LP_AGENT_PAGE_SIZE,
  LP_AGENT_SORT_ORDER,
  LP_AGENT_TOP_LPERS_PATH,
} from "../src/connectors/lpagent/browser-transport.ts";
import { acquirePoolPositions } from "../src/connectors/lpagent/connector.ts";

/** Invented 32-character base58 address, case-significant. */
const POOL = "AbCdEfGhJkMnPqRsTuVwXyZ123456789";

const pageRequest = (page: number, poolAddress: string | null | undefined = POOL): LpAgentPageRequest => ({
  poolAddress: poolAddress as string,
  page,
  pageSize: 20,
  orderBy: "total_pnl_native",
  sortOrder: "desc",
});

/** Deterministic clock. */
const fixedNow = (): Date => new Date("2026-10-25T00:00:00.000Z");

/** A valid envelope body, as a synthetic fixture. */
function envelopeBody(rows: readonly Record<string, unknown>[], totalPages = 1, totalCount = rows.length): string {
  return JSON.stringify({
    status: "success",
    data: rows,
    pagination: { page: 1, pageSize: 20, totalCount, totalPages },
  });
}

const row = (owner: string) => ({ owner, wallet: owner, total_pnl: 1.5, win_rate: 0.5, total_lp: 2 });

/** Build a transport over a fake executor with a fixed clock. */
function transport(outcomes: readonly FakeOutcome[], timeoutMs = 15_000) {
  const executor = new FakeBrowserExecutor(outcomes);
  return { executor, transport: new LpAgentBrowserTransport({ executor, timeoutMs, now: fixedNow }) };
}

describe("f2b request construction", () => {
  it("builds the confirmed URL with the confirmed parameters", () => {
    const url = buildTopLpersUrl(pageRequest(2));
    const parsed = new URL(url);
    assert.equal(parsed.origin, LP_AGENT_BASE_URL);
    assert.equal(parsed.pathname, `${LP_AGENT_TOP_LPERS_PATH}/${POOL}/top-lpers`);
    assert.equal(parsed.searchParams.get("page"), "2");
    assert.equal(parsed.searchParams.get("pageSize"), String(LP_AGENT_PAGE_SIZE));
    assert.equal(parsed.searchParams.get("order_by"), LP_AGENT_ORDER_BY);
    assert.equal(parsed.searchParams.get("sort_order"), LP_AGENT_SORT_ORDER);
  });

  it("preserves pool address case in the URL", () => {
    const url = buildTopLpersUrl(pageRequest(1));
    assert.ok(url.includes(POOL));
    assert.ok(!url.includes(POOL.toLowerCase()));
  });

  it("rejects a malformed address before building any URL", () => {
    // base58 excludes 0, O, I, and l; 32 characters is required. Each case
    // must fail before a URL is built, so no browser interaction can occur.
    const bad: unknown[] = ["", "short", ` ${POOL} `, `${POOL.slice(0, 31)}l`, `${POOL.slice(0, 31)}O`, `${POOL.slice(0, 31)}I`, null, undefined];
    for (const value of bad) {
      const request = { ...pageRequest(1), poolAddress: value as string };
      assert.throws(() => buildTopLpersUrl(request), LpAgentInvalidPoolAddressError);
    }
  });

  it("accepts only https LP Agent origins", () => {
    assert.equal(isAllowedLpAgentUrl(`https://api.lpagent.io/api/v1/pools/x/top-lpers`), true);
    assert.equal(isAllowedLpAgentUrl(`http://api.lpagent.io/api/v1/pools/x/top-lpers`), false);
    assert.equal(isAllowedLpAgentUrl(`https://evil.example.com/api/v1/pools/x/top-lpers`), false);
    assert.equal(isAllowedLpAgentUrl("not-a-url"), false);
  });
});

describe("f2b transport execution", () => {
  it("sends the confirmed headers, method, and credentials", async () => {
    const { executor, transport: t } = transport([okResponse(envelopeBody([row("W1")]))]);
    await t.fetchPage(pageRequest(1));
    const request = executor.requests[0]!;
    assert.equal(request.method, "GET");
    assert.equal(request.credentials, "include");
    assert.equal(request.headers.Accept, "application/json");
    assert.equal(request.timeoutMs, 15_000);
  });

  it("makes no request until fetchPage is called", async () => {
    const { executor, transport: t } = transport([okResponse(envelopeBody([]))]);
    // Construction alone must not touch the executor.
    assert.equal(executor.requests.length, 0);
    assert.equal(executor.disposeCalls, 0);
    await t.fetchPage(pageRequest(1));
    assert.equal(executor.requests.length, 1);
  });

  it("parses a 200 envelope into rows and pagination", async () => {
    const { transport: t } = transport([okResponse(envelopeBody([row("W1"), row("W2")], 1, 2))]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]!.owner, "W1");
    assert.equal(result.rows[0]!.totalPnl, 1.5);
    assert.equal(result.pagination.totalPages, 1);
    assert.equal(result.pagination.totalCount, 2);
  });

  it("maps an unreported number to null, never to zero", async () => {
    const { transport: t } = transport([okResponse(envelopeBody([{ owner: "W1", total_pnl: null, win_rate: undefined, total_lp: "x" }]))]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.rows[0]!.totalPnl, null);
    assert.equal(result.rows[0]!.winRate, null);
    assert.equal(result.rows[0]!.totalLp, null);
  });

  it("preserves unknown provider fields", async () => {
    const { transport: t } = transport([okResponse(envelopeBody([{ owner: "W1", apr: 0.42 }]))]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.rows[0]!.extra.apr, 0.42);
  });

  it("drives a full acquisition through the F2-A connector", async () => {
    const { transport: t } = transport([
      okResponse(envelopeBody([row("W1")], 3, 3)),
      okResponse(envelopeBody([row("W2")], 3, 3)),
      okResponse(envelopeBody([row("W3")], 3, 3)),
    ]);
    const result = await acquirePoolPositions(t, { poolAddress: POOL, now: fixedNow });
    assert.equal(result.completeness, "complete");
    assert.deepEqual(result.completedPages, [1, 2, 3]);
    assert.deepEqual(result.missingPages, []);
    assert.equal(result.error, null);
  });
});

describe("f2b http status classification", () => {
  it("fails closed on 401 and names the required operator action", async () => {
    const { transport: t } = transport([statusResponse(401, "unauthorized")]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.status, 401);
    assert.equal(result.reason, "HTTP_STATUS");
    assert.match(result.detail, /operator action required/);
  });

  it("fails closed on 403", async () => {
    const { transport: t } = transport([statusResponse(403, "forbidden")]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.status, 403);
    assert.match(result.detail, /operator action required/);
  });

  it("classifies 429 and preserves retry-after", async () => {
    const { transport: t } = transport([statusResponse(429, "slow down", 30)]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.status, 429);
    assert.match(result.detail, /retry-after 30s/);
  });

  it("classifies 5xx as a provider failure", async () => {
    for (const status of [500, 502, 503]) {
      const { transport: t } = transport([statusResponse(status, "error")]);
      const result = await t.fetchPage(pageRequest(1));
      assert.equal(result.ok, false);
      if (result.ok) {
        continue;
      }
      assert.equal(result.status, status);
      assert.equal(result.reason, "HTTP_STATUS");
    }
  });

  it("never returns success on an HTTP failure", async () => {
    const { transport: t } = transport([statusResponse(500)]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
  });

  it("never converts an error into an empty page", async () => {
    const { transport: t } = transport([statusResponse(500)]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.status, 500);
  });
});

describe("f2b malformed and timeout handling", () => {
  it("rejects malformed JSON on a 200", async () => {
    const { transport: t } = transport([okResponse("{not json")]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.reason, "MALFORMED_BODY");
  });

  it("rejects an empty body on a 200", async () => {
    const { transport: t } = transport([okResponse("   ")]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.reason, "MALFORMED_BODY");
  });

  it("rejects a wrong envelope", async () => {
    const { transport: t } = transport([okResponse(JSON.stringify({ status: "error", data: [] }))]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.reason, "ENVELOPE");
  });

  it("rejects a non-array data field", async () => {
    const { transport: t } = transport([okResponse(JSON.stringify({ status: "success", data: {}, pagination: { totalPages: 1, totalCount: 0 } }))]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
  });

  it("classifies a timeout as TIMEOUT", async () => {
    const { transport: t } = transport([{ kind: "timeout" }]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.reason, "TIMEOUT");
    assert.equal(result.status, null);
  });

  it("classifies a network failure as TRANSPORT", async () => {
    const { transport: t } = transport([{ kind: "network", message: "socket closed" }]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.reason, "TRANSPORT");
  });

  it("does not leak response headers or bodies into error messages", async () => {
    const { transport: t } = transport([statusResponse(403, "secret-cookie-value")]);
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.ok(!result.detail.includes("secret-cookie-value"));
    assert.ok(!result.detail.includes("set-cookie"));
  });
});

describe("f2b resource cleanup", () => {
  it("closes owned pages on dispose and never the browser", async () => {
    const closed: string[] = [];
    const pages: BrowserPageHandle[] = [];
    let created = 0;
    const context: BrowserContextHandle = {
      pages: () => pages,
      newPage: async () => {
        created += 1;
        const id = `owned-${created}`;
        const page: BrowserPageHandle = {
          isClosed: () => closed.includes(id),
          close: async () => {
            closed.push(id);
          },
          url: () => "about:blank",
        };
        pages.push(page);
        return page;
      },
      describe: () => "fake-context",
    };
    const tracker = new OwnedPageTracker(context);
    await tracker.acquirePage();
    assert.equal(tracker.ownedPageCount(), 1);
    await tracker.dispose();
    assert.deepEqual(closed, ["owned-1"]);
    assert.equal(tracker.ownedPageCount(), 0);
    assert.equal(tracker.isDisposed(), true);
  });

  it("is safe to dispose twice", async () => {
    const closed: string[] = [];
    const context: BrowserContextHandle = {
      pages: () => [],
      newPage: async () => ({
        isClosed: () => closed.includes("p"),
        close: async () => {
          closed.push("p");
        },
        url: () => "",
      }),
      describe: () => "fake-context",
    };
    const tracker = new OwnedPageTracker(context);
    await tracker.acquirePage();
    await tracker.dispose();
    await tracker.dispose();
    assert.deepEqual(closed, ["p"]);
  });

  it("refuses to acquire a page after disposal", async () => {
    const context: BrowserContextHandle = {
      pages: () => [],
      newPage: async () => ({ isClosed: () => false, close: async () => {}, url: () => "" }),
      describe: () => "fake-context",
    };
    const tracker = new OwnedPageTracker(context);
    await tracker.dispose();
    await assert.rejects(() => tracker.acquirePage(), /disposed/);
  });

  it("never touches a user page", async () => {
    const userClosed: string[] = [];
    const userPage: BrowserPageHandle = {
      isClosed: () => false,
      close: async () => {
        userClosed.push("user");
      },
      url: () => "https://app.lpagent.io/pools",
    };
    const ownedClosed: string[] = [];
    const context: BrowserContextHandle = {
      pages: () => [userPage],
      newPage: async () => {
        const page: BrowserPageHandle = {
          isClosed: () => false,
          close: async () => {
            ownedClosed.push("owned");
          },
          url: () => "about:blank",
        };
        return page;
      },
      describe: () => "fake-context",
    };
    const tracker = new OwnedPageTracker(context);
    const page = await tracker.acquirePage();
    // The tracker created its own page; it did not adopt the user's tab.
    assert.notEqual(page, userPage);
    await tracker.dispose();
    assert.deepEqual(ownedClosed, ["owned"]);
    assert.deepEqual(userClosed, []);
  });

  it("refuses a request after the transport is disposed", async () => {
    const { executor, transport: t } = transport([okResponse(envelopeBody([row("W1")]))]);
    await t.dispose();
    const result = await t.fetchPage(pageRequest(1));
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.detail, /disposed/);
    assert.equal(executor.requests.length, 0);
  });

  it("disposes the executor exactly once", async () => {
    const { executor, transport: t } = transport([okResponse(envelopeBody([]))]);
    await t.dispose();
    await t.dispose();
    assert.equal(executor.disposeCalls, 1);
  });

  it("keeps the connector result partial when a page fails", async () => {
    const { transport: t } = transport([
      okResponse(envelopeBody([row("W1")], 3, 3)),
      statusResponse(500),
    ]);
    const result = await acquirePoolPositions(t, { poolAddress: POOL, now: fixedNow });
    assert.equal(result.completeness, "partial");
    assert.deepEqual(result.completedPages, [1]);
    assert.deepEqual(result.missingPages, [2, 3]);
  });
});

describe("f2b construction guards", () => {
  it("rejects a non-positive timeout", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new LpAgentBrowserTransport({ executor: new FakeBrowserExecutor(), timeoutMs: bad }),
        LpAgentInvalidPoolAddressError,
      );
    }
  });

  it("requires a positive finite timeout to construct", () => {
    const t = new LpAgentBrowserTransport({ executor: new FakeBrowserExecutor(), timeoutMs: 15_000 });
    assert.match(t.describe(), /timeout=15000ms/);
  });

  it("exposes no Playwright object through its description", async () => {
    const { transport: t } = transport([okResponse(envelopeBody([]))]);
    assert.ok(!t.describe().includes("playwright"));
  });
});
