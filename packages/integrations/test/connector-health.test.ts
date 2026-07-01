// Slice 6.1 — typed connector reachability classification (RED first).
//
// classifyConnectorError(err) maps a ConnectorError.code → ConnectorHealth
// ('reachable'|'degraded'|'unreachable') and emits a foundation GatewayHealthSignal
// (buildConnectorHealthSignal). Pure/deterministic; message is redaction-safe.
import { describe, it, expect } from "vitest";
import {
  classifyConnectorError,
  type ConnectorHealth,
} from "../src/connectors/health";
import type { ConnectorError } from "../src/connectors/port";
import { isGatewayLogSafe } from "../src/redaction/gateway-log-redaction";
import { CONNECTOR_UNREACHABLE_HEALTH_CLASS } from "../src/health/health-signal";

const err = (code: ConnectorError["code"], message = "boom"): ConnectorError => ({
  code,
  message,
});

describe("classifyConnectorError", () => {
  it("maps 'unreachable' → unreachable", () => {
    const r = classifyConnectorError(err("unreachable"), {
      connectorId: "todoist",
      workspaceId: "employer-work",
    });
    expect(r.health).toBe<ConnectorHealth>("unreachable");
  });

  it("maps 'rate_limited' and 'auth_locked' → degraded (transient / held, not fatal)", () => {
    expect(
      classifyConnectorError(err("rate_limited"), {
        connectorId: "todoist",
        workspaceId: "ws",
      }).health,
    ).toBe<ConnectorHealth>("degraded");
    expect(
      classifyConnectorError(err("auth_locked"), {
        connectorId: "todoist",
        workspaceId: "ws",
      }).health,
    ).toBe<ConnectorHealth>("degraded");
  });

  it("maps 'malformed' and 'unknown' → unreachable (fail-closed on unexpected)", () => {
    expect(
      classifyConnectorError(err("malformed"), {
        connectorId: "c",
        workspaceId: "ws",
      }).health,
    ).toBe<ConnectorHealth>("unreachable");
    expect(
      classifyConnectorError(err("unknown"), {
        connectorId: "c",
        workspaceId: "ws",
      }).health,
    ).toBe<ConnectorHealth>("unreachable");
  });

  it("emits a foundation GatewayHealthSignal with the connector_unreachable class", () => {
    const r = classifyConnectorError(err("unreachable"), {
      connectorId: "todoist",
      workspaceId: "employer-work",
    });
    expect(r.signal.failureClass).toBe(CONNECTOR_UNREACHABLE_HEALTH_CLASS);
    expect(r.signal.subjectRef).toBe("todoist");
    expect(r.signal.refs).toContain("employer-work");
  });

  it("routes the reason through redaction — a credential-shaped message never reaches the signal", () => {
    const r = classifyConnectorError(
      err("unreachable", "auth failed with sk-live-0123456789abcdef token"),
      { connectorId: "todoist", workspaceId: "ws" },
    );
    expect(isGatewayLogSafe(r.signal.message)).toBe(true);
    expect(r.signal.message).not.toContain("sk-live-0123456789abcdef");
  });
});
