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
// The `outbox_blocked` / `write_through_blocked` FailureClass members DO exist
// (shared-enums.ts:154-155, task 13.15/ARC-2) — this comment previously claimed otherwise
// (citation rot, task 24.16, now corrected). `WRITE_THROUGH_FAILED_HEALTH_CLASS` below is a
// deliberate, exact-value constant for `write_through_failed`, not a reuse-alias for either
// new member; `buildToolWriteHealthSignal`'s `kind` parameter still conflates a genuine
// attempt-error with a blocked/held drain into that one value — a real, separately-tracked
// finding (a behavior/severity change, not a citation fix; not addressed here).
//
// arch_gap (FLAGGED as carry-forward): the frozen `FailureClass` enum has NO dedicated
// `coverage_degraded` member, so a partial-coverage read reuses `sync_lagging` via
// CONNECTOR_COVERAGE_DEGRADED_HEALTH_CLASS (16.4) — a genuine reuse alias (L25: never expand
// the frozen enum from a leaf).
import type { FailureClass } from "@sow/contracts";
import { redactString } from "../redaction/gateway-log-redaction";

// --- named failure-class constants (all valid FailureClass members) ---------

/** A connector read could not reach its external system (§8 read path). */
export const CONNECTOR_UNREACHABLE_HEALTH_CLASS: FailureClass = "connector_unreachable";

/**
 * A connector read SUCCEEDED but with PARTIAL corpus coverage (16.4) — e.g. Drive's
 * `incompleteSearch: true`: the ingested set is incomplete, so it is behind full coverage.
 * arch_gap: there is no dedicated `coverage_degraded` member in the frozen `FailureClass`
 * enum, so this reuses `sync_lagging` (the least-wrong "the ingested set is behind") (L25:
 * never expand the frozen enum from a leaf). A dedicated member is a FLAGGED carry-forward.
 */
export const CONNECTOR_COVERAGE_DEGRADED_HEALTH_CLASS: FailureClass = "sync_lagging";

/**
 * The `write_through_failed` FailureClass, named exact-value like its siblings below.
 * Previously named `WRITE_THROUGH_BLOCKED_HEALTH_CLASS`, which asserted a distinction
 * (blocked vs failed) its value collapsed — a name/value contradiction (task 24.16). Both
 * `outbox_blocked` and `write_through_blocked` are real, dedicated FailureClass members
 * (shared-enums.ts:154-155, task 13.15/ARC-2); this constant is `write_through_failed`
 * DELIBERATELY, not a reuse-alias standing in for either. `buildToolWriteHealthSignal`'s
 * `kind` parameter still conflates a genuine attempt-error with a blocked/held drain into
 * this one value — tracked separately, not fixed here (a behavior/severity change).
 */
export const WRITE_THROUGH_FAILED_HEALTH_CLASS: FailureClass = "write_through_failed";

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
 * Build the health signal for a coverage-degraded connector read (16.4) — a SUCCESSFUL
 * fetch whose query did not cover the full corpus (e.g. Drive `incompleteSearch`). Mirrors
 * `buildConnectorHealthSignal`: `subjectRef` is the connectorId (dedupe subject), `refs`
 * carries the workspaceId, the (redacted) reason is embedded. Uses the coverage-degrade
 * class (`sync_lagging` reuse) so it dedupes distinctly from an unreachable signal for the
 * same connector. Pure/clock-free.
 */
export function buildConnectorCoverageDegradeSignal(input: {
  connectorId: string;
  workspaceId: string;
  reason: string;
}): GatewayHealthSignal {
  return {
    failureClass: CONNECTOR_COVERAGE_DEGRADED_HEALTH_CLASS,
    subjectRef: input.connectorId,
    severity: DEFAULT_SEVERITY,
    message: redactString(`connector ${input.connectorId} coverage degraded: ${input.reason}`),
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
      : WRITE_THROUGH_FAILED_HEALTH_CLASS;
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
