import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CDP_ENDPOINT,
  FORBIDDEN_CDP_PORT,
  ForbiddenCdpPortError,
  isPermittedCdpEndpoint,
  validateCdpEndpoint,
} from "../src/cdp/endpoint.ts";
import { createBackendHttpServer } from "../src/http/index.ts";
import type { BackendConfig } from "../src/config.ts";

describe("cdp: endpoint policy", () => {
  it("uses the historical 9223 convention by default", () => {
    assert.equal(DEFAULT_CDP_ENDPOINT, "http://127.0.0.1:9223");
  });

  it("permits the documented endpoint", () => {
    assert.equal(validateCdpEndpoint("http://127.0.0.1:9223"), "http://127.0.0.1:9223");
  });

  it("normalizes trailing slashes", () => {
    assert.equal(validateCdpEndpoint("http://127.0.0.1:9223///"), "http://127.0.0.1:9223");
  });

  it("rejects the forbidden legacy Brave port 9222", () => {
    assert.throws(
      () => validateCdpEndpoint("http://127.0.0.1:9222"),
      (error: unknown) => {
        assert.ok(error instanceof ForbiddenCdpPortError);
        assert.equal(error.port, FORBIDDEN_CDP_PORT);
        return true;
      },
    );
  });

  it("rejects a non-loopback endpoint host", () => {
    assert.throws(() => validateCdpEndpoint("http://10.0.0.5:9223"), /loopback/);
  });

  it("rejects a malformed endpoint", () => {
    assert.throws(() => validateCdpEndpoint("9223"), /Invalid CDP endpoint URL/);
  });

  it("reports permission as a boolean without throwing", () => {
    assert.equal(isPermittedCdpEndpoint("http://127.0.0.1:9223"), true);
    assert.equal(isPermittedCdpEndpoint("http://127.0.0.1:9222"), false);
    assert.equal(isPermittedCdpEndpoint("not-a-url"), false);
  });
});

describe("startup: no automatic CDP connection", () => {
  it("serves /health with a configured but unreachable CDP endpoint", async () => {
    // A missing CDP endpoint must not prevent startup or crash the server.
    // Nothing here opens a socket to the CDP endpoint.
    const config: BackendConfig = {
      host: "127.0.0.1",
      port: 0,
      cdpEndpoint: "http://127.0.0.1:59999",
      cdpConnectTimeoutMs: 15000,
    };
    const app = createBackendHttpServer(config);
    try {
      const port = await app.listening;
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { status: string; service: string };
      assert.equal(payload.status, "ok");
    } finally {
      await app.close();
    }
  });

  it("does not connect to CDP merely by constructing the server", async () => {
    const app = createBackendHttpServer({
      host: "127.0.0.1",
      port: 0,
      cdpEndpoint: DEFAULT_CDP_ENDPOINT,
      cdpConnectTimeoutMs: 15000,
    });
    try {
      const port = await app.listening;
      // Reaching this point proves startup succeeded without a browser.
      assert.ok(port > 0);
    } finally {
      await app.close();
    }
  });
});
