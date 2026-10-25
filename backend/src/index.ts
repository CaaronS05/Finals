/**
 * Backend public surface.
 */

export { loadConfig, CONFIG_DEFAULTS, type BackendConfig } from "./config.ts";
export {
  BackendError,
  ConfigError,
  CdpUnavailableError,
  CdpConnectTimeoutError,
  CdpDisconnectedError,
  CdpOperationError,
  sanitizeError,
  toErrorMessage,
  type BackendErrorCode,
} from "./errors.ts";
export { createBackendHttpServer, SERVICE_NAME, type HealthResponse } from "./http/index.ts";
export {
  CdpConnection,
  CdpNotConnectedError,
  FakeCdpTransport,
  PlaywrightCdpTransport,
  createPlaywrightCdpTransport,
  DEFAULT_CDP_ENDPOINT,
  FORBIDDEN_CDP_PORT,
  ForbiddenCdpPortError,
  isPermittedCdpEndpoint,
  validateCdpEndpoint,
  type CdpConnectionStatus,
  type CdpConnectOptions,
  type CdpSessionInfo,
  type CdpTransport,
} from "./cdp/index.ts";
