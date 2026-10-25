/**
 * LP Agent browser-context transport (F2-B).
 *
 * Implements `LpAgentTransport` (F2-A) on top of an injected `BrowserExecutor`
 * (this phase). The transport constructs the confirmed provider request,
 * executes it, and classifies the outcome. It never builds a URL for an
 * unknown origin and never turns a failure into an empty page.
 *
 * CONFIRMED REQUEST CONTRACT (Rahasia evidence)
 * ---------------------------------------------
 *   GET https://api.lpagent.io/api/v1/pools/{address}/top-lpers
 *       ?page={n}&pageSize=20&order_by=total_pnl_native&sort_order=desc
 *   Accept: application/json
 *   credentials: include
 *
 * NO LIVE REQUEST ON IMPORT OR STARTUP
 * ------------------------------------
 * A request runs only when `fetchPage` is called. Constructing this transport
 * touches no browser and no network. The executor itself is injected, so a
 * caller that supplies nothing obtains no capability.
 */
import type {
  LpAgentPageRequest,
  LpAgentTransport,
  SourceFetchResult,
  SourceProvenance,
} from "./contracts.ts";
import { LpAgentInvalidPoolAddressError } from "./errors.ts";
import { mapEnvelope } from "./mapping.ts";
import { parsePoolAddress } from "./pool-address.ts";
import {
  BrowserExecutionError,
  isAllowedLpAgentUrl,
  toRequestError,
  type BrowserExecutor,
  type BrowserHttpRequest,
} from "./browser-execution.ts";

/** Confirmed legacy page size. */
export const LP_AGENT_PAGE_SIZE = 20;
/** Confirmed legacy ordering parameters. */
export const LP_AGENT_ORDER_BY = "total_pnl_native";
export const LP_AGENT_SORT_ORDER = "desc";
/** Confirmed provider base URL and path template. */
export const LP_AGENT_BASE_URL = "https://api.lpagent.io";
export const LP_AGENT_TOP_LPERS_PATH = "/api/v1/pools";

/** Options for constructing the transport. */
export interface LpAgentBrowserTransportOptions {
  /** Executes requests inside an existing browser context. */
  readonly executor: BrowserExecutor;
  /** Request timeout in milliseconds. Bounded, required. */
  readonly timeoutMs: number;
  /** Injectable clock, so provenance timestamps never depend on wall time. */
  readonly now?: () => Date;
}

/**
 * Build the provider URL for one page.
 *
 * Throws `LpAgentInvalidPoolAddressError` for a malformed address, before any
 * URL is produced, so a bad identity can never reach the browser. The address
 * is interpolated verbatim: case is preserved.
 */
export function buildTopLpersUrl(request: LpAgentPageRequest): string {
  const parsed = parsePoolAddress(request.poolAddress);
  if (!parsed.ok) {
    throw new LpAgentInvalidPoolAddressError(
      `Pool address rejected (${parsed.reason})`,
      request.poolAddress,
    );
  }
  const url = new URL(`${LP_AGENT_TOP_LPERS_PATH}/${parsed.address}/top-lpers`, LP_AGENT_BASE_URL);
  url.searchParams.set("page", String(request.page));
  url.searchParams.set("pageSize", String(request.pageSize));
  url.searchParams.set("order_by", LP_AGENT_ORDER_BY);
  url.searchParams.set("sort_order", LP_AGENT_SORT_ORDER);
  const built = url.toString();
  if (!isAllowedLpAgentUrl(built)) {
    // Unreachable for a valid address, but a guard costs nothing and prevents
    // an accidental origin change from silently reaching the browser.
    throw new LpAgentInvalidPoolAddressError("Constructed URL is not an allowed LP Agent origin", request.poolAddress);
  }
  return built;
}

/**
 * Browser-context LP Agent transport.
 *
 * Lifecycle: `dispose()` releases every page the executor created. It never
 * closes the browser, never terminates a process, and never disconnects CDP.
 * After disposal, `fetchPage` refuses rather than executing against a released
 * page.
 */
