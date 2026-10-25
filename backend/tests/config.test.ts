import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CONFIG_DEFAULTS, loadConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

describe("config: valid configuration", () => {
  it("returns documented defaults for an empty environment", () => {
    const config = loadConfig({});
    assert.equal(config.host, CONFIG_DEFAULTS.host);
    assert.equal(config.port, CONFIG_DEFAULTS.port);
    assert.equal(config.cdpEndpoint, CONFIG_DEFAULTS.cdpEndpoint);
    assert.equal(config.cdpConnectTimeoutMs, CONFIG_DEFAULTS.cdpConnectTimeoutMs);
  });

  it("applies explicit valid overrides", () => {
    const config = loadConfig({
      BACKEND_HOST: "localhost",
      BACKEND_PORT: "9001",
      CDP_ENDPOINT: "http://127.0.0.1:9223/",
      CDP_CONNECT_TIMEOUT_MS: "30000",
    });
    assert.equal(config.host, "localhost");
    assert.equal(config.port, 9001);
    // Trailing slash is normalized away.
    assert.equal(config.cdpEndpoint, "http://127.0.0.1:9223");
    assert.equal(config.cdpConnectTimeoutMs, 30000);
  });

  it("accepts the boundary ports 1 and 65535", () => {
    assert.equal(loadConfig({ BACKEND_PORT: "1" }).port, 1);
    assert.equal(loadConfig({ BACKEND_PORT: "65535" }).port, 65535);
  });
});

describe("config: invalid configuration", () => {
  it("rejects a non-numeric port", () => {
    assert.throws(
      () => loadConfig({ BACKEND_PORT: "8788abc" }),
      (error: unknown) => error instanceof ConfigError && error.field === "BACKEND_PORT",
    );
  });

  it("rejects a port with whitespace padding", () => {
    assert.throws(
      () => loadConfig({ BACKEND_PORT: " 8788 " }),
      (error: unknown) => error instanceof ConfigError && error.field === "BACKEND_PORT",
    );
  });

  it("rejects a fractional port", () => {
    assert.throws(
      () => loadConfig({ BACKEND_PORT: "8788.5" }),
      (error: unknown) => error instanceof ConfigError,
    );
  });

  it("rejects port 0 and port 65536", () => {
    assert.throws(() => loadConfig({ BACKEND_PORT: "0" }), ConfigError);
    assert.throws(() => loadConfig({ BACKEND_PORT: "65536" }), ConfigError);
  });

  it("rejects a non-loopback host", () => {
    assert.throws(
      () => loadConfig({ BACKEND_HOST: "0.0.0.0" }),
      (error: unknown) => error instanceof ConfigError && error.field === "BACKEND_HOST",
    );
  });

  it("rejects a non-loopback CDP endpoint", () => {
    assert.throws(
      () => loadConfig({ CDP_ENDPOINT: "http://192.168.1.10:9223" }),
      (error: unknown) => error instanceof ConfigError && error.field === "CDP_ENDPOINT",
    );
  });

  it("rejects a malformed CDP endpoint URL", () => {
    assert.throws(
      () => loadConfig({ CDP_ENDPOINT: "127.0.0.1:9223" }),
      (error: unknown) => error instanceof ConfigError && error.field === "CDP_ENDPOINT",
    );
  });

  it("rejects a non-http CDP protocol", () => {
    assert.throws(
      () => loadConfig({ CDP_ENDPOINT: "ftp://127.0.0.1:9223" }),
      (error: unknown) => error instanceof ConfigError && error.field === "CDP_ENDPOINT",
    );
  });

  it("rejects a negative timeout", () => {
    assert.throws(
      () => loadConfig({ CDP_CONNECT_TIMEOUT_MS: "-1" }),
      (error: unknown) => error instanceof ConfigError && error.field === "CDP_CONNECT_TIMEOUT_MS",
    );
  });

  it("never leaks a secret-bearing value into the error message", () => {
    // The host value appears because it is the offending field, but no other
    // environment value is echoed.
    assert.throws(
      () => loadConfig({ BACKEND_HOST: "203.0.113.9", BACKEND_PORT: "8788" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes("8788"));
        return true;
      },
    );
  });
});
