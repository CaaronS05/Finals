/**
 * LP Agent connector public surface.
 *
 * F2-A scope: contracts, validation, and transport injection only. No provider
 * request, no navigation, and no browser lifecycle live here.
 */
export {
  isPoolAddress,
  parsePoolAddress,
  POOL_ADDRESS_LENGTH,
  type PoolAddressParseResult,
  type PoolAddressRejectionReason,
} from "./pool-address.ts";
export {
  LpAgentError,
  LpAgentError as LpAgentConnectorError,
  LpAgentInvalidPoolAddressError,
  LpAgentInvalidResponseError,
  LpAgentPaginationError,
  LpAgentPartialResultError,
  LpAgentRequestError,
  LpAgentTransportUnavailableError,
  type LpAgentErrorCode,
} from "./errors.ts";
export {
  type AcquisitionCompleteness,
  type LpAgentPageRequest,
  type LpAgentPageResponse,
  type LpAgentTransport,
  type LpPositionReference,
  type PaginationMetadata,
  type PoolIdentity,
  type PoolMetadataResult,
  type SourceFetchResult,
  type SourceProvenance,
  type WalletOwnerIdentity,
} from "./contracts.ts";
export {
  PaginationBeyondTotalError,
  PaginationDuplicateError,
  PaginationTotalChangedError,
  createEmptyPaginationState,
  isFinalPage,
  nextPageState,
  recordPageFailure,
  recordPageSuccess,
  remainingPages,
  type PaginationState,
} from "./pagination.ts";
export {
  mapEnvelope,
  mapEnvelopeOrThrow,
  mapRow,
  type EnvelopeMapping,
  type RawLpAgentEnvelope,
} from "./mapping.ts";
export {
  acquirePoolPositions,
  type AcquireOptions,
  type AcquiredPage,
  type PoolAcquisitionResult,
} from "./connector.ts";
export {
  ALLOWED_LP_AGENT_ORIGINS,
  BrowserExecutionError,
  isAllowedLpAgentUrl,
  toRequestError,
  type BrowserExecutionFailure,
  type BrowserExecutor,
  type BrowserHttpRequest,
  type BrowserHttpResponse,
} from "./browser-execution.ts";
export {
  FakeBrowserExecutor,
  okResponse,
  statusResponse,
  type FakeOutcome,
} from "./fake-browser-executor.ts";
export {
  LP_AGENT_BASE_URL,
  LP_AGENT_ORDER_BY,
  LP_AGENT_PAGE_SIZE,
  LP_AGENT_SORT_ORDER,
  LP_AGENT_TOP_LPERS_PATH,
  LpAgentBrowserTransport,
  buildTopLpersUrl,
  type LpAgentBrowserTransportOptions,
} from "./browser-transport.ts";
export {
  LP_AGENT_TAB_MARKER,
  OwnedPageTracker,
  isOwnedLpAgentPage,
  type BrowserContextHandle,
  type BrowserPageHandle,
} from "./owned-pages.ts";
