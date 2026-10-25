/**
 * CloakBrowser / CDP endpoint conventions.
 *
 * PORT 9223 IS A HISTORICAL DLLM CONVENTION, NOT A VERIFIED ACTIVE ENDPOINT.
 * The legacy Rahasia repository targets CloakBrowser on 9223, but no live
 * probe has confirmed a running instance at the time of writing.
 *
 * PORT 9222 (legacy Brave) IS STRICTLY FORBIDDEN. The legacy codebase treats
 * a 9222 configuration as a security violation and refuses to connect. That
 * rule is preserved here.
 */

/** Default CDP endpoint. Loopback, historical DLLM convention. */
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9223";

/** Legacy Brave port. Connecting to it is forbidden. */
export const FORBIDDEN_CDP_PORT = 9222;

/** Thrown when configuration targets the forbidden legacy Brave port. */
export class ForbiddenCdpPortError extends Error {
  readonly port: number;

  constructor(port: number) {
    super(
      `Refusing to connect to legacy Brave CDP port ${port}. CloakBrowser on port 9223 is required.`,
    );
    this.name = "ForbiddenCdpPortError";
    this.port = port;
  }
}

/**
 * Validate that a CDP endpoint is permitted.
 *
 * Rejects the forbidden legacy Brave port and any non-loopback host. Returns
 * the normalized endpoint with trailing slashes removed.
 */
export function validateCdpEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid CDP endpoint URL: "${endpoint}"`);
  }
  if (parsed.port !== "" && Number(parsed.port) === FORBIDDEN_CDP_PORT) {
    throw new ForbiddenCdpPortError(FORBIDDEN_CDP_PORT);
  }
  const loopback: Record<string, true> = {
    "127.0.0.1": true,
    localhost: true,
    "::1": true,
    "[::1]": true,
  };
  if (loopback[parsed.hostname] !== true) {
    throw new Error(
      `CDP endpoint host must be loopback, got "${parsed.hostname}". Got "${endpoint}".`,
    );
  }
  return endpoint.replace(/\/+$/, "");
}

/**
 * Whether an endpoint is permitted for CDP connection.
 * Non-throwing form for callers that need a boolean check.
 */
export function isPermittedCdpEndpoint(endpoint: string): boolean {
  try {
    validateCdpEndpoint(endpoint);
    return true;
  } catch {
    return false;
  }
}
