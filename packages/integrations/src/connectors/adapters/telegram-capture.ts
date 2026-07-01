// @sow/integrations — Telegram capture read connector (slice 6.3, V1 set).
//
// Read-only inbound-message capture (the ingest side of the Telegram channel; the
// approval/notify WRITE side is the Tool Gateway `telegram` target, a separate
// path). Auth is scoped to the least-privilege READ scope `messages:read` — never
// a send/write scope. Transport-mocked: the injected `ConnectorTransport` performs
// the fetch; no real network / clock here. Fail-closed behavior from the shared
// base (§16). Captured message content is candidate data — redacted downstream.
import { makeConnector } from "./base";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport } from "../transport";

/** Build the Telegram capture read connector over an injected transport. */
export function createTelegramCaptureConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "telegram-capture", readScope: "messages:read" }, transport);
}
