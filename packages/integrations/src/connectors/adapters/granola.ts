// @sow/integrations — Granola read connector (slice 6.3, V1 set — MCP/remote).
//
// Read-only meeting-notes ingestion via Granola's REMOTE (MCP/vendor) service.
// Auth is scoped to the least-privilege READ scope `meetings:read` — never a
// write/mutate scope. As a remote service, a transport network failure routes to
// the 6.1 unreachable branch via the shared `makeConnector` base, NOT a local
// throw. Transport-mocked; no real network / clock here.
import { makeConnector } from "./base";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport } from "../transport";

/** Build the Granola read connector over an injected (remote/MCP) transport. */
export function createGranolaConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "granola", readScope: "meetings:read" }, transport);
}