export class LpAgentBrowserTransport implements LpAgentTransport {
  private readonly executor: BrowserExecutor;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private disposed = false;

  constructor(options: LpAgentBrowserTransportOptions) {
    if (typeof options.timeoutMs !== "number" || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new LpAgentInvalidPoolAddressError(
        "Transport timeout must be a positive number of milliseconds",
        String(options.timeoutMs),
      );
    }
    this.executor = options.executor;
    this.timeoutMs = options.timeoutMs;
    this.now = options.now ?? (() => new Date());
  }

  async fetchPage(request: LpAgentPageRequest): Promise<SourceFetchResult> {
    if (this.disposed) {
      return {
        ok: false,
        status: null,
        reason: "TRANSPORT",
        detail: "transport disposed",
      };
    }
    // Build the URL first: a malformed address must fail before a request is
    // constructed, so no browser interaction happens for bad input.
    const url = buildTopLpersUrl(request);
    const httpRequest: BrowserHttpRequest = {
      url,
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
      timeoutMs: this.timeoutMs,
    };
    let response;
    try {
      response = await this.executor.execute(httpRequest);
    } catch (error) {
      // No response at all: timeout or network failure. Report it as a failed
      // page, never as an empty successful one.
      const requestError = toRequestError(error);
      return {
        ok: false,
        status: null,
        reason: error instanceof BrowserExecutionError && error.failure === "TIMEOUT" ? "TIMEOUT" : "TRANSPORT",
        detail: requestError.message,
      };
    }
    if (response.timedOut) {
      return { ok: false, status: null, reason: "TIMEOUT", detail: `request exceeded ${this.timeoutMs}ms` };
    }
    if (response.status === 401 || response.status === 403) {
      // Fail closed and name the required operator action. No retry: the
      // browser session must be repaired by the user.
      return {
        ok: false,
        status: response.status,
        reason: "HTTP_STATUS",
        detail: "authentication or access denied; operator action required in CloakBrowser",
      };
    }
    if (response.status < 200 || response.status > 299) {
      const retryAfter = response.retryAfterSeconds;
      const detail = retryAfter !== null
        ? `provider returned HTTP ${response.status}; retry-after ${retryAfter}s`
        : `provider returned HTTP ${response.status}`;
      return { ok: false, status: response.status, reason: "HTTP_STATUS", detail };
    }
    if (response.body.trim().length === 0) {
      return { ok: false, status: response.status, reason: "MALFORMED_BODY", detail: "empty response body" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch (error) {
      return {
        ok: false,
        status: response.status,
        reason: "MALFORMED_BODY",
        detail: `response body is not valid JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
      };
    }
    // A 200 with a valid JSON body is not yet a valid page. The transport maps
    // the confirmed envelope itself, so a wrong envelope is a failure here
    // rather than an empty page passed upward.
    const mapped = mapEnvelope(parsed, request, this.provenanceFor(request));
    if (!mapped.ok) {
      return {
        ok: false,
        status: response.status,
        reason: mapped.reason,
        detail: mapped.detail,
      };
    }
    const rows = mapped.response.rows.map((row) => ({
      owner: row.owner,
      wallet: row.wallet,
      totalPnl: row.totalPnl,
      winRate: row.winRate,
      totalLp: row.totalLp,
      extra: row.extra,
    }));
    return {
      ok: true,
      rows,
      pagination: mapped.response.pagination,
    };
  }

  /** Provenance for one request, using the injected clock. */
  private provenanceFor(request: LpAgentPageRequest): SourceProvenance {
    return {
      provider: "lpagent",
      transport: "browser-context-fetch",
      endpointPath: `${LP_AGENT_TOP_LPERS_PATH}/${request.poolAddress}/top-lpers`,
      fetchedAt: this.now().toISOString(),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.executor.dispose();
  }

  describe(): string {
    return `lpagent-browser-transport(${this.executor.describe()}, timeout=${this.timeoutMs}ms)`;
  }
}
