import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CdpConnection, FakeCdpTransport } from "../src/cdp/index.ts";
import { CdpConnectTimeoutError, CdpOperationError, CdpUnavailableError } from "../src/errors.ts";

const OPTIONS: { endpoint: string; timeoutMs: number } = {
  endpoint: "http://127.0.0.1:9223",
  timeoutMs: 1000,
};

/** Attach, release the parked transport, and return the session. */
async function attached(connection: CdpConnection, transport: FakeCdpTransport, options = OPTIONS) {
  const attempt = connection.connect(options);
  await transport.land();
  return attempt;
}

describe("cdp: connection lifecycle", () => {
  it("starts disconnected and never connects implicitly", () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.isConnected(), false);
    assert.equal(connection.getSessionInfo(), null);
    // Constructing the manager performs no transport work.
    assert.equal(transport.connectCalls, 0);
    assert.equal(transport.disconnectCalls, 0);
  });

  it("connects explicitly and reports the session", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    const info = await attached(connection, transport);
    assert.equal(info.endpoint, OPTIONS.endpoint);
    assert.equal(info.browserVersion, "FakeBrowser/0.0.0");
    assert.equal(connection.getStatus(), "connected");
    assert.equal(connection.isConnected(), true);
    assert.deepEqual(connection.getSessionInfo(), info);
  });

  it("disconnects cleanly and releases the transport", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    await attached(connection, transport);
    await connection.disconnect();
    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.getSessionInfo(), null);
    assert.equal(transport.disconnectCalls, 1);
    assert.equal(transport.connected, false);
  });

  it("treats a second disconnect as a no-op", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    await attached(connection, transport);
    await connection.disconnect();
    await connection.disconnect();
    assert.equal(transport.disconnectCalls, 1);
  });

  it("tolerates a disconnect on a never-connected manager", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    await connection.disconnect();
    assert.equal(transport.disconnectCalls, 0);
    assert.equal(connection.getStatus(), "disconnected");
  });

  it("refuses a second concurrent connect while connected", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    await attached(connection, transport);
    const attempt = connection.connect(OPTIONS);
    await transport.land();
    await assert.rejects(attempt, CdpOperationError);
  });

  it("rejects a session-requiring operation while disconnected", async () => {
    const connection = new CdpConnection(new FakeCdpTransport());
    assert.throws(() => connection.requireSession(), CdpOperationError);
  });

  it("returns the session to requireSession while connected", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    const info = await attached(connection, transport);
    assert.deepEqual(connection.requireSession(), info);
  });
});

describe("cdp: failed connection", () => {
  it("classifies a transport failure as unavailable", async () => {
    const transport = new FakeCdpTransport({ failWith: new Error("ECONNREFUSED") });
    const connection = new CdpConnection(transport);
    const attempt = connection.connect(OPTIONS);
    await transport.land();
    await assert.rejects(attempt, CdpUnavailableError);
  });

  it("stays disconnected and reusable after a failure", async () => {
    const failing = new FakeCdpTransport({ failWith: new Error("boom") });
    const connection = new CdpConnection(failing);
    const attempt = connection.connect(OPTIONS);
    await failing.land();
    await assert.rejects(attempt, CdpUnavailableError);

    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.getSessionInfo(), null);

    // A later attempt on a working transport is allowed once the cause is fixed.
    const working = new FakeCdpTransport();
    const connection2 = new CdpConnection(working);
    await attached(connection2, working);
    assert.equal(connection2.isConnected(), true);
  });

  it("preserves the endpoint in the sanitized message", async () => {
    const transport = new FakeCdpTransport({ failWith: new Error("dial tcp refused") });
    const connection = new CdpConnection(transport);
    const attempt = connection.connect(OPTIONS);
    await transport.land();
    await assert.rejects(
      attempt,
      (error: unknown) => {
        assert.ok(error instanceof CdpUnavailableError);
        assert.match(error.message, /127\.0\.0\.1:9223/);
        return true;
      },
    );
  });

  it("does not leak a transport object into the public message", async () => {
    const secretish = new Error("connection to ws://127.0.0.1:9223/devtools/browser/TOKEN failed");
    const transport = new FakeCdpTransport({ failWith: secretish });
    const connection = new CdpConnection(transport);
    const attempt = connection.connect(OPTIONS);
    await transport.land();
    await assert.rejects(
      attempt,
      (error: unknown) => {
        assert.ok(error instanceof CdpUnavailableError);
        // The underlying cause is retained for local debugging only.
        assert.equal(error.cause, secretish);
        return true;
      },
    );
  });
});

describe("cdp: connection timeout", () => {
  it("rejects with a typed timeout error when the attach is slow", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    const attempt = connection.connect({ ...OPTIONS, timeoutMs: 5 });
    await assert.rejects(attempt, CdpConnectTimeoutError);
    await transport.land();
  });

  it("carries the configured timeout on the error", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    const attempt = connection.connect({ ...OPTIONS, timeoutMs: 5 });
    await assert.rejects(
      attempt,
      (error: unknown) => {
        assert.ok(error instanceof CdpConnectTimeoutError);
        assert.equal(error.timeoutMs, 5);
        return true;
      },
    );
    await transport.land();
  });

  it("connects when the attach completes inside the timeout", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    const info = await attached(connection, transport, { ...OPTIONS, timeoutMs: 1000 });
    assert.equal(info.endpoint, OPTIONS.endpoint);
  });

  it("does not leave a pending timer after a timeout rejection", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    await assert.rejects(
      connection.connect({ ...OPTIONS, timeoutMs: 5 }),
      CdpConnectTimeoutError,
    );
    await transport.land();

    // A fresh connection must behave normally afterwards, proving the manager
    // released its timer and its state.
    const fresh = new FakeCdpTransport();
    const clean = new CdpConnection(fresh);
    const info = await attached(clean, fresh, { ...OPTIONS, timeoutMs: 0 });
    assert.equal(clean.isConnected(), true);
    assert.equal(info.endpoint, OPTIONS.endpoint);
  });
});
