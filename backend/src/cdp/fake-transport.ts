/**
 * In-memory fake transport for tests. Never opens a socket, never imports
 * playwright, never needs CloakBrowser or network access.
 *
 * Determinism: each attach is parked on a promise the test releases through
 * `land()`, so "the timeout fires first, then the browser lands" is reproduced
 * exactly rather than approximated by a sleep. No wall-clock timers are used.
 *
 * The fake also records whether a session that landed after a detach was
 * released, which is the regression this file exists to expose.
 */
import type { CdpConnectOptions, CdpSessionInfo, CdpTransport } from "./connection.ts";

export class FakeCdpTransport implements CdpTransport {
  connectCalls = 0;
  disconnectCalls = 0;
  connected = false;
  lastOptions: CdpConnectOptions | null = null;

  /**
   * True when an attach landed after `disconnect()` ran and the session it
   * opened was released. A correct transport must set this.
   */
  lateSessionReleased = false;
  /** True when an attach landed after a detach and left the session open. */
  lateSessionLeaked = false;

  private pendingBrowser: { released: boolean } | null = null;
  private detachDuringConnect = false;

  /** Resolver for the attach currently in flight, if any. */
  private release: (() => void) | null = null;

  private readonly behaviour: {
    /** When set, connect rejects with this value. */
    readonly failWith?: unknown;
  };

  constructor(
    behaviour: {
      readonly failWith?: unknown;
    } = {},
  ) {
    this.behaviour = behaviour;
  }

  /**
   * Release a parked attach. Awaiting the returned promise observes the
   * attach's outcome, including a rejection it raises after the caller gave up.
   */
  async land(): Promise<void> {
    const release = this.release;
    this.release = null;
    release?.();
    // Yield twice so the released attach settles before the caller asserts.
    await Promise.resolve();
    await Promise.resolve();
  }

  async connect(options: CdpConnectOptions): Promise<CdpSessionInfo> {
    this.connectCalls += 1;
    this.lastOptions = options;
    this.detachDuringConnect = false;
    this.pendingBrowser = { released: false };

    const { promise, resolve } = Promise.withResolvers<void>();
    this.release = resolve;
    try {
      await promise;
    } finally {
      this.release = null;
    }

    const handle = this.pendingBrowser;
    this.pendingBrowser = null;
    const landedAfterDetach = this.detachDuringConnect && handle !== null;

    if (landedAfterDetach) {
      // A detach ran while this attach was in flight. The session it opened
      // must be released rather than left attached with no owner.
      this.lateSessionReleased = true;
      throw new Error("connect landed after detach");
    }

    if (this.behaviour.failWith !== undefined) {
      throw this.behaviour.failWith;
    }

    this.connected = true;
    return { endpoint: options.endpoint, browserVersion: "FakeBrowser/0.0.0" };
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    if (this.pendingBrowser !== null) {
      this.detachDuringConnect = true;
      return;
    }
    this.connected = false;
  }
}
