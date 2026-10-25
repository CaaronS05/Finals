/**
 * In-memory fake browser executor for F2-B tests.
 *
 * Never opens a socket, never imports playwright, never needs CloakBrowser or
 * network access. Every response is a synthetic fixture supplied by the test.
 *
 * The fake records what it was asked to execute and how many times it was
 * disposed, so tests can assert that no implicit request runs, that cleanup
 * happens exactly once, and that nothing executes after disposal.
 */
import type { BrowserExecutor, BrowserHttpRequest, BrowserHttpResponse } from "./browser-execution.ts";
import { BrowserExecutionError } from "./browser-execution.ts";

/** One scripted outcome for a request. */
export type FakeOutcome =
  | { readonly kind: "response"; readonly response: Omit<BrowserHttpResponse, never> }
  | { readonly kind: "timeout" }
  | { readonly kind: "network"; readonly message?: string };

export class FakeBrowserExecutor implements BrowserExecutor {
  readonly requests: BrowserHttpRequest[] = [];
  disposeCalls = 0;
  /** True when a request arrived after `dispose()` ran. */
  requestAfterDispose = false;
  private readonly outcomes: readonly FakeOutcome[];
  private index = 0;

  constructor(outcomes: readonly FakeOutcome[] = [{ kind: "response", response: { status: 200, body: "{}", retryAfterSeconds: null, timedOut: false } }]) {
    this.outcomes = outcomes;
  }

  async execute(request: BrowserHttpRequest): Promise<BrowserHttpResponse> {
    if (this.disposeCalls > 0) {
      this.requestAfterDispose = true;
      throw new BrowserExecutionError("NETWORK", "executor disposed");
    }
    this.requests.push(request);
    const outcome = this.outcomes[Math.min(this.index, this.outcomes.length - 1)]!;
    this.index += 1;
    if (outcome.kind === "timeout") {
      throw new BrowserExecutionError("TIMEOUT", "request timed out");
    }
    if (outcome.kind === "network") {
      throw new BrowserExecutionError("NETWORK", outcome.message ?? "network failure");
    }
    return outcome.response;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }

  describe(): string {
    return "fake-browser-executor";
  }
}

/** Convenience: a 200 response carrying a JSON body. */
export function okResponse(body: string, retryAfterSeconds: number | null = null): FakeOutcome {
  return { kind: "response", response: { status: 200, body, retryAfterSeconds, timedOut: false } };
}

/** Convenience: a non-OK status with an optional body. */
export function statusResponse(status: number, body = "", retryAfterSeconds: number | null = null): FakeOutcome {
  return { kind: "response", response: { status, body, retryAfterSeconds, timedOut: false } };
}
