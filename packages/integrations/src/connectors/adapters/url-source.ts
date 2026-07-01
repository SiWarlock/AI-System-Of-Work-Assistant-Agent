// @sow/integrations — generic URL-source read connector (slice 6.3, V1 set).
//
// Read-only fetch of an arbitrary source URL (the Flow-4 "paste a link" ingest —
// YouTube/article/podcast pages). Auth is scoped to the least-privilege READ verb
// `http:get` — a GET-only fetch, never a mutating HTTP method. Transport-mocked:
// the injected `ConnectorTransport` performs the GET; no real network / clock here.
// Fetched page content is UNTRUSTED candidate data — redacted downstream, never
// logged raw here (safety rule 5). Fail-closed behavior from the shared base (§16).
import { makeConnector } from "./base";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport } from "../transport";

/** Build the generic URL-source read connector over an injected transport. */
export function createUrlSourceConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "url-source", readScope: "http:get" }, transport);
}
