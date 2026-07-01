// @sow/integrations — slice 6.3 connector-adapter barrel (V1 set).
//
// Re-exports the nine concrete read connectors + the shared spec/base. This is a
// LOCAL barrel for the connectors subtree — NOT the package `src/index.ts` (the
// Synthesis stage owns that public barrel). The Connector Gateway (6.1) drives any
// of these `ConnectorPort`s; each is built over an injected transport (6.3).
export { makeConnector } from "./base";
export type { ConnectorSpec } from "./base";
export { createCalendarConnector } from "./calendar";
export { createTodoistConnector } from "./todoist";
export { createLinearConnector } from "./linear";
export { createAsanaConnector } from "./asana";
export { createGranolaConnector } from "./granola";
export { createDriveConnector } from "./drive";
export { createGithubConnector } from "./github";
export { createTelegramCaptureConnector } from "./telegram-capture";
export { createUrlSourceConnector } from "./url-source";
