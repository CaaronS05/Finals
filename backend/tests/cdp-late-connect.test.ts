import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CdpConnection, FakeCdpTransport } from "../src/cdp/index.ts";
import { CdpConnectTimeoutError } from "../src/errors.ts";

const OPTIONS: { endpoint: string; timeoutMs: number } = {
  endpoint: "http://127.0.0.1:9223",
  timeoutMs: 1000,
};

/**
 * Regression coverage for the timeout / late-connect defect.
 *
 * A CDP attach that lands after the caller gave up must not resurrect a
 * session, must not double-detach, and must not raise an unhandled rejection.
 * Time is driven by an explicit `land()` signal, never by a wall-clock sleep.
 */

describe("cdp: late connect after timeout", () => {
  it("rejects with a timeout error, not the late session", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);

    const attempt = connection.connect({ ...OPTIONS, timeoutMs: 5 });
    // The attach is parked; the 5ms timeout must win.
    await assert.rejects(attempt, CdpConnectTimeoutError);

    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.isConnected(), false);
    assert.equal(connection.getSessionInfo(), null);

    // Now let the browser land, after the caller already gave up.
    await transport.land();

    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.getSessionInfo(), null);
  });

  it("detaches exactly once, never resurrecting a session", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);

    await assert.rejects(
      connection.connect({ ...OPTIONS, timeoutMs: 5 }),
      CdpConnectTimeoutError,
    );

    await transport.land();

    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.getSessionInfo(), null);
    assert.equal(transport.disconnectCalls, 1);
    // The transport never reported a live session.
    assert.equal(transport.connected, false);
    // A session that landed after the detach was released, not stranded.
    assert.equal(transport.lateSessionLeaked, false);
    assert.equal(transport.lateSessionReleased, true);
  });

  it("does not raise an unhandled rejection when a late attach fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const transport = new FakeCdpTransport({ failWith: new Error("late failure") });
      const connection = new CdpConnection(transport);

      await assert.rejects(
        connection.connect({ ...OPTIONS, timeoutMs: 5 }),
        CdpConnectTimeoutError,
      );

      await transport.land();

      assert.deepEqual(unhandled, []);
      assert.equal(connection.getStatus(), "disconnected");
      assert.equal(connection.getSessionInfo(), null);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stays reusable after a timeout, with no leaked handle", async () => {
    const slow = new FakeCdpTransport();
    const timedOut = new CdpConnection(slow);
    await assert.rejects(
      timedOut.connect({ ...OPTIONS, timeoutMs: 5 }),
      CdpConnectTimeoutError,
    );
    await slow.land();

    const fresh = new FakeCdpTransport();
    const reused = new CdpConnection(fresh);
    const attempt = reused.connect(OPTIONS);
    await fresh.land();
    const info = await attempt;
    assert.equal(info.endpoint, OPTIONS.endpoint);
    assert.equal(reused.isConnected(), true);
  });

  it("keeps the failed attempt out of the session slot", async () => {
    const transport = new FakeCdpTransport({ failWith: new Error("boom") });
    const connection = new CdpConnection(transport);

    await assert.rejects(
      connection.connect({ ...OPTIONS, timeoutMs: 5 }),
      CdpConnectTimeoutError,
    );
    await transport.land();

    assert.equal(connection.getSessionInfo(), null);
    assert.throws(() => connection.requireSession());
  });
});

describe("cdp: successful connect is unaffected", () => {
  it("still connects and disconnects exactly once", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);

    const attempt = connection.connect(OPTIONS);
    await transport.land();
    const info = await attempt;

    assert.equal(info.endpoint, OPTIONS.endpoint);
    await connection.disconnect();
    assert.equal(transport.disconnectCalls, 1);
    assert.equal(connection.getStatus(), "disconnected");
  });

  it("does not mark a normal attach as abandoned", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);

    const attempt = connection.connect(OPTIONS);
    await transport.land();
    const info = await attempt;

    assert.equal(info.browserVersion, "FakeBrowser/0.0.0");
    await connection.disconnect();
    assert.equal(transport.disconnectCalls, 1);
    assert.equal(transport.connected, false);
  });
});
