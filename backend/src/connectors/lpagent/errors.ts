/**
 * LP Agent connector errors.
 *
 * Extends the F0/F1 error hierarchy so every failure is typed, sanitized, and
 * carries a machine-readable code. A provider problem is never represented as
 * an empty but valid result.
 */
import { BackendError } from "../../errors.ts";

/** Error codes specific to the LP Agent connector. */
export type LpAgentErrorCode =
  | "LPAGENT_INVALID_POOL_ADDRESS"
  | "LPAGENT_TRANSPORT_UNAVAILABLE"
  | "LPAGENT_REQUEST_FAILED"
  | "LPAGENT_INVALID_RESPONSE"
  | "LPAGENT_PAGINATION_INCONSISTENT"
  | "LPAGENT_PARTIAL_RESULT";

/** Base class for every LP Agent connector failure. */
export class LpAgentError extends BackendError {
  constructor(code: LpAgentErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, { cause: options?.cause });
  }
}

/**
 * Pool address input failed syntactic validation.
 *
 * Distinct from a pool that does not exist: this is a malformed or empty
 * string, decided without contacting the provider.
 */
export class LpAgentInvalidPoolAddressError extends LpAgentError {
  readonly input: string;
  constructor(message: string, input: string, options?: { cause?: unknown }) {
    super("LPAGENT_INVALID_POOL_ADDRESS", message, { cause: options?.cause });
    this.input = input;
  }
}

/**
 * No browser transport is available to execute a provider request.
 *
 * The connector never owns the browser. When the injected transport is absent
 * or refuses, the acquisition fails rather than degrading to empty data.
 */
export class LpAgentTransportUnavailableError extends LpAgentError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("LPAGENT_TRANSPORT_UNAVAILABLE", message, { cause: options?.cause });
  }
}

/**
 * The provider request itself failed: transport error, non-OK HTTP status, or
 * timeout. Retryability is not implied; callers decide.
 */
export class LpAgentRequestError extends LpAgentError {
  readonly status: number | null;
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super("LPAGENT_REQUEST_FAILED", message, { cause: options?.cause });
    this.status = options?.status ?? null;
  }
}

/**
 * The provider returned a payload the connector cannot map to its contract.
 *
 * Raised when the envelope is wrong, a required field is missing, or a field
 * has an impossible type. Never used to silently drop unknown extra fields.
 */
export class LpAgentInvalidResponseError extends LpAgentError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("LPAGENT_INVALID_RESPONSE", message, { cause: options?.cause });
  }
}

/**
 * Pagination metadata contradicts observed pages: a repeated page, a
 * shrinking total, a page beyond the declared total, or a gap.
 */
export class LpAgentPaginationError extends LpAgentError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("LPAGENT_PAGINATION_INCONSISTENT", message, { cause: options?.cause });
  }
}

/**
 * Acquisition stopped before the declared page range was covered.
 *
 * Carries the completed page set so a caller can resume or report honestly.
 * An empty `pages` array means nothing was acquired, not that the pool is
 * empty.
 */
export class LpAgentPartialResultError extends LpAgentError {
  readonly completedPages: readonly number[];
  readonly remainingPages: readonly number[];
  constructor(
    message: string,
    options: { completedPages: readonly number[]; remainingPages: readonly number[]; cause?: unknown },
  ) {
    super("LPAGENT_PARTIAL_RESULT", message, { cause: options.cause });
    this.completedPages = options.completedPages;
    this.remainingPages = options.remainingPages;
  }
}
