/**
 * Transport-independent pagination state for LP Agent acquisition.
 *
 * F2-A implements only the bookkeeping that can be justified from confirmed
 * legacy evidence. The live pagination protocol is F2-C.
 *
 * CONFIRMED LEGACY CONTRACT
 * -------------------------
 * - 1-based `page` parameter, `pageSize` 20 (scan-selected-pools.mjs:663-667).
 * - The provider reports `pagination.totalPages` and `pagination.totalCount`
 *   on the first page (scan-selected-pools.mjs:833-835).
 * - Legacy walks pages `1..totalPages` (pool-scanner-v1.mjs:278-316).
 *
 * NO INFINITE LOOPS
 * -----------------
 * Every transition is bounded by `totalPages`. A page count that never
 * decreases cannot keep the loop alive, and a repeated page is an error rather
 * than a reason to continue.
 */

/** Immutable pagination bookkeeping for one acquisition. */
export interface PaginationState {
  /** Pool address this state belongs to, case preserved. */
  readonly poolAddress: string;
  /** Page size in use. */
  readonly pageSize: number;
  /** Total pages as declared by the provider. Null until the first page lands. */
  readonly totalPages: number | null;
  /** Total rows as declared by the provider. Null until the first page lands. */
  readonly totalCount: number | null;
  /** Pages that returned rows, ascending, no duplicates. */
  readonly completedPages: readonly number[];
  /** Pages that failed, ascending, no duplicates. */
  readonly failedPages: readonly number[];
}

/** Fresh state before any page has been fetched. */
export function createEmptyPaginationState(poolAddress: string, pageSize: number): PaginationState {
  return {
    poolAddress,
    pageSize,
    totalPages: null,
    totalCount: null,
    completedPages: [],
    failedPages: [],
  };
}

/**
 * Record a successful page.
 *
 * Rejects a duplicate page: a provider that returns the same page twice is
 * reporting inconsistent state, and continuing would silently inflate the row
 * set. Also rejects a page beyond the declared total, which indicates the
 * declared total changed mid-acquisition.
 *
 * A declared total of 0 is allowed on page 1: the provider is reporting an
 * empty result set. It is rejected on any later page, because a total that
 * drops to zero mid-walk contradicts pages already returned.
 */
export function recordPageSuccess(state: PaginationState, page: number, totalPages: number, totalCount: number): PaginationState {
  if (state.completedPages.includes(page)) {
    throw new PaginationDuplicateError(state.poolAddress, page);
  }
  if (state.totalPages !== null && totalPages !== state.totalPages) {
    throw new PaginationTotalChangedError(state.poolAddress, state.totalPages, totalPages);
  }
  if (totalPages === 0 && page > 1) {
    throw new PaginationBeyondTotalError(state.poolAddress, page, 0);
  }
  if (totalPages > 0 && page > totalPages) {
    throw new PaginationBeyondTotalError(state.poolAddress, page, totalPages);
  }
  return {
    ...state,
    totalPages,
    totalCount,
    completedPages: [...state.completedPages, page].sort((a, b) => a - b),
  };
}

/** Record a failed page. Duplicate failures are ignored, not an error. */
export function recordPageFailure(state: PaginationState, page: number): PaginationState {
  if (state.failedPages.includes(page)) {
    return state;
  }
  return {
    ...state,
    failedPages: [...state.failedPages, page].sort((a, b) => a - b),
  };
}

/**
 * Pages still missing, ascending.
 *
 * A failed page that later succeeds is removed, because `completedPages` is
 * authoritative and the two sets are never merged into a count.
 *
 * A declared total of 0 has no missing pages: the provider reported an empty
 * result set, which is a complete answer, not an incomplete one.
 */
export function remainingPages(state: PaginationState): readonly number[] {
  if (state.totalPages === null) {
    return [];
  }
  if (state.totalPages === 0) {
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

/**
 * True when every declared page has returned rows.
 *
 * Returns false when the total is unknown, because completeness cannot be
 * claimed from one page. Returns true for a declared total of 0, because an
 * empty result set is a complete answer.
 */
export function isFinalPage(state: PaginationState): boolean {
  if (state.totalPages === null) {
    return false;
  }
  return remainingPages(state).length === 0;
}

/**
 * Next page to request, or null when acquisition is complete.
 *
 * Always bounded by `totalPages`, so a provider that keeps offering pages
 * cannot keep the loop alive. Returns null for a declared total of 0, so the
 * connector stops after observing the empty set.
 */
export function nextPageState(state: PaginationState): number | null {
  if (state.totalPages === null) {
    return 1;
  }
  if (state.totalPages === 0) {
    return null;
  }
  const missing = remainingPages(state);
  return missing.length > 0 ? missing[0]! : null;
}

/** Raised when a page that already returned rows is returned again. */
export class PaginationDuplicateError extends Error {
  readonly poolAddress: string;
  readonly page: number;
  constructor(poolAddress: string, page: number) {
    super(`Duplicate page ${page} for pool ${poolAddress}`);
    this.name = "PaginationDuplicateError";
    this.poolAddress = poolAddress;
    this.page = page;
  }
}

/** Raised when the declared total changes during one acquisition. */
export class PaginationTotalChangedError extends Error {
  readonly poolAddress: string;
  readonly previous: number;
  readonly current: number;
  constructor(poolAddress: string, previous: number, current: number) {
    super(`Declared total pages changed from ${previous} to ${current} for pool ${poolAddress}`);
    this.name = "PaginationTotalChangedError";
    this.poolAddress = poolAddress;
    this.previous = previous;
    this.current = current;
  }
}

/** Raised when a page beyond the declared total is recorded. */
export class PaginationBeyondTotalError extends Error {
  readonly poolAddress: string;
  readonly page: number;
  readonly totalPages: number;
  constructor(poolAddress: string, page: number, totalPages: number) {
    super(`Page ${page} exceeds declared total ${totalPages} for pool ${poolAddress}`);
    this.name = "PaginationBeyondTotalError";
    this.poolAddress = poolAddress;
    this.page = page;
    this.totalPages = totalPages;
  }
}
