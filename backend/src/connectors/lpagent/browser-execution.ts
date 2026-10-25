/**
 * Browser execution boundary (F2-B).
 *
 * This module defines the ONLY seam through which the LP Agent transport
 * reaches a browser. It exists so that:
 *
 *   - CDP infrastructure owns connection, context selection, page lifecycle,
 *     cleanup, and the execution of explicitly permitted operations;
 *   - the LP Agent domain never sees a Playwright `Browser`, `Page`, or
 *     `Context` object;
 *   - tests run against a fake executor with no browser attached at all.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * - It does not connect to a browser. Connection is owned by `CdpConnection`
 *   (F0/F1) and must already be established by the caller.
 * - It does not close a browser, terminate a process, or navigate a tab that
 *   DLLM does not own.
 * - It does not import `playwright-core`. The concrete adapter lives in a
 *   separate file and is constructed only by a caller that already holds an
 *   attached session.
 */
import { LpAgentRequestError } from "./errors.ts";

/**
 * One browser-context HTTP request, already fully constructed.
 *
 * The executor never builds a URL. It executes what it is given and reports
 * what came back, so request construction stays in the LP Agent transport
 * where the provider contract is known.
 */
export interface BrowserHttpRequest {
  /** Absolute URL. Must be an https LP Agent origin. */
  readonly url: string;
  /** HTTP method. Only GET is used by the confirmed contract. */
  readonly method: "GET";
  /** Headers to send. Never credentials, cookies, or tokens. */
  readonly headers: Readonly<Record<string, string>>;
  /** Whether to attach ambient browser credentials. Legacy uses "include". */
  readonly credentials: "include" | "omit" | "same-origin";
  /** Request timeout in milliseconds. Bounded, never unbounded. */
  readonly timeoutMs: number;
}

/** A response as observed by the browser executor. */
export interface BrowserHttpResponse {
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;
  /** Response body as text. Empty when the request failed before a body. */
  readonly body: string;
  /** `retry-after` header value when present, in seconds. */
  readonly retryAfterSeconds: number | null;
  /** True when the failure was a timeout rather than a status or network error. */
  readonly timedOut: boolean;
}

/** Failure modes the executor can report. */
export type BrowserExecutionFailure = "TIMEOUT" | "NETWORK" | "NAVIGATION_BLOCKED";

/**
 * Browser execution seam.
 *
 * Implementations perform exactly one request inside an existing browser
 * context. A failure is reported as a rejected promise carrying a typed reason,
 * never as an empty successful response.
 */
export interface BrowserExecutor {
  /**
   * Execute one request.
   *
   * Resolves with the observed response, including a non-OK status. Rejects
   * with `BrowserExecutionFailure` when no response was obtained at all.
   */
  execute(request: BrowserHttpRequest): Promise<BrowserHttpResponse>;
  /** Release every page this executor created. Never closes the browser. */
  dispose(): Promise<void>;
  /** Human-readable description for logs. Never a session id or a path. */
  describe(): string;
}

/** Thrown by an executor when a request cannot be executed at all. */
export class BrowserExecutionError extends Error {
  readonly failure: BrowserExecutionFailure;
  constructor(failure: BrowserExecutionFailure, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BrowserExecutionError";
    this.failure = failure;
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

/**
 * Convert an executor rejection into a typed LP Agent transport failure.
 *
 * A timeout and a network error are distinct from an HTTP status: the provider
 * never answered, so there is no status to report.
 */
export function toRequestError(error: unknown): LpAgentRequestError {
  if (error instanceof BrowserExecutionError) {
    return new LpAgentRequestError(`Browser execution failed (${error.failure})`, { cause: error });
  }
  return new LpAgentRequestError("Browser execution failed", { cause: error });
}

/** Known LP Agent origins. Anything else is refused before a request runs. */
export const ALLOWED_LP_AGENT_ORIGINS: readonly string[] = ["https://api.lpagent.io"];

/**
 * Confirm a URL targets a known LP Agent origin over https.
 *
 * Checked before any request is built, so a malformed or off-provider target
 * cannot reach the browser.
 */
export function isAllowedLpAgentUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  return ALLOWED_LP_AGENT_ORIGINS.includes(parsed.origin);
}
