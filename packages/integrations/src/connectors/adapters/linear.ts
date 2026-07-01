// @sow/integrations — Linear read connector (slice 6.3, V1 set — MCP/remote).
//
// Read-only issue ingestion via Linear's REMOTE (MCP/vendor) service. Auth is
// scoped to the least-privilege READ scope `read` — never a write/mutate scope.
// Because the vendor is remote, a transport network failure is NOT a local throw:
// the shared `makeConnector` base collapses it to `ConnectorError{code:'unreachable'}`
// (the 6.1 unreachable branch). Transport-mocked; no real network / clock here.
import { makeConnector } from "./base";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport } from "../transport";

/** Build the Linear read connector over an injected (remote/MCP) transport. */
export function createLinearConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "linear", readScope: "read" }, transport);
}
