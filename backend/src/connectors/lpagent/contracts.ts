/**
 * LP Agent data contracts (F2-A).
 *
 * Field names marked CONFIRMED were read from the legacy Rahasia sources and
 * are cited in docs/architecture/F2A_LPAGENT_CONNECTOR.md. Fields marked
 * UNVERIFIED are placeholders for the live acquisition phase: the connector
 * does not invent provider values, so anything not confirmed is either absent
 * from the contract or carried through untyped.
 *
 * The legacy response envelope is `{ status: "success", data: [...], pagination: { totalPages, totalCount } }`
 * (confirmed at scripts/pool/scan-selected-pools.mjs:716-720 and :833-835).
 */

/** A Meteora DLMM pool the connector was asked about. */
export interface PoolIdentity {
  /** Base58 address, case preserved exactly as supplied. */
  readonly address: string;
  /** How the address reached the connector. Provenance, not validation. */
  readonly source: "cli" | "config" | "discovery";
}

/**
 * Result of resolving a pool's metadata.
 *
 * `resolved: false` means the provider did not confirm the pool. It is never
 * merged into an empty metadata object, because "unknown" and "does not exist"
 * are different facts.
 */
export interface PoolMetadataResult {
  readonly pool: PoolIdentity;
  /** True only when the provider explicitly confirmed this pool. */
  readonly resolved: boolean;
  /**
   * Provider-reported pair label, e.g. "TOKEN/SOL".
   *
   * CONFIRMED as a legacy output field (`pair`, scan-selected-pools.mjs:937).
   * Null when the provider did not report it.
   */
  readonly pair: string | null;
  /** Bin step as reported by the provider. UNVERIFIED: not read from LP Agent responses in legacy code. */
  readonly binStep: number | null;
  /** Base fee percentage as reported by the provider. UNVERIFIED: sourced from Meteora Data API in legacy code, not LP Agent. */
  readonly baseFeePct: number | null;
  /** Where this result came from. */
  readonly provenance: SourceProvenance;
}

/** A position row as reported by the LP Agent top-lpers endpoint. */
export interface LpPositionReference {
  /** CONFIRMED field `owner` (scan-selected-pools.mjs:864-916). */
  readonly owner: string;
  /** CONFIRMED field `wallet` (scan-selected-pools.mjs:864-916). May equal `owner`. */
  readonly wallet: string | null;
  /** CONFIRMED field `total_pnl` (scan-selected-pools.mjs:864-916). */
  readonly totalPnl: number | null;
  /** CONFIRMED field `win_rate` (scan-selected-pools.mjs:864-916). */
  readonly winRate: number | null;
  /** CONFIRMED field `total_lp` (scan-selected-pools.mjs:864-916). */
  readonly totalLp: number | null;
  /**
   * Unknown provider fields preserved verbatim.
   *
   * Required so a contract change upstream never silently discards data. The
   * connector MUST NOT enumerate, coerce, or default these values.
   */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Wallet identity for an LP position holder. */
export interface WalletOwnerIdentity {
  /** Base58 wallet address, case preserved. */
  readonly address: string;
  /**
   * True when this address is the position owner rather than a delegate.
   *
   * UNVERIFIED: legacy code reads `row.owner` without distinguishing owner
   * from delegate, so this flag is not yet derived from evidence.
   */
  readonly isOwner: boolean | null;
}

/** Pagination metadata reported by the provider. */
export interface PaginationMetadata {
  /** CONFIRMED field `pagination.totalPages` (scan-selected-pools.mjs:833-835). */
  readonly totalPages: number;
  /** CONFIRMED field `pagination.totalCount` (scan-selected-pools.mjs:833-835). */
  readonly totalCount: number;
  /** Page size the request used. CONFIRMED value `20` (scan-selected-pools.mjs:663-667). */
  readonly pageSize: number;
}

/** Where an acquired value came from. */
export interface SourceProvenance {
  /** Provider identifier. */
  readonly provider: "lpagent";
  /** How the request was executed. */
  readonly transport: "browser-context-fetch" | "node-fetch";
  /**
   * CONFIRMED endpoint path used by legacy pool scanning
   * (`/api/v1/pools/{address}/top-lpers`, scan-selected-pools.mjs:662-707).
   */
  readonly endpointPath: string;
  /** ISO-8601 timestamp of the fetch, recorded by the connector. */
  readonly fetchedAt: string;
}

/**
 * Outcome of a single page fetch.
 *
 * `ok: false` carries the failure. It is never converted to an empty page,
 * because an empty page and a failed page mean different things.
 */
export type SourceFetchResult =
  | { readonly ok: true; readonly rows: readonly LpPositionReference[]; readonly pagination: PaginationMetadata }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly reason: "TRANSPORT" | "HTTP_STATUS" | "TIMEOUT" | "MALFORMED_BODY" | "ENVELOPE";
      readonly detail: string;
    };

/** Whether an acquisition covers the provider's declared page range. */
export type AcquisitionCompleteness = "complete" | "partial" | "empty";

/** One page request, fully specified so it can be replayed or logged. */
export interface LpAgentPageRequest {
  /** Case-preserved pool address. */
  readonly poolAddress: string;
  /** 1-based page number, matching the legacy `page` parameter. */
  readonly page: number;
  /** Page size. Legacy uses 20. */
  readonly pageSize: number;
  /** CONFIRMED legacy `order_by` value. */
  readonly orderBy: "total_pnl_native";
  /** CONFIRMED legacy `sort_order` value. */
  readonly sortOrder: "desc";
}

/**
 * A page response as mapped by the connector.
 *
 * `rows` are the mapped position references. `raw` preserves the provider
 * envelope so nothing is lost to mapping, including fields not yet typed.
 */
export interface LpAgentPageResponse {
  readonly request: LpAgentPageRequest;
  readonly pagination: PaginationMetadata;
  readonly rows: readonly LpPositionReference[];
  readonly raw: Readonly<Record<string, unknown>>;
  readonly provenance: SourceProvenance;
}

/**
 * Transport seam for LP Agent acquisition.
 *
 * Implementations execute ONE page request. The connector owns pagination and
 * mapping; the transport owns only "given this request, return rows or a
 * failure". No Playwright object crosses this seam.
 */
export interface LpAgentTransport {
  /**
   * Fetch a single page. Must reject on transport failure rather than
   * returning an empty page.
   */
  fetchPage(request: LpAgentPageRequest): Promise<SourceFetchResult>;
  /** Human-readable description for logs. Never a credential or a session id. */
  describe(): string;
}
