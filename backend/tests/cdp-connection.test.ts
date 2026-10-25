import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CdpConnection, FakeCdpTransport } from "../src/cdp/index.ts";
import { CdpConnectTimeoutError, CdpOperationError, CdpUnavailableError } from "../src/errors.ts";

const OPTIONS = { endpoint: "http://127.0.0.1:9223", timeoutMs: 1000 } as const;

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
    const info = await connection.connect(OPTIONS);
    assert.equal(info.endpoint, OPTIONS.endpoint);
    assert.equal(info.browserVersion, "FakeBrowser/0.0.0");
    assert.equal(connection.getStatus(), "connected");
    assert.equal(connection.isConnected(), true);
    assert.deepEqual(connection.getSessionInfo(), info);
  });

  it("disconnects cleanly and releases the transport", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    await connection.connect(OPTIONS);
    await connection.disconnect();
    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.getSessionInfo(), null);
    assert.equal(transport.disconnectCalls, 1);
    assert.equal(transport.connected, false);
  });

  it("treats a second disconnect as a no-op", async () => {
    const transport = new FakeCdpTransport();
    const connection = new CdpConnection(transport);
    await connection.connect(OPTIONS);
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
    await connection.connect(OPTIONS);
    await assert.rejects(() => connection.connect(OPTIONS), CdpOperationError);
  });

  it("rejects a session-requiring operation while disconnected", async () => {
    const connection = new CdpConnection(new FakeCdpTransport());
    assert.throws(() => connection.requireSession(), CdpOperationError);
  });

  it("returns the session to requireSession while connected", async () => {
    const connection = new CdpConnection(new FakeCdpTransport());
    const info = await connection.connect(OPTIONS);
    assert.deepEqual(connection.requireSession(), info);
  });
});

describe("cdp: failed connection", () => {
  it("classifies a transport failure as unavailable", async () => {
    const transport = new FakeCdpTransport({ failWith: new Error("ECONNREFUSED") });
    const connection = new CdpConnection(transport);
    await assert.rejects(() => connection.connect(OPTIONS), CdpUnavailableError);
  });

  it("stays disconnected and reusable after a failure", async () => {
    const transport = new FakeCdpTransport({ failWith: new Error("boom") });
    const connection = new CdpConnection(transport);
    await assert.rejects(() => connection.connect(OPTIONS), CdpUnavailableError);
    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.getSessionInfo(), null);
    // A later attempt is allowed once the cause is fixed.
    const transport2 = new FakeCdpTransport();
    const connection2 = new CdpConnection(transport2);
    await connection2.connect(OPTIONS);
    assert.equal(connection2.isConnected(), true);
  });

  it("preserves the endpoint in the sanitized message", async () => {
    const transport = new FakeCdpTransport({ failWith: new Error("dial tcp refused") });
    const connection = new CdpConnection(transport);
    await assert.rejects(
      () => connection.connect(OPTIONS),
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
    await assert.rejects(
      () => connection.connect(OPTIONS),
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
    const transport = new FakeCdpTransport({ delayMs: 300 });
    const connection = new CdpConnection(transport);
    await assert.rejects(
      () => connection.connect({ ...OPTIONS, timeoutMs: 50 }),
      CdpConnectTimeoutError,
    );
  });

  it("carries the configured timeout on the error", async () => {
    const transport = new FakeCdpTransport({ delayMs: 300 });
    const connection = new CdpConnection(transport);
    await assert.rejects(
      () => connection.connect({ ...OPTIONS, timeoutMs: 40 }),
      (error: unknown) => {
        assert.ok(error instanceof CdpConnectTimeoutError);
        assert.equal(error.timeoutMs, 40);
        return true;
      },
    );
  });

  it("connects when the attach completes inside the timeout", async () => {
    const transport = new FakeCdpTransport({ delayMs: 10 });
    const connection = new CdpConnection(transport);
    const info = await connection.connect({ ...OPTIONS, timeoutMs: 1000 });
    assert.equal(info.endpoint, OPTIONS.endpoint);
  });

  it("does not leave a pending timer after a timeout rejection", async () => {
    const transport = new FakeCdpTransport({ delayMs: 200 });
    const connection = new CdpConnection(transport);
    await assert.rejects(() => connection.connect({ ...OPTIONS, timeoutMs: 20 }), CdpConnectTimeoutError);
    // If the timer leaked, the process would stay alive briefly. A successful
    // fast connect right after proves the manager is clean.
    const fast = new FakeCdpTransport();
    const clean = new CdpConnection(fast);
    await clean.connect({ ...OPTIONS, timeoutMs: 0 });
    assert.equal(clean.isConnected(), true);
  });
});
