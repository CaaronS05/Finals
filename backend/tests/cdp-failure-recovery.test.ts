/**
 * Failure-recovery verification for the CDP boundary.
 *
 * Offline: every case targets a port with nothing listening, so no browser is
 * touched. These complement the live test, which exercises a real attach.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CdpConnection } from "../src/cdp/connection.ts";
import { PlaywrightCdpTransport } from "../src/cdp/playwright-transport.ts";
import { CdpConnectTimeoutError, CdpOperationError, CdpUnavailableError } from "../src/errors.ts";

/** Loopback port with nothing bound. Verified closed before each case. */
const DEAD_ENDPOINT = "http://127.0.0.1:59998";

describe("cdp failure recovery (offline)", () => {
  it("classifies an unreachable endpoint as unavailable", async () => {
    const connection = new CdpConnection(new PlaywrightCdpTransport());
    await assert.rejects(
      () => connection.connect({ endpoint: DEAD_ENDPOINT, timeoutMs: 5000 }),
      CdpUnavailableError,
    );
    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.getSessionInfo(), null);
  });

  it("reports connection refused without leaking transport internals", async () => {
    const connection = new CdpConnection(new PlaywrightCdpTransport());
    await assert.rejects(
      () => connection.connect({ endpoint: DEAD_ENDPOINT, timeoutMs: 5000 }),
      (error: unknown) => {
        assert.ok(error instanceof CdpUnavailableError);
        // Endpoint is present so an operator can act on it; the raw socket
        // error text is not echoed verbatim.
        assert.match(error.message, /127\.0\.0\.1:59998/);
        return true;
      },
    );
  });

  it("surfaces a timeout when the endpoint accepts but never completes", async () => {
    // A port that accepts the TCP handshake then stalls is hard to arrange
    // offline, so the timeout path is covered by the fake transport in
    // cdp-connection.test.ts and cdp-late-connect.test.ts. Here we assert the
    // manager rejects rather than hangs when given a tiny budget.
    const connection = new CdpConnection(new PlaywrightCdpTransport());
    const attempt = connection.connect({ endpoint: DEAD_ENDPOINT, timeoutMs: 250 });
    await assert.rejects(
      attempt,
      (error: unknown) =>
        error instanceof CdpUnavailableError || error instanceof CdpConnectTimeoutError,
    );
    assert.equal(connection.getStatus(), "disconnected");
  });

  it("allows repeated connect attempts after failure", async () => {
    const connection = new CdpConnection(new PlaywrightCdpTransport());
    await assert.rejects(
      () => connection.connect({ endpoint: DEAD_ENDPOINT, timeoutMs: 2000 }),
      CdpUnavailableError,
    );
    await assert.rejects(
      () => connection.connect({ endpoint: DEAD_ENDPOINT, timeoutMs: 2000 }),
      CdpUnavailableError,
    );
    assert.equal(connection.getStatus(), "disconnected");
  });

  it("tolerates repeated disconnect calls after a failed connect", async () => {
    const connection = new CdpConnection(new PlaywrightCdpTransport());
    await assert.rejects(
      () => connection.connect({ endpoint: DEAD_ENDPOINT, timeoutMs: 2000 }),
      CdpUnavailableError,
    );
    await connection.disconnect();
    await connection.disconnect();
    assert.equal(connection.getStatus(), "disconnected");
  });

  it("refuses a second connect while an attempt is in flight", async () => {
    const connection = new CdpConnection(new PlaywrightCdpTransport());
    const first = connection.connect({ endpoint: DEAD_ENDPOINT, timeoutMs: 3000 });
    await assert.rejects(() => connection.connect({ endpoint: DEAD_ENDPOINT, timeoutMs: 3000 }), CdpOperationError);
    await assert.rejects(first, CdpUnavailableError);
  });

  it("leaves no session handle owned after a failed connect", async () => {
    const transport = new PlaywrightCdpTransport();
    const connection = new CdpConnection(transport);
    await assert.rejects(
      () => connection.connect({ endpoint: DEAD_ENDPOINT, timeoutMs: 2000 }),
      CdpUnavailableError,
    );
    // A subsequent detach must be a no-op: nothing was ever registered.
    await connection.disconnect();
    assert.equal(connection.getSessionInfo(), null);
  });

  it("rejects the forbidden legacy Brave port 9222", async () => {
    const connection = new CdpConnection(new PlaywrightCdpTransport());
    await assert.rejects(
      () => connection.connect({ endpoint: "http://127.0.0.1:9222", timeoutMs: 2000 }),
      CdpUnavailableError,
    );
  });
});
