// @sow/integrations — Google Calendar read connector (slice 6.3, V1 set).
//
// Read-only calendar-event ingestion. Auth is scoped to the least-privilege READ
// scope `calendar.readonly` — the connector never requests write/mutate access.
// Transport-mocked: the injected `ConnectorTransport` performs the actual fetch;
// this module holds no real network / clock. Mapping + fail-closed behavior come
// from the shared `makeConnector` base (§16 — never throws across the boundary).
import { makeConnector } from "./base";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport } from "../transport";

/** Build the Calendar read connector over an injected transport. */
export function createCalendarConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "calendar", readScope: "calendar.readonly" }, transport);
}
