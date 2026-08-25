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
// (citation rot, task 24.16, now corrected). `buildToolWriteHealthSignal`'s `kind` union was
// widened (task 24.21) to a real 4-member exhaustive switch, so a precondition HOLD
// (`outbox_blocked` / `write_through_blocked`) and an errored ATTEMPT (`write_through_failed`
// / `schema_rejection`) now map onto distinct FailureClass values and dedupe keys.
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
 * (blocked vs failed) its value collapsed — a name/value contradiction (task 24.16), now
 * corrected: `write_through_failed` is a genuine errored ATTEMPT, distinct from the
 * `write_through_blocked` HOLD constant below (task 24.21).
 */
export const WRITE_THROUGH_FAILED_HEALTH_CLASS: FailureClass = "write_through_failed";

/** A candidate/envelope failed the schema/candidate gate (§8 write path). */
export const SCHEMA_REJECTION_HEALTH_CLASS: FailureClass = "schema_rejection";

/**
 * A precondition/gate HOLDS the write-through — the write was never attempted
 * (distinct from `write_through_failed`, where the attempt itself errored;
 * shared-enums.ts:157-159, task 13.15/ARC-2, task 24.21).
 */
export const WRITE_THROUGH_BLOCKED_HEALTH_CLASS: FailureClass = "write_through_blocked";

/**
 * The external-write outbox is gated/held (§8 pre-dispatch hold) — a backlog
 * of held writes that were never attempted. Severity `error`: a gated outbox
 * is operator-actionable (shared-enums.ts:154-156, task 13.15/ARC-2, task 24.21).
 */
export const OUTBOX_BLOCKED_HEALTH_CLASS: FailureClass = "outbox_blocked";

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
// Elevated severity for a gated outbox (task 24.21) — a backlog of held writes
// that were never attempted is operator-actionable in a way a single failed
// attempt is not.
const ELEVATED_SEVERITY = "error" as const;

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
 * the failure class AND its severity — a precondition HOLD (never attempted) is
 * distinct from an errored ATTEMPT (task 24.21):
 *   • `write_through_blocked` — a precondition/gate holds the write-through (HOLD) → warn.
 *   • `outbox_blocked`        — the outbox itself is gated/held (HOLD, backlog)   → error.
 *   • `write_through_failed`  — the write attempt errored (ATTEMPT)              → warn.
 *   • `schema_rejection`      — the candidate gate rejected the envelope (ATTEMPT) → warn.
 * `outbox_blocked` alone is `error`: a gated outbox is operator-actionable in a way
 * a single failed attempt or a single blocked write is not. `subjectRef` is the
 * dedupe subject (canonicalObjectKey or actionId). Pure/clock-free.
 */
export function buildToolWriteHealthSignal(input: {
  subjectRef: string;
  reason: string;
  kind: "write_through_failed" | "schema_rejection" | "write_through_blocked" | "outbox_blocked";
}): GatewayHealthSignal {
  let failureClass: FailureClass;
  let severity: string;
  switch (input.kind) {
    case "schema_rejection":
      failureClass = SCHEMA_REJECTION_HEALTH_CLASS;
      severity = DEFAULT_SEVERITY;
      break;
    case "write_through_blocked":
      failureClass = WRITE_THROUGH_BLOCKED_HEALTH_CLASS;
      severity = DEFAULT_SEVERITY;
      break;
    case "outbox_blocked":
      failureClass = OUTBOX_BLOCKED_HEALTH_CLASS;
      severity = ELEVATED_SEVERITY;
      break;
    case "write_through_failed":
      failureClass = WRITE_THROUGH_FAILED_HEALTH_CLASS;
      severity = DEFAULT_SEVERITY;
      break;
    default: {
      // Exhaustiveness guard (mirrors packages/workflows/src/activities/healthItem.ts:71-80):
      // a future `kind` member breaks tsc HERE, forcing a deliberate severity decision above.
      const _never: never = input.kind;
      failureClass = WRITE_THROUGH_FAILED_HEALTH_CLASS;
      severity = DEFAULT_SEVERITY;
      void _never;
    }
  }
  return {
    failureClass,
    subjectRef: input.subjectRef,
    severity,
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
