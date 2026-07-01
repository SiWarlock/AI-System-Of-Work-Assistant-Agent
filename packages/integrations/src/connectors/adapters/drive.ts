// @sow/integrations — Google Drive read connector (slice 6.3, V1 set).
//
// Read-only Drive file/metadata ingestion. Auth is scoped to the least-privilege
// READ scope `drive.readonly` — the connector never requests write access (the
// Drive WRITE path is the Tool Gateway / NotebookPort, not this read connector).
// Transport-mocked: the injected `ConnectorTransport` performs the fetch; no real
// network / clock here. Mapping + fail-closed behavior from the shared base (§16).
import { makeConnector } from "./base";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport } from "../transport";

/** Build the Drive read connector over an injected transport. */
export function createDriveConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "drive", readScope: "drive.readonly" }, transport);
}
