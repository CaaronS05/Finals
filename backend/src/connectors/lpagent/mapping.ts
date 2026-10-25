/**
 * Response mapping for the LP Agent top-lpers endpoint.
 *
 * CONFIRMED provider contract (Rahasia evidence, cited in the architecture
 * doc):
 *   - Envelope: `{ status: "success", data: [...], pagination: { page, pageSize, totalCount, totalPages } }`
 *   - Row fields read by legacy code: `owner`, `wallet`, `total_pnl`, `win_rate`, `total_lp`
 *   - The legacy writer converts `total_pnl`/`win_rate`/`total_lp` into
 *     `pnlUsd`/`winRate`/`positions`, mapping a missing or non-finite value to
 *     `null` rather than to `0`.
 *
 * This module performs that mapping. It never invents a value: a provider
 * field that is absent or non-numeric becomes `null`, never `0`.
 */
import type {
  LpAgentPageRequest,
  LpAgentPageResponse,
  LpPositionReference,
  PaginationMetadata,
  SourceProvenance,
} from "./contracts.ts";
import { LpAgentInvalidResponseError } from "./errors.ts";

/** Shape the connector expects the provider to return, before validation. */
export interface RawLpAgentEnvelope {
  readonly status?: unknown;
  readonly data?: unknown;
  readonly pagination?: unknown;
}

/** Result of mapping a raw envelope into the connector contract. */
export type EnvelopeMapping =
  | { readonly ok: true; readonly response: LpAgentPageResponse }
  | { readonly ok: false; readonly reason: "ENVELOPE" | "MALFORMED_BODY"; readonly detail: string };

/**
 * Map a raw provider envelope into a typed page response.
 *
 * Rejects when `status` is not "success", when `data` is not an array, when
 * pagination is missing or has an impossible total. Unknown extra fields on
 * the envelope and on each row are preserved rather than discarded.
 */
export function mapEnvelope(
  raw: unknown,
  request: LpAgentPageRequest,
  provenance: SourceProvenance,
): EnvelopeMapping {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "MALFORMED_BODY", detail: "response is not a JSON object" };
  }
  const envelope = raw as RawLpAgentEnvelope;
  if (envelope.status !== "success") {
    return {
      ok: false,
      reason: "ENVELOPE",
      detail: `expected status "success", received ${describeValue(envelope.status)}`,
    };
  }
  if (!Array.isArray(envelope.data)) {
    return { ok: false, reason: "ENVELOPE", detail: "data is not an array" };
  }
  const pagination = readPagination(envelope.pagination, request);
  if (!pagination.ok) {
    return { ok: false, reason: "ENVELOPE", detail: pagination.detail };
  }
  const rows: LpPositionReference[] = [];
  for (const [index, row] of envelope.data.entries()) {
    const mapped = mapRow(row, index);
    if (!mapped.ok) {
      return { ok: false, reason: "ENVELOPE", detail: mapped.detail };
    }
    rows.push(mapped.row);
  }
  return {
    ok: true,
    response: { request, pagination: pagination.value, rows, raw: raw as Record<string, unknown>, provenance },
  };
}

/**
 * Read and validate pagination metadata.
 *
 * `totalPages` and `totalCount` must be non-negative integers. A missing
 * pagination block is an error, not a default, because a caller cannot tell
 * whether pagination is finished without it.
 */
function readPagination(value: unknown, request: LpAgentPageRequest): { ok: true; value: PaginationMetadata } | { ok: false; detail: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, detail: "pagination is missing" };
  }
  const candidate = value as { totalPages?: unknown; totalCount?: unknown; pageSize?: unknown };
  const totalPages = readNonNegativeInteger(candidate.totalPages, "totalPages");
  if (!totalPages.ok) {
    return { ok: false, detail: totalPages.detail };
  }
  const totalCount = readNonNegativeInteger(candidate.totalCount, "totalCount");
  if (!totalCount.ok) {
    return { ok: false, detail: totalCount.detail };
  }
  const pageSize = readNonNegativeInteger(candidate.pageSize, "pageSize");
  return {
    ok: true,
    value: {
      totalPages: totalPages.value,
      totalCount: totalCount.value,
      // Legacy sends pageSize 20; if the provider omits it, report the request's
      // page size rather than inventing a provider value.
      pageSize: pageSize.ok ? pageSize.value : request.pageSize,
    },
  };
}

/** Map one provider row into a position reference. */
export function mapRow(row: unknown, index: number): { ok: true; row: LpPositionReference } | { ok: false; detail: string } {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return { ok: false, detail: `row ${index} is not an object` };
  }
  const record = row as Record<string, unknown>;
  const owner = readString(record.owner);
  if (!owner.ok) {
    return { ok: false, detail: `row ${index} has no usable owner` };
  }
  const wallet = readString(record.wallet);
  return {
    ok: true,
    row: {
      owner: owner.value,
      wallet: wallet.ok ? wallet.value : null,
      totalPnl: readFiniteNumber(record.total_pnl),
      winRate: readFiniteNumber(record.win_rate),
      totalLp: readFiniteNumber(record.total_lp),
      extra: collectExtra(record, ["owner", "wallet", "total_pnl", "win_rate", "total_lp"]),
    },
  };
}

/**
 * Collect fields the contract does not name.
 *
 * Required so an upstream contract change never silently discards data. The
 * values are carried verbatim and never coerced.
 */
function collectExtra(record: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!known.includes(key)) {
      extra[key] = value;
    }
  }
  return extra;
}

/**
 * Read a finite number, or null.
 *
 * An absent, null, empty-string, or non-finite value becomes null. It is NEVER
 * coerced to 0, because 0 is a real measurement and null means unreported.
 */
function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readString(value: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof value === "string" && value.trim().length > 0) {
    return { ok: true, value };
  }
  return { ok: false };
}

function readNonNegativeInteger(value: unknown, field: string): { ok: true; value: number } | { ok: false; detail: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, detail: `${field} is not a non-negative integer (${describeValue(value)})` };
  }
  return { ok: true, value };
}

/** Describe a value for an error message without dumping a large object. */
function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object") {
    return "an object";
  }
  return JSON.stringify(value);
}

/**
 * Convenience wrapper that throws a typed error on failure.
 *
 * Used by callers that prefer exceptions to a result union.
 */
export function mapEnvelopeOrThrow(
  raw: unknown,
  request: LpAgentPageRequest,
  provenance: SourceProvenance,
): LpAgentPageResponse {
  const mapped = mapEnvelope(raw, request, provenance);
  if (!mapped.ok) {
    throw new LpAgentInvalidResponseError(`LP Agent response rejected (${mapped.reason}): ${mapped.detail}`);
  }
  return mapped.response;
}
