/**
 * LP Agent connector orchestrator (F2-A).
 *
 * Acquires the top-lper pages for ONE pool using an injected transport.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * - No provider request originates here. Every page goes through the injected
 *   `LpAgentTransport`, which is supplied by the caller.
 * - No browser is opened, navigated, attached, or closed. The connector has no
 *   reference to Playwright and no reference to `CdpConnection`.
 * - No pool discovery, no orchestration across pools, no database write.
 *
 * COMPLETENESS IS EXPLICIT
 * ------------------------
 * `acquirePoolPositions` returns a result that states whether the provider's
 * declared page range was fully covered. A failure is never folded into an
 * empty but valid result: a failed page keeps the result `partial` and names
 * the pages that are still missing.
 */
import type {
  AcquisitionCompleteness,
  LpAgentPageRequest,
  LpAgentPageResponse,
  LpAgentTransport,
  PoolIdentity,
} from "./contracts.ts";
import { LpAgentInvalidPoolAddressError, LpAgentPaginationError, LpAgentTransportUnavailableError } from "./errors.ts";
import { createEmptyPaginationState, isFinalPage, nextPageState, recordPageFailure, recordPageSuccess, type PaginationState } from "./pagination.ts";
import { parsePoolAddress } from "./pool-address.ts";
import { mapEnvelopeOrThrow } from "./mapping.ts";

/** One acquired page, plus the mapping the connector produced. */
export interface AcquiredPage {
  readonly page: number;
  readonly response: LpAgentPageResponse;
}

/** Outcome of acquiring one pool's positions. */
export interface PoolAcquisitionResult {
  readonly pool: PoolIdentity;
  readonly completeness: AcquisitionCompleteness;
  /** Pages that returned rows, ascending. */
  readonly completedPages: readonly number[];
  /** Pages still missing, ascending. Empty when complete. */
  readonly missingPages: readonly number[];
  /** Total pages declared by the provider, when it reported them. */
  readonly declaredTotalPages: number | null;
  /** Total rows declared by the provider, when it reported them. */
  readonly declaredTotalCount: number | null;
  /** Acquired pages in request order. */
  readonly pages: readonly AcquiredPage[];
  /** Error message when the acquisition stopped early. Sanitized. */
  readonly error: string | null;
}

/** Options for one acquisition. */
export interface AcquireOptions {
  /** Pool address, case preserved. */
  readonly poolAddress: string;
  /** Where the address came from. */
  readonly source?: PoolIdentity["source"];
  /** Page size. Legacy uses 20. */
  readonly pageSize?: number;
  /**
   * Hard cap on pages to fetch for this call. Guards against a provider that
   * declares an implausibly large total. `0` means no cap beyond the total.
   */
  readonly maxPages?: number;
  /** Injectable clock, so tests never depend on wall time. */
  readonly now?: () => Date;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * Acquire every declared page of top-lpers for one pool.
 *
 * Throws:
 *   - LpAgentInvalidPoolAddressError  — the address is malformed
 *   - LpAgentTransportUnavailableError — no transport was supplied
 *
 * A provider or pagination failure is returned in the result, not thrown, so a
 * caller always learns which pages are missing.
 */
export async function acquirePoolPositions(
  transport: LpAgentTransport,
  options: AcquireOptions,
): Promise<PoolAcquisitionResult> {
  const parsed = parsePoolAddress(options.poolAddress);
  if (!parsed.ok) {
    throw new LpAgentInvalidPoolAddressError(
      `Pool address rejected (${parsed.reason})`,
      typeof options.poolAddress === "string" ? options.poolAddress : String(options.poolAddress),
    );
  }
  if (transport === undefined || transport === null || typeof transport.fetchPage !== "function") {
    throw new LpAgentTransportUnavailableError("No LP Agent transport supplied");
  }

  const pool: PoolIdentity = { address: parsed.address, source: options.source ?? "cli" };
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const now = options.now ?? (() => new Date());
  const maxPages = options.maxPages ?? 0;

  let state: PaginationState = createEmptyPaginationState(pool.address, pageSize);
  const pages: AcquiredPage[] = [];
  let error: string | null = null;

  // Bounded loop: every iteration either advances the page set or returns.
  // The cap and the declared total together prevent an unbounded walk.
  for (let guard = 0; guard < MAX_PAGES_GUARD; guard += 1) {
    const page = nextPageState(state);
    if (page === null) {
      break;
    }
    if (maxPages > 0 && pages.length >= maxPages) {
      error = `page cap ${maxPages} reached before the declared range was covered`;
      break;
    }
    const request: LpAgentPageRequest = {
      poolAddress: pool.address,
      page,
      pageSize,
      orderBy: "total_pnl_native",
      sortOrder: "desc",
    };
    const fetched = await transport.fetchPage(request);
    if (!fetched.ok) {
      state = recordPageFailure(state, page);
      error = `page ${page} failed (${fetched.reason}${fetched.status !== null ? `, HTTP ${fetched.status}` : ""}): ${fetched.detail}`;
      break;
    }
    try {
      state = recordPageSuccess(state, page, fetched.pagination.totalPages, fetched.pagination.totalCount);
    } catch (paginationError) {
      // Inconsistent pagination is a hard stop: continuing would mix rows from
      // two different views of the pool.
      throw new LpAgentPaginationError(
        paginationError instanceof Error ? paginationError.message : "pagination inconsistency",
        { cause: paginationError },
      );
    }
    const response = mapEnvelopeOrThrow(
      { status: "success", data: fetched.rows, pagination: fetched.pagination },
      request,
      {
        provider: "lpagent",
        transport: "browser-context-fetch",
        endpointPath: `/api/v1/pools/${pool.address}/top-lpers`,
        fetchedAt: now().toISOString(),
      },
    );
    pages.push({ page, response });
  }

  return {
    pool,
    completeness: classify(state, error),
    completedPages: state.completedPages,
    missingPages: missingPagesOf(state),
    declaredTotalPages: state.totalPages,
    declaredTotalCount: state.totalCount,
    pages,
    error,
  };
}

/** Absolute ceiling on pages for one call, independent of provider claims. */
const MAX_PAGES_GUARD = 500;

function classify(state: PaginationState, error: string | null): AcquisitionCompleteness {
  if (state.totalPages === null) {
    // No page ever landed. This is not evidence that the pool is empty.
    return state.completedPages.length === 0 ? "empty" : "partial";
  }
  if (error !== null) {
    return "partial";
  }
  // A declared total of 0 is the provider reporting an empty result set: that
  // is a complete answer, so an acquisition that observed it is complete.
  return isFinalPage(state) ? "complete" : "partial";
}

function missingPagesOf(state: PaginationState): readonly number[] {
  if (state.totalPages === null) {
    return [];
  }
  const missing: number[] = [];
  for (let page = 1; page <= state.totalPages; page += 1) {
    if (!state.completedPages.includes(page)) {
      missing.push(page);
    }
  }
  return missing;
}
