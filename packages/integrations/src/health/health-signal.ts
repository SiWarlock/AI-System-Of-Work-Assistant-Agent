// @sow/integrations — gateway health signals (§16 OBS-2).
//
// The Connector Gateway (reads) and Tool Gateway (writes) surface degraded
// conditions as a pure, clock-free `GatewayHealthSignal`. This module does NOT
// materialize the persisted `HealthItem` — Phase-7 / §9 owns HealthItem
// materialization (state machine, severity, timestamps, persistence). Here we
// emit the raw signal (a real `FailureClass` + a subject + a redaction-safe
// message) and a stable dedupe key so the materializer can coalesce repeats.
//
// PURE + DETERMINISTIC: no clock, no I/O, no throw. Every message is run through
// `redactString` (§16 / safety rule 7) so raw fetched/written content or a
// credential never reaches a health sink.
//
// arch_gap (FLAGGED as carry-forward): there is no dedicated `outbox_blocked` /
// `write_through_blocked` member in the frozen `FailureClass` enum — a blocked
// outbox drain reuses `write_through_failed`. WRITE_THROUGH_BLOCKED_HEALTH_CLASS
// is that reuse alias, NOT a new enum member.
import type { FailureClass } from "@sow/contracts";
import { redactString } from "../redaction/gateway-log-redaction";

// --- named failure-class constants (all valid FailureClass members) ---------

/** A connector read could not reach its external system (§8 read path). */
export const CONNECTOR_UNREACHABLE_HEALTH_CLASS: FailureClass = "connector_unreachable";

/**
 * A tool write / outbox drain is blocked (target unreachable, hold-through-outage).
 * arch_gap: reuses `write_through_failed` — no dedicated `outbox_blocked` member
 * exists in the frozen enum. FLAGGED as a carry-forward.
 */
export const WRITE_THROUGH_BLOCKED_HEALTH_CLASS: FailureClass = "write_through_failed";

/** A candidate/envelope failed the schema/candidate gate (§8 write path). */
export const SCHEMA_REJECTION_HEALTH_CLASS: FailureClass = "schema_rejection";

// --- signal shape -----------------------------------------------------------

/**
 * A raw gateway health signal — the input to Phase-7 HealthItem materialization.
 * `message` is ALWAYS redaction-safe (built via `redactString`). `severity` is an
 * open string here (the frozen HealthItem severity taxonomy is an arch_gap owned
 * downstream); `refs` are correlation pointers (ids), never raw content.
 */
export interface GatewayHealthSignal {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity: string;
  readonly message: string;
  readonly refs: readonly string[];
}

// A conservative default severity. The frozen HealthItem severity set is an
// arch_gap (open) owned by the Phase-7 materializer; a gateway signal is
// operator-actionable, so "warn" is the safe non-blocking default.
const DEFAULT_SEVERITY = "warn" as const;

// --- builders ---------------------------------------------------------------

/**
 * Build the health signal for an unreachable connector read. `subjectRef` is the
 * connectorId (the deduplication subject); `refs` carries the workspaceId. The
 * message embeds the (redacted) reason. Pure/clock-free.
 */
export function buildConnectorHealthSignal(input: {
  connectorId: string;
  workspaceId: string;
  reason: string;
}): GatewayHealthSignal {
  return {
    failureClass: CONNECTOR_UNREACHABLE_HEALTH_CLASS,
    subjectRef: input.connectorId,
    severity: DEFAULT_SEVERITY,
    message: redactString(`connector ${input.connectorId} unreachable: ${input.reason}`),
    refs: [input.workspaceId],
  };
}

/**
 * Build the health signal for a tool-write / outbox-drain fault. `kind` selects
 * the failure class: `write_through_failed` (blocked drain / target unreachable)
 * or `schema_rejection` (candidate-gate failure). `subjectRef` is the dedupe
 * subject (canonicalObjectKey or actionId). Pure/clock-free.
 */
export function buildToolWriteHealthSignal(input: {
  subjectRef: string;
  reason: string;
  kind: "write_through_failed" | "schema_rejection";
}): GatewayHealthSignal {
  const failureClass: FailureClass =
    input.kind === "schema_rejection"
      ? SCHEMA_REJECTION_HEALTH_CLASS
      : WRITE_THROUGH_BLOCKED_HEALTH_CLASS;
  return {
    failureClass,
    subjectRef: input.subjectRef,
    severity: DEFAULT_SEVERITY,
    message: redactString(`tool write ${input.subjectRef} ${input.kind}: ${input.reason}`),
    refs: [input.subjectRef],
  };
}

/**
 * Stable coalescing key for a health signal: `failureClass|subjectRef`. Two
 * signals with the same class + subject dedupe to one HealthItem regardless of
 * message. Pure/deterministic.
 */
export function healthDedupeKey(sig: GatewayHealthSignal): string {
  return `${sig.failureClass}|${sig.subjectRef}`;
}
