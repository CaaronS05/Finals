/**
 * Playwright-core CDP adapter — REAL IMPLEMENTATION, STATUS: UNVERIFIED.
 *
 * WHAT IS VERIFIED
 * ----------------
 * The legacy Rahasia repository attaches to CloakBrowser using
 * `playwright-core`'s `chromium.connectOverCDP("http://127.0.0.1:9223")`.
 * That call site is confirmed by reading the legacy sources:
 *   - `scripts/lpagent/scrape-smart-lp.mjs`        (connectOverCDP)
 *   - `scripts/discovery/core/fabriq-position-history.ts` (connectOverCDP with timeout)
 *   - `scripts/fabriq/enrich-wallets.mjs`           (connectOverCDP, 120s timeout)
 *   - `scripts/pool/scan-selected-pools.mjs`        (connectOverCDP with timeout)
 *   - `scripts/pool-scanner-v1.mjs`                 (connectOverCDP)
 *
 * WHAT IS NOT VERIFIED
 * --------------------
 * No live CloakBrowser instance was probed during F0. The endpoint port
 * (9223) is a historical convention only. Until a real attach succeeds, this
 * adapter is documented UNVERIFIED and is not exercised by the F0 test suite.
 *
 * `playwright-core` carries no bundled browser and downloads nothing on
 * install, so the dependency costs ~14MB and no browser toolchain.
 */

import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import type { CdpConnectOptions, CdpSessionInfo, CdpTransport } from "./connection.ts";
import { CdpUnavailableError, sanitizeError } from "../errors.ts";

/**
 * Attach-only CDP transport backed by playwright-core.
 *
 * `disconnect()` detaches from the browser; it never terminates the browser
 * process, so an existing user session survives.
 */
export class PlaywrightCdpTransport implements CdpTransport {
  private browser: Browser | null = null;

  async connect(options: CdpConnectOptions): Promise<CdpSessionInfo> {
    try {
      const browser = await chromium.connectOverCDP(options.endpoint, {
        // Playwright's default is 30s; 0 disables its timeout entirely.
        ...(options.timeoutMs > 0 ? { timeout: options.timeoutMs } : {}),
        // Same-host loopback: allow filesystem-based optimizations.
        isLocal: true,
      });
      this.browser = browser;
      return { endpoint: options.endpoint, browserVersion: browser.version() };
    } catch (error) {
      throw new CdpUnavailableError(
        `Failed to attach to CloakBrowser at ${options.endpoint}: ${sanitizeError(error)}`,
        { cause: error },
      );
    }
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser === null) {
      return;
    }
    // Attach-only: closing detaches the CDP transport. The browser process,
    // its tabs, and its session data are left untouched.
    try {
      await browser.close();
    } catch {
      // Detach is best-effort. Nothing to recover, and the manager is already
      // marked disconnected.
    }
  }
}

/** Factory for a real CDP connection. Status: UNVERIFIED — see module header. */
export function createPlaywrightCdpTransport(): PlaywrightCdpTransport {
  return new PlaywrightCdpTransport();
}
