// @sow/integrations — GitHub read connector (slice 6.3, V1 set).
//
// Read-only repo/issue/PR ingestion. Auth is scoped to the least-privilege READ
// scope `repo:read` — the connector never requests write/admin access (the GitHub
// WRITE path is the Tool Gateway, not this read connector). Transport-mocked: the
// injected `ConnectorTransport` performs the fetch; no real network / clock here.
// Mapping + fail-closed unreachable behavior from the shared base (§16).
import { makeConnector } from "./base";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport } from "../transport";

/** Build the GitHub read connector over an injected transport. */
export function createGithubConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "github", readScope: "repo:read" }, transport);
}
