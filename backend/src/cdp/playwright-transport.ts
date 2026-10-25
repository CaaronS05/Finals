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
 *
 * ATTACH-ONLY
 * -----------
 * `browser.close()` on a CDP-attached browser detaches the transport; it does
 * not terminate the browser process. The user's CloakBrowser, its tabs, and
 * its session data survive every path in this file.
 */

import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import type { CdpConnectOptions, CdpSessionInfo, CdpTransport } from "./connection.ts";
import { CdpDisconnectedError, CdpUnavailableError, sanitizeError } from "../errors.ts";

/**
 * Attach-only CDP transport backed by playwright-core.
 *
 * A connect that is still in flight when `disconnect()` runs is marked
 * abandoned. If the browser object lands afterwards, the session is released
 * immediately instead of being left attached with no owner. Without this, a
 * timed-out attach would strand a live CDP session.
 */
export class PlaywrightCdpTransport implements CdpTransport {
  private browser: Browser | null = null;
  private abandoned = false;

  async connect(options: CdpConnectOptions): Promise<CdpSessionInfo> {
    this.abandoned = false;

    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(options.endpoint, {
        // Playwright's default is 30s; 0 disables its timeout entirely.
        ...(options.timeoutMs > 0 ? { timeout: options.timeoutMs } : {}),
        // Same-host loopback: allow filesystem-based optimizations.
        isLocal: true,
      });
    } catch (error) {
      throw new CdpUnavailableError(
        `Failed to attach to CloakBrowser at ${options.endpoint}: ${sanitizeError(error)}`,
        { cause: error },
      );
    }

    if (this.abandoned) {
      // A detach ran while this attach was in flight. Release the session it
      // just opened so nothing outlives the abandoned connect().
      await closeQuietly(browser);
      throw new CdpDisconnectedError("CDP session released after detach");
    }

    this.browser = browser;
    return { endpoint: options.endpoint, browserVersion: browser.version() };
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = null;

    if (browser !== null) {
      await closeQuietly(browser);
      return;
    }

    // No handle registered yet: a connect is in flight. Mark it abandoned so
    // the session it opens is released the moment it lands.
    this.abandoned = true;
  }
}

async function closeQuietly(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // Detach is best-effort. Nothing to recover, and the manager is already
    // marked disconnected.
  }
}

/** Factory for a real CDP connection. Status: UNVERIFIED — see module header. */
export function createPlaywrightCdpTransport(): PlaywrightCdpTransport {
  return new PlaywrightCdpTransport();
}
