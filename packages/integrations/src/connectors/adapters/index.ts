// @sow/integrations — slice 6.3 connector-adapter barrel (V1 set).
//
// Re-exports the concrete read connectors + the shared spec/base, plus the §13.4
// read-only Obsidian-vault tool surface (a shape-(A) read-tool-descriptor surface,
// NOT a ConnectorPort). This is a LOCAL barrel for the connectors subtree — NOT the
// package `src/index.ts` (the Synthesis stage owns that public barrel). The Connector
// Gateway (6.1) drives the `ConnectorPort`s; each is built over an injected transport (6.3).
export { makeConnector } from "./base";
export type { ConnectorSpec } from "./base";
// §13.12 reusable read-only connector HTTP transport template + the Asana instance (DORMANT — the real
// HttpTransport + SecretsAccessor stay UNBOUND; the owner-arming boot binding is their production caller).
// (`transportFailure` stays internal — same-package mapPage authors import it directly from ./http-transport.)
export { createConnectorHttpTransport } from "./http-transport";
export type {
  ConnectorHttpSpec,
  ConnectorHttpTransportDeps,
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  SecretsAccessor,
  SecretUnavailable,
} from "./http-transport";
export { createAsanaHttpTransport } from "./asana";
export { createDriveHttpTransport } from "./drive";
export { createCalendarHttpTransport } from "./calendar";
export { createGranolaHttpTransport } from "./granola";
export { createGithubHttpTransport } from "./github";
export { createLinearHttpTransport } from "./linear";
export { createGmailHttpTransport } from "./gmail";
export { createCalendarConnector } from "./calendar";
export { createTodoistConnector, createTodoistHttpTransport } from "./todoist";
export { createLinearConnector } from "./linear";
export { createAsanaConnector } from "./asana";
export { createGranolaConnector } from "./granola";
export { createDriveConnector } from "./drive";
export { createGithubConnector } from "./github";
export { createGmailConnector } from "./gmail";
export { createTelegramCaptureConnector, createTelegramCaptureHttpTransport } from "./telegram-capture";
export { createUrlSourceConnector } from "./url-source";
// §13.4 read-only Obsidian-vault MCP tool surface (shape (A): a read-tool-descriptor surface, not a
// ConnectorPort — registers only the 5 read tools; the 3 write tools are NOT registered, KN-4/KN-9).
export {
  createObsidianVaultReadConnector,
  OBSIDIAN_VAULT_READ_TOOLS,
  OBSIDIAN_VAULT_WRITE_TOOL_IDS,
} from "./obsidian-vault-mcp";
export type {
  ObsidianVaultToolSpec,
  ObsidianVaultConfig,
  ObsidianVaultTransport,
  ObsidianVaultReadConnector,
  VaultReadCall,
  VaultReadResult,
  VaultReadError,
  VaultReadTransportResult,
} from "./obsidian-vault-mcp";
// §13.2a web source real-parse transport (DORMANT — SSRF-guarded over an injected httpGet; real fetch = §ARM-23).
export { parseReadabilityHtml, createWebFetchTransport } from "./web-fetch-transport";
export type { WebHttpResponse, WebHttpGet, WebFetchTransportDeps } from "./web-fetch-transport";

// §13.13 RES-1 free key-less source aggregator (DORMANT — faked transport; egress-veto-first, gates identically).
export { createFreeSourceAggregator, FREE_SOURCES, FREE_SOURCE_EGRESS_ROUTE } from "./free-source-aggregator";
export type {
  FreeSource,
  FreeSourceTransport,
  FreeSourceFetchRequest,
  FreeSourceFetchResponse,
  FreeSourceResult,
  AggregatedResearch,
  AggregatorEgressDenied,
  ResearchContext,
  FreeSourceAggregatorDeps,
  FreeSourceAggregator,
} from "./free-source-aggregator";

// §13.2b/13.2c/23.5 podcast + youtube real-extract transports + the generic URL-source candidate
// HTTP transport (ALL DORMANT — SSRF-guarded over injected httpGet/run/transport seams; real
// network/spawn binds only at §ARM-23).
export { parseRssFeed, createPodcastExtractTransport } from "./podcast-extract-transport";
export type {
  PodcastHttpResponse,
  PodcastHttpGet,
  PodcastExtractTransportDeps,
  PodcastRssParseError,
} from "./podcast-extract-transport";
export { createYouTubeExtractTransport } from "./youtube-extract-transport";
export type { YouTubeRunResult, YouTubeRunner, YouTubeExtractTransportDeps } from "./youtube-extract-transport";
export { createUrlSourceHttpTransport } from "./url-source";
export type { UrlSourceHttpTransportDeps } from "./url-source";

// §13.10c Gmail ingestion source adapter (emit-only, on the §13.2 pattern) — maps ONE hydrated
// Gmail message to a CANDIDATE RegisterSourceInput. DORMANT: no transport bound here; nothing arms.
export { extractGmailSource } from "./gmail-source";
export type {
  GmailMessage,
  GmailSourceResult,
  GmailSourceTransport,
  ExtractGmailSourceInput,
  GmailSourceError,
} from "./gmail-source";

// 23.6 coding-session git-hook capture producer + repo→workspace resolver + the sanctioned
// verifyCodingSessionOrigin binding (24.14) — ALL DORMANT: no hook installed, no git binary
// invoked, zero production callers. See capture-source.ts's CaptureDeps doc for binding status.
export {
  buildCodingSessionCapture,
  createRepoWorkspaceResolver,
  createCodingSessionOriginVerifier,
} from "./coding-session-capture";
export type { GitHookEvent, CaptureBuildError } from "./coding-session-capture";
