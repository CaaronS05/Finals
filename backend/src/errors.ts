/**
 * Typed, sanitized error hierarchy for the DLLM Finals backend.
 *
 * Every error message produced here MUST be safe to log and safe to return to
 * a local caller. No credentials, cookies, tokens, headers, or raw browser
 * session state may appear in any message.
 */
import type { LpAgentErrorCode } from "./connectors/lpagent/errors.ts";

/**
 * Machine-readable error codes.
 *
 * The LP Agent codes are declared by the connector module rather than here, so
 * this union stays open to extension by composing them.
 */
export type BackendErrorCode =
  | "CONFIG_INVALID"
  | "CDP_UNAVAILABLE"
  | "CDP_CONNECT_TIMEOUT"
  | "CDP_DISCONNECTED"
  | "CDP_OPERATION_FAILED";
/** Connector error codes are registered into this union at the module boundary. */
export type { LpAgentErrorCode as LpAgentConnectorErrorCode } from "./connectors/lpagent/errors.ts";

/**
 * Base class for all errors surfaced by the backend.
 *
 * `message` is always sanitized and safe for logs and HTTP responses.
 * `cause` is retained for local debugging only and MUST never be serialized
 * into a response body or an external log line.
 */
export class BackendError extends Error {
  /**
   * Machine-readable code. A connector may register its own codes, so the
   * field accepts the base union or a registered connector union.
   */
  readonly code: BackendErrorCode | LpAgentErrorCode;

  constructor(code: BackendErrorCode | LpAgentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

/** Raised when runtime configuration fails validation. */
export class ConfigError extends BackendError {
  readonly field: string | undefined;

  constructor(message: string, options?: { field?: string; cause?: unknown }) {
    super("CONFIG_INVALID", message, { cause: options?.cause });
    this.field = options?.field;
  }
}

/** Raised when the CDP endpoint cannot be reached at all. */
export class CdpUnavailableError extends BackendError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CDP_UNAVAILABLE", message, { cause: options?.cause });
  }
}

/** Raised when a CDP connection attempt exceeds its timeout. */
export class CdpConnectTimeoutError extends BackendError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(
      "CDP_CONNECT_TIMEOUT",
      `CDP connection did not complete within ${timeoutMs}ms`,
      { cause: options?.cause },
    );
    this.timeoutMs = timeoutMs;
  }
}

/** Raised when an established CDP session drops. */
export class CdpDisconnectedError extends BackendError {
  constructor(message = "CDP session disconnected", options?: { cause?: unknown }) {
    super("CDP_DISCONNECTED", message, { cause: options?.cause });
  }
}

/** Raised when a CDP operation fails against an established session. */
export class CdpOperationError extends BackendError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CDP_OPERATION_FAILED", message, { cause: options?.cause });
  }
}

/** Narrow an unknown thrown value to an Error-like message, sanitized. */
export function toErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  return "unknown error";
}

/**
 * Sanitize an unknown thrown value into a public-safe string.
 *
 * Drops stack traces and truncates, so that no caller can accidentally leak a
 * browser path, session identifier, or URL fragment into a response.
 */
export function sanitizeError(value: unknown, maxLength = 200): string {
  const message = toErrorMessage(value).replace(/\s+/g, " ").trim();
  if (message.length === 0) {
    return "unknown error";
  }
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}
