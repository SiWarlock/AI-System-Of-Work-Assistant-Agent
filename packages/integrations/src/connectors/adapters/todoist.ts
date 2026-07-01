// @sow/integrations — Todoist read connector (slice 6.3, V1 set).
//
// Read-only task ingestion. Auth is scoped to the least-privilege READ scope
// `data:read` — the connector never requests Todoist write access. Transport-
// mocked: the injected `ConnectorTransport` performs the fetch; no real network /
// clock here. Mapping + fail-closed unreachable behavior come from the shared
// `makeConnector` base (§16).
import { makeConnector } from "./base";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport } from "../transport";

/** Build the Todoist read connector over an injected transport. */
export function createTodoistConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "todoist", readScope: "data:read" }, transport);
}
