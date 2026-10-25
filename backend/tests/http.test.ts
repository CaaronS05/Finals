import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createBackendHttpServer } from "../src/http/index.ts";
import type { BackendConfig } from "../src/config.ts";
import type { BackendServer } from "../src/http/index.ts";

const BASE_CONFIG: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  cdpEndpoint: "http://127.0.0.1:9223",
  cdpConnectTimeoutMs: 15000,
};

let active: BackendServer | null = null;

async function startServer(overrides: Partial<BackendConfig> = {}): Promise<number> {
  const app = createBackendHttpServer({ ...BASE_CONFIG, ...overrides });
  active = app;
  return app.listening;
}

afterEach(async () => {
  if (active !== null) {
    await active.close();
    active = null;
  }
});

describe("http: health endpoint", () => {
  it("returns the expected payload with status ok", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const payload = (await response.json()) as { status: string; service: string };
    assert.deepEqual(payload, { status: "ok", service: "dllm-backend" });
  });

  it("binds to the loopback host it was configured with", async () => {
    const port = await startServer({ host: "127.0.0.1" });
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
  });

  it("returns 404 for an unknown route", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(response.status, 404);
  });

  it("ignores a query string on /health", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/health?probe=1`);
    assert.equal(response.status, 200);
  });

  it("returns 404 for POST /health", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    assert.equal(response.status, 404);
  });
});
