/**
 * Validated runtime configuration.
 *
 * Values are read from process.env and may be overridden without source
 * changes. Malformed values are rejected with a typed ConfigError rather than
 * silently defaulted, so a typo cannot bind the server to an unintended host
 * or port.
 *
 * No secrets are read here. The CDP endpoint is a loopback URL only.
 */

import { ConfigError } from "./errors.ts";

/** CDP endpoints are restricted to loopback by default. */
const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "::1": true,
  "[::1]": true,
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9223";
const DEFAULT_CDP_CONNECT_TIMEOUT_MS = 15_000;

const MIN_PORT = 1;
const MAX_PORT = 65_535;

export interface BackendConfig {
  /** Host the HTTP server binds to. Loopback only. */
  readonly host: string;
  /** Port the HTTP server binds to. */
  readonly port: number;
  /** CloakBrowser/CDP endpoint URL. */
  readonly cdpEndpoint: string;
  /** CDP connect timeout in milliseconds. */
  readonly cdpConnectTimeoutMs: number;
}

function parseHost(raw: string | undefined, field: string): string {
  const value = (raw ?? "").trim();
  if (value.length === 0) {
    return DEFAULT_HOST;
  }
  // Loopback enforcement: reject any non-loopback host at config time so the
  // backend can never bind to a routable interface by accident.
  if (LOOPBACK_HOSTS[value] !== true) {
    throw new ConfigError(
      `Invalid ${field}: "${value}". Only loopback hosts are allowed (127.0.0.1, ::1, localhost).`,
      { field },
    );
  }
  return value;
}

function parsePort(raw: string | undefined, field: string): number {
  const value = raw ?? "";
  if (value.length === 0) {
    return DEFAULT_PORT;
  }
  // Reject padded, non-numeric, fractional, and out-of-range values. Trimming
  // would silently accept " 8788 " and Number() would accept "8788abc", both
  // of which corrupt the bind.
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`Invalid ${field}: "${value}". Must be an integer between 1 and 65535.`, {
      field,
    });
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new ConfigError(`Invalid ${field}: "${value}". Must be an integer between 1 and 65535.`, {
      field,
    });
  }
  return port;
}

function parseTimeout(raw: string | undefined, field: string): number {
  const value = (raw ?? "").trim();
  if (value.length === 0) {
    return DEFAULT_CDP_CONNECT_TIMEOUT_MS;
  }
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`Invalid ${field}: "${value}". Must be a non-negative integer in milliseconds.`, {
      field,
    });
  }
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 0) {
    throw new ConfigError(`Invalid ${field}: "${value}". Must be a non-negative integer in milliseconds.`, {
      field,
    });
  }
  return timeout;
}

function parseCdpEndpoint(raw: string | undefined, field: string): string {
  const value = (raw ?? "").trim();
  if (value.length === 0) {
    return DEFAULT_CDP_ENDPOINT;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`Invalid ${field}: "${value}". Must be an absolute http:// or https:// URL.`, {
      field,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `Invalid ${field}: "${value}". Only http:// and https:// URLs are supported.`,
      { field },
    );
  }
  if (LOOPBACK_HOSTS[parsed.hostname] !== true) {
    throw new ConfigError(
      `Invalid ${field}: "${value}". Only loopback hosts are allowed (127.0.0.1, ::1, localhost).`,
      { field },
    );
  }
  // Strip trailing slashes so callers can safely append paths.
  return value.replace(/\/+$/, "");
}

/**
 * Build a validated configuration from an environment map.
 *
 * Throws ConfigError on any malformed value. Pass `process.env` for the real
 * runtime, or a plain object in tests.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  return {
    host: parseHost(env.BACKEND_HOST, "BACKEND_HOST"),
    port: parsePort(env.BACKEND_PORT, "BACKEND_PORT"),
    cdpEndpoint: parseCdpEndpoint(env.CDP_ENDPOINT, "CDP_ENDPOINT"),
    cdpConnectTimeoutMs: parseTimeout(env.CDP_CONNECT_TIMEOUT_MS, "CDP_CONNECT_TIMEOUT_MS"),
  };
}

/** Documented defaults, exported for tests and documentation parity. */
export const CONFIG_DEFAULTS = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  cdpEndpoint: DEFAULT_CDP_ENDPOINT,
  cdpConnectTimeoutMs: DEFAULT_CDP_CONNECT_TIMEOUT_MS,
} as const;
