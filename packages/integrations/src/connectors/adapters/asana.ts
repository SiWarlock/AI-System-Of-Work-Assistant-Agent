// @sow/integrations — Asana read connector (slice 6.3, V1 set — MCP/remote).
//
// Read-only task ingestion via Asana's REMOTE (MCP/vendor) service. Auth is scoped
// to the least-privilege READ scope `tasks:read` — never a write/mutate scope. As
// a remote service, a transport network failure routes to the 6.1 unreachable
// branch via the shared `makeConnector` base, NOT a local throw. Transport-mocked;
// no real network / clock here.
import { makeConnector } from "./base";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport } from "../transport";

/** Build the Asana read connector over an injected (remote/MCP) transport. */
export function createAsanaConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "asana", readScope: "tasks:read" }, transport);
}
