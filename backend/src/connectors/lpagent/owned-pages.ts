/**
 * Dedicated tab ownership for LP Agent acquisition (F2-B).
 *
 * CloakBrowser is a user-operated browser holding a real session. The backend
 * attaches to it; it must never navigate, close, or reconfigure a tab the user
 * opened. LP Agent acquisition therefore runs in a tab that DLLM creates and
 * owns.
 *
 * OWNERSHIP RULES
 * ---------------
 * - Only pages this module creates are ever tracked.
 * - A user tab is never navigated, closed, or mutated.
 * - `dispose()` closes only owned pages. It never closes the browser, never
 *   terminates a process, and never disconnects CDP.
 * - Cleanup is idempotent: a second `dispose()` is a no-op.
 *
 * CONTEXT SELECTION
 * -----------------
 * The confirmed LP Agent workflow depends on the ambient browser session
 * (`credentials: "include"` against `api.lpagent.io`). A fresh incognito or
 * isolated context does not carry that session, so a newly created context is
 * NOT equivalent. F2-B therefore requires the caller to supply the context
 * explicitly, and fails closed when it cannot determine which context to use.
 */
/** Minimal page surface this module needs. No Playwright type is imported. */
export interface BrowserPageHandle {
  /** True when the page has been closed. */
  isClosed(): boolean;
  /** Close the page. Does not affect the browser process or other pages. */
  close(): Promise<void>;
  /** Current URL, when the page can report it. */
  url(): string;
}

/** Minimal context surface. Only what page creation requires. */
export interface BrowserContextHandle {
  /** Pages currently open in this context. */
  pages(): readonly BrowserPageHandle[];
  /** Create a new page in this context. */
  newPage(): Promise<BrowserPageHandle>;
  /** Human-readable description for logs. Never a session id or a path. */
  describe(): string;
}

/** Marker used to identify a DLLM-owned LP Agent tab. */
export const LP_AGENT_TAB_MARKER = "dllm-lpagent-transport";

/**
 * Tracks and cleans up pages created by DLLM.
 *
 * The owner never enumerates user pages for reuse. It looks only for a page it
 * previously created and tagged, so an unrelated tab can never be adopted.
 */
export class OwnedPageTracker {
  private readonly owned = new Set<BrowserPageHandle>();
  private readonly context: BrowserContextHandle;
  private disposed = false;

  constructor(context: BrowserContextHandle) {
    this.context = context;
  }

  /**
   * Return the owned page, creating one if none is open.
   *
   * Reuse is limited to a page this tracker created earlier in the same
   * process. A user tab is never matched, because only owned pages are
   * recorded.
   */
  async acquirePage(): Promise<BrowserPageHandle> {
    this.assertNotDisposed();
    for (const page of this.owned) {
      if (!page.isClosed()) {
        return page;
      }
      this.owned.delete(page);
    }
    const page = await this.context.newPage();
    this.owned.add(page);
    return page;
  }

  /**
   * Take ownership of a page created outside this tracker.
   *
   * Used by an adapter that must hold the real object for its own work while
   * leaving cleanup with the tracker. Only DLLM-created pages may be adopted;
   * adopting a user tab would put a user page at risk of being closed.
   */
  adopt(page: BrowserPageHandle): void {
    this.assertNotDisposed();
    this.owned.add(page);
  }

  /** Pages this tracker created that are still open. */
  ownedPageCount(): number {
    let count = 0;
    for (const page of this.owned) {
      if (!page.isClosed()) {
        count += 1;
      }
    }
    return count;
  }

  /** True once `dispose()` has run. */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Close every owned page. Idempotent, and never throws: a failing close must
   * not mask the operation that triggered cleanup.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const pages = [...this.owned];
    this.owned.clear();
    for (const page of pages) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch {
        // Best-effort. The browser process and every user page are unaffected
        // by a failed close of a page DLLM created.
      }
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Owned page tracker is disposed");
    }
  }
}

/**
 * Decide whether a page is a DLLM-owned LP Agent tab.
 *
 * Identification is by an explicit marker property, matching the legacy
 * convention of tagging a tab rather than inferring from its URL. A URL match
 * alone is not sufficient: the user may have `app.lpagent.io` open.
 */
export function isOwnedLpAgentPage(page: BrowserPageHandle & { __dllmLpagent?: boolean }): boolean {
  return page.__dllmLpagent === true;
}
