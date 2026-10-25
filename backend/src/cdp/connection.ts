/**
 * Reusable CloakBrowser / CDP connection boundary.
 *
 * DESIGN INTENT (F0)
 * ------------------
 * This module defines the contract every browser-backed workflow depends on.
 * The concrete transport is injected, so:
 *
 *   - tests run with a fake transport and never touch a real browser;
 *   - the real playwright-core adapter can be added later without changing
 *     any caller;
 *   - a missing CDP endpoint degrades to a typed error instead of a crash.
 *
 * CONNECTIONS ARE OPT-IN AND LAZY
 * -------------------------------
 * Nothing here connects at import time or at application startup. A session
 * exists only between an explicit `connect()` and the matching `disconnect()`.
 *
 * ATTACH-ONLY SEMANTICS
 * ---------------------
 * CloakBrowser is a user-operated browser holding a real session. The backend
 * attaches to it; it never launches it, never reads cookies, never exports
 * tokens, and never persists a profile. Disconnecting detaches the CDP
 * transport and leaves the browser running untouched.
 */

import {
  CdpConnectTimeoutError,
  CdpDisconnectedError,
  CdpOperationError,
  CdpUnavailableError,
  sanitizeError,
} from "../errors.ts";

/** Lifecycle state of a CDP session. */
export type CdpConnectionStatus = "disconnected" | "connecting" | "connected";

/** Minimal description of the browser behind a live session. */
export interface CdpSessionInfo {
  /** Endpoint the session is attached to. */
  readonly endpoint: string;
  /** Browser version string, when the transport can report it. */
  readonly browserVersion: string | null;
}

export interface CdpConnectOptions {
  /** Loopback CDP endpoint URL. */
  readonly endpoint: string;
  /** Connection timeout in milliseconds. `0` disables the timeout. */
  readonly timeoutMs: number;
}

/**
 * Transport seam.
 *
 * A transport performs the raw CDP attach. It is deliberately tiny: it knows
 * how to open, describe, and release a connection, and nothing else. Business
 * logic (scraping, ETL, scanning) must live above this seam and is out of F0
 * scope.
 */
export interface CdpTransport {
  /** Open the connection. Must reject if the endpoint is unreachable. */
  connect(options: CdpConnectOptions): Promise<CdpSessionInfo>;
  /** Release the connection. Must be idempotent and never throw. */
  disconnect(): Promise<void>;
}

/** Thrown when a session-requiring operation runs without a live session. */
export class CdpNotConnectedError extends CdpOperationError {
  constructor(operation: string) {
    super(`Cannot ${operation}: no active CDP session`);
  }
}

/**
 * Connection manager enforcing the lifecycle rules above.
 *
 * A single instance owns at most one session. Concurrent `connect()` calls
 * while a session is active are rejected rather than silently reattached.
 */
export class CdpConnection {
  private readonly transport: CdpTransport;
  private status: CdpConnectionStatus = "disconnected";
  private session: CdpSessionInfo | null = null;

  constructor(transport: CdpTransport) {
    this.transport = transport;
  }

  getStatus(): CdpConnectionStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status === "connected";
  }

  getSessionInfo(): CdpSessionInfo | null {
    return this.session;
  }

  /**
   * Attach to the configured CDP endpoint.
   *
   * Throws:
   *   - CdpUnavailableError     — endpoint not reachable
   *   - CdpConnectTimeoutError  — attach exceeded the timeout
   *   - CdpOperationError       — session already active or attempt in flight
   */
  async connect(options: CdpConnectOptions): Promise<CdpSessionInfo> {
    if (this.status === "connected") {
      throw new CdpOperationError(
        `Cannot connect: a CDP session is already active at ${this.session?.endpoint ?? "unknown endpoint"}`,
      );
    }
    if (this.status === "connecting") {
      throw new CdpOperationError("Cannot connect: a CDP connection attempt is already in progress");
    }

    this.status = "connecting";
    try {
      const info = await this.attach(options);
      this.session = info;
      this.status = "connected";
      return info;
    } catch (error) {
      // Always leave the manager in a clean, reusable state on failure.
      await this.disconnect();
      throw error;
    }
  }

  /**
   * Detach from the browser. Idempotent.
   *
   * The browser process itself is never closed: detaching only drops the CDP
   * transport so the user's session survives untouched.
   */
  async disconnect(): Promise<void> {
    const wasActive = this.status !== "disconnected";
    this.session = null;
    this.status = "disconnected";
    if (!wasActive) {
      return;
    }
    try {
      await this.transport.disconnect();
    } catch {
      // A failing detach must never mask the original error. The manager is
      // already marked disconnected, so the session is logically released.
    }
  }

  /**
   * Guard for operations that require a live session.
   * Throws CdpNotConnectedError when no session is active.
   */
  requireSession(): CdpSessionInfo {
    if (this.status !== "connected" || this.session === null) {
      throw new CdpNotConnectedError("perform this operation");
    }
    return this.session;
  }

  private async attach(options: CdpConnectOptions): Promise<CdpSessionInfo> {
    // Normalize transport failures once, at the boundary, so no raw network
    // error ever escapes toward a caller or an HTTP response.
    const attached = this.transport.connect(options).then(
      (info) => info,
      (error: unknown) => {
        throw this.toTransportError(error, options);
      },
    );

    if (options.timeoutMs <= 0) {
      return attached;
    }

    const { promise, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new CdpConnectTimeoutError(options.timeoutMs)), options.timeoutMs);
    try {
      return await Promise.race([attached, promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private toTransportError(error: unknown, options: CdpConnectOptions): Error {
    if (
      error instanceof CdpUnavailableError ||
      error instanceof CdpConnectTimeoutError ||
      error instanceof CdpDisconnectedError
    ) {
      return error;
    }
    const message = sanitizeError(error);
    return new CdpUnavailableError(`CDP endpoint unreachable at ${options.endpoint}: ${message}`, {
      cause: error,
    });
  }
}

/**
 * In-memory fake transport for tests. Never opens a socket, never imports
 * playwright, never needs CloakBrowser or network access.
 */
export class FakeCdpTransport implements CdpTransport {
  connectCalls = 0;
  disconnectCalls = 0;
  connected = false;
  lastOptions: CdpConnectOptions | null = null;

  private readonly behaviour: {
    /** Delay before the fake connect settles. Used for timeout tests. */
    readonly delayMs?: number;
    /** When set, connect rejects with this value. */
    readonly failWith?: unknown;
  };

  constructor(
    behaviour: {
      readonly delayMs?: number;
      readonly failWith?: unknown;
    } = {},
  ) {
    this.behaviour = behaviour;
  }

  async connect(options: CdpConnectOptions): Promise<CdpSessionInfo> {
    this.connectCalls += 1;
    this.lastOptions = options;
    const delayMs = this.behaviour.delayMs ?? 0;
    if (delayMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, delayMs);
      await promise;
    }
    if (this.behaviour.failWith !== undefined) {
      throw this.behaviour.failWith;
    }
    this.connected = true;
    return { endpoint: options.endpoint, browserVersion: "FakeBrowser/0.0.0" };
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
  }
}
