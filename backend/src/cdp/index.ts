/**
 * CDP boundary public surface.
 */

export {
  CdpConnection,
  CdpNotConnectedError,
  type CdpConnectionStatus,
  type CdpConnectOptions,
  type CdpSessionInfo,
  type CdpTransport,
} from "./connection.ts";

export { FakeCdpTransport } from "./fake-transport.ts";

export {
  DEFAULT_CDP_ENDPOINT,
  FORBIDDEN_CDP_PORT,
  ForbiddenCdpPortError,
  isPermittedCdpEndpoint,
  validateCdpEndpoint,
} from "./endpoint.ts";

export { PlaywrightCdpTransport, createPlaywrightCdpTransport } from "./playwright-transport.ts";
