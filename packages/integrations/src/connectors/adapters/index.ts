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
export { createCalendarConnector } from "./calendar";
export { createTodoistConnector } from "./todoist";
export { createLinearConnector } from "./linear";
export { createAsanaConnector } from "./asana";
export { createGranolaConnector } from "./granola";
export { createDriveConnector } from "./drive";
export { createGithubConnector } from "./github";
export { createTelegramCaptureConnector } from "./telegram-capture";
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
