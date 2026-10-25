/**
 * Explicit, opt-in live CDP verification against a real CloakBrowser.
 *
 * DISABLED BY DEFAULT. This file is never picked up by `npm test`, which runs
 * only `tests/**\/*.test.ts`. It runs only when invoked directly:
 *
 *   node --experimental-strip-types tests/live/cdp-live.test.ts
 *
 * REQUIREMENTS
 * ------------
 * - A CloakBrowser instance with CDP on the configured loopback endpoint.
 * - `LIVE_CDP=1` to arm the run.
 *
 * SAFETY
 * ------
 * Read-only with respect to the browser. It never navigates a tab, reads
 * cookies, reads session state, creates or deletes a profile, or changes a
 * persistent setting. The only write is a CDP attach and its matching detach.
 * A timeout triggers cleanup so no session outlives the run.
 *
 * Output is sanitized: no websocket URL, no profile path, no token.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../../src/config.ts";
import { CdpConnection } from "../../src/cdp/connection.ts";
import { PlaywrightCdpTransport } from "../../src/cdp/playwright-transport.ts";

const ARMED = process.env.LIVE_CDP === "1";

/** Read-only availability probe. Returns only booleans and a version string. */
async function probeEndpoint(endpoint: string): Promise<{ available: boolean; browser: string | null }> {
  try {
    const response = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { available: false, browser: null };
    }
    const payload = (await response.json()) as { Browser?: string };
    return { available: true, browser: payload.Browser ?? null };
  } catch {
    return { available: false, browser: null };
  }
}

describe("live CDP verification", { skip: !ARMED }, () => {
  it("attaches, detaches, and reattaches against a real CloakBrowser", async () => {
    const config = loadConfig();
    const before = await probeEndpoint(config.cdpEndpoint);

    // If the browser is absent, fail loudly rather than silently skipping.
    // A green live test must mean a real attach happened.
    assert.equal(before.available, true, `CDP endpoint unreachable at ${config.cdpEndpoint}`);

    const transport = new PlaywrightCdpTransport();
    const connection = new CdpConnection(transport);

    try {
      // A. Connection succeeds and the manager recognizes it.
      const info = await connection.connect({
        endpoint: config.cdpEndpoint,
        timeoutMs: config.cdpConnectTimeoutMs,
      });
      assert.equal(connection.getStatus(), "connected");
      assert.equal(connection.isConnected(), true);
      assert.equal(info.endpoint, config.cdpEndpoint);
      assert.ok(info.browserVersion !== null && info.browserVersion.length > 0);

      // B. Disconnect succeeds and the manager recognizes it.
      await connection.disconnect();
      assert.equal(connection.getStatus(), "disconnected");
      assert.equal(connection.getSessionInfo(), null);

      // C. The browser survives the detach. Attach-only means the process,
      //    its tabs, and its session are untouched.
      const afterDisconnect = await probeEndpoint(config.cdpEndpoint);
      assert.equal(afterDisconnect.available, true, "CloakBrowser disappeared after detach");
      assert.equal(afterDisconnect.browser, before.browser);

      // D. Reconnect works.
      const second = await connection.connect({
        endpoint: config.cdpEndpoint,
        timeoutMs: config.cdpConnectTimeoutMs,
      });
      assert.equal(connection.isConnected(), true);
      assert.equal(second.endpoint, config.cdpEndpoint);
    } finally {
      // Always detach, even on failure, so no session outlives the run.
      await connection.disconnect();
    }

    // E. Final state: detached, browser still alive, no session owned.
    const final = await probeEndpoint(config.cdpEndpoint);
    assert.equal(final.available, true, "CloakBrowser disappeared after the run");
    assert.equal(connection.getStatus(), "disconnected");
    assert.equal(connection.getSessionInfo(), null);
  });
});

describe("live CDP verification is armed", { skip: ARMED }, () => {
  it("reports that it was not run", () => {
    assert.ok(true, "Set LIVE_CDP=1 with a running CloakBrowser to execute the live test");
  });
});
