// @sow/integrations — typed connector reachability classification (§8 / OBS-2).
//
// `classifyConnectorError(err, subject)` maps a CLOSED `ConnectorError.code` to a
// typed `ConnectorHealth` AND builds the foundation `GatewayHealthSignal`
// (`buildConnectorHealthSignal`) so a degraded/unreachable read never fails
// silently — it always yields an operator-actionable signal. PURE + DETERMINISTIC:
// no clock, no I/O, no throw. The error message is routed through foundation
// redaction inside `buildConnectorHealthSignal`, so a credential-shaped reason
// never reaches the health sink (safety rule 5 / §16).
//
// Mapping:
//   unreachable / malformed / unknown → 'unreachable'  (fail-closed on unexpected)
//   rate_limited / auth_locked        → 'degraded'     (transient / held-retryable)
// A successful read is 'reachable' — the gateway sets that directly; this module
// only classifies a FAILURE.
import type { GatewayHealthSignal } from "../health/health-signal";
import { buildConnectorHealthSignal } from "../health/health-signal";
import type { ConnectorError } from "./port";

/** Typed connector reachability. */
export type ConnectorHealth = "reachable" | "degraded" | "unreachable";

/** The classification result: a typed health + the OBS-2 signal to surface. */
export interface ConnectorErrorClassification {
  readonly health: ConnectorHealth;
  readonly signal: GatewayHealthSignal;
}

/** Map a connector error code to its (non-reachable) health level. */
function healthForCode(code: ConnectorError["code"]): ConnectorHealth {
  switch (code) {
    case "rate_limited":
    case "auth_locked":
      return "degraded";
    case "unreachable":
    case "malformed":
    case "unknown":
      return "unreachable";
    // No default: `code` is a closed union; adding a member is a compile error
    // here (exhaustiveness), so a new failure mode can never fall through silently.
  }
}

/**
 * Classify a connector fetch failure into a typed `ConnectorHealth` and the
 * foundation `GatewayHealthSignal` to emit. The signal's `subjectRef` is the
 * `connectorId` (dedupe subject); `refs` carries the `workspaceId`. The error
 * message is redacted by the foundation builder. Pure/clock-free.
 */
export function classifyConnectorError(
  error: ConnectorError,
  subject: { connectorId: string; workspaceId: string },
): ConnectorErrorClassification {
  const health = healthForCode(error.code);
  const signal = buildConnectorHealthSignal({
    connectorId: subject.connectorId,
    workspaceId: subject.workspaceId,
    reason: `${error.code}: ${error.message}`,
  });
  return { health, signal };
}
