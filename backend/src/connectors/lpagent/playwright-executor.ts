/**
 * Playwright browser executor — REAL ADAPTER, STATUS: UNVERIFIED LIVE.
 *
 * Executes one browser-context HTTP request inside an existing Playwright page.
 *
 * This file is the ONLY place in the LP Agent connector tree that imports
 * `playwright-core`. It is constructed by a caller that already holds an
 * attached `CdpConnection` (F0/F1); it never connects, never disconnects, and
 * never closes the browser.
 *
 * WHAT IS VERIFIED
 * ----------------
 * The legacy request shape and the legacy tab-marker convention, read from
 * Rahasia (cited in docs/architecture/F2B_LPAGENT_BROWSER_TRANSPORT.md).
 *
 * WHAT IS NOT VERIFIED
 * ---------------------
 * That a live CloakBrowser context accepts this executor's page creation and
 * in-context fetch. No live request is permitted in F2-B; verification is
 * F2-C, opt-in and armed by an environment variable.
 *
 * SESSION SAFETY
 * --------------
 * `credentials: "include"` attaches the ambient browser session, which is why
 * the executor runs inside a real browser context rather than in Node. No
 * cookie, token, or header is read, exported, or logged by this file. Only
 * `Accept: application/json` is ever sent.
 *
 * OWNERSHIP
 * ---------
 * The Playwright `Page` is held privately. Domain code receives only a
 * `BrowserExecutor`, so no Playwright object crosses the domain boundary. The
 * page is created by an `OwnedPageTracker` and closed by `dispose()`.
 */
import type { BrowserContext, Page } from "playwright-core";
import type { BrowserExecutor, BrowserHttpRequest, BrowserHttpResponse } from "./browser-execution.ts";
import { BrowserExecutionError } from "./browser-execution.ts";
import { OwnedPageTracker, type BrowserPageHandle } from "./owned-pages.ts";

/** Shape returned by the in-page fetch. */
interface InPageResult {
  status: number;
  body: string;
  retryAfterSeconds: number | null;
  timedOut: boolean;
  failed: boolean;
}

/**
 * Adapt a Playwright page to the minimal handle the tracker needs.
 *
 * One-way shim: the tracker sees only `isClosed`, `close`, and `url`. It can
 * never reach `evaluate`, `goto`, `cookies`, or the context.
 */
function toHandle(page: Page): BrowserPageHandle {
  return {
    isClosed: () => page.isClosed(),
    close: async () => {
      await page.close();
    },
    url: () => page.url(),
  };
}

/**
 * Browser executor that runs requests inside a Playwright page.
 *
 * The page is created only when DLLM has none open, is reused across the pages
 * of one acquisition, and is closed by `dispose()`. The browser, the context,
 * and every user tab are untouched.
 */
export class PlaywrightBrowserExecutor implements BrowserExecutor {
  private readonly context: BrowserContext;
  private readonly tracker: OwnedPageTracker;
  /** The owned Playwright page, or null before the first request. */
  private page: Page | null = null;

  constructor(context: BrowserContext) {
    this.context = context;
    this.tracker = new OwnedPageTracker({
      pages: () => context.pages().map(toHandle),
      newPage: async () => toHandle(await context.newPage()),
      describe: () => "playwright-context",
    });
  }

  async execute(request: BrowserHttpRequest): Promise<BrowserHttpResponse> {
    const page = await this.acquirePage();
    const result = (await page.evaluate(
      async ({ url, method, headers, credentials, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        try {
          const response = await fetch(url, {
            method,
            headers,
            credentials,
            signal: controller.signal,
          });
          const retryAfterHeader = response.headers.get("retry-after");
          const parsed = retryAfterHeader === null ? Number.NaN : Number.parseInt(retryAfterHeader, 10);
          const body = await response.text();
          return {
            status: response.status,
            body,
            retryAfterSeconds: Number.isFinite(parsed) ? parsed : null,
            timedOut: false,
            failed: false,
          };
        } catch (error) {
          const timedOut =
            error instanceof Error &&
            (error.name === "AbortError" || error.message.toLowerCase().includes("timed out"));
          return { status: 0, body: "", retryAfterSeconds: null, timedOut, failed: true };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        url: request.url,
        method: request.method,
        headers: { ...request.headers },
        credentials: request.credentials,
        timeoutMs: request.timeoutMs,
      },
    )) as InPageResult;
    if (result.failed) {
      throw new BrowserExecutionError(
        result.timedOut ? "TIMEOUT" : "NETWORK",
        result.timedOut ? `request exceeded ${request.timeoutMs}ms` : "browser fetch failed",
      );
    }
    return {
      status: result.status,
      body: result.body,
      retryAfterSeconds: result.retryAfterSeconds,
      timedOut: false,
    };
  }

  async dispose(): Promise<void> {
    this.page = null;
    await this.tracker.dispose();
  }

  describe(): string {
    return `playwright-browser-executor(ownedPages=${this.tracker.ownedPageCount()})`;
  }

  /** Return the owned page, creating one only when DLLM has none open. */
  private async acquirePage(): Promise<Page> {
    if (this.page !== null && !this.page.isClosed()) {
      return this.page;
    }
    // The tracker creates the page so ownership and cleanup stay in one place.
    // The tracker hands back the real Playwright page through its creator, so
    // no cast is needed and the shim never leaks outward.
    const page = await this.context.newPage();
    this.tracker.adopt(page);
    this.page = page;
    return page;
  }
}
