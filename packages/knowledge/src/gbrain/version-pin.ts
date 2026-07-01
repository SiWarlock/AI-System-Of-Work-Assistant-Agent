// GBrain startup version-pin check (§6 / §13, task 4.7; OQ-006 / GbrainPin).
//
// Before a per-workspace brain is trusted for serving, the adapter reads the
// typed `GbrainPin` (from `config/gbrain.pin`) and verifies the RUNNING gbrain
// against it. The pin match enables the read/index surface against the pinned
// build; ANY of {SHA mismatch, index-schema drift, a PENDING sentinel, an
// unavailable gbrain} FAILS CLOSED — the brain degrades to read-only/index-only
// (the DoD-satisfying fallback + kill switch, REQ-D-001) and a distinct System
// Health item (§16) is opened. This module NEVER throws across the boundary
// (§16): a serving decision is the `ok` branch, a fail-closed degradation the
// typed `err` branch (both carry enumerable state).
//
// `writeThroughEnabled` is a SEPARATE per-workspace gate (§12/task-12.22) layered
// ON TOP of a matched, LIVE-validated pin — it only makes write-through
// *eligible*; it never widens the version gate. A degraded brain is never
// write-through eligible.
//
// PURE decision logic: no clock/network/fs of its own — the caller injects the
// running-version probe result, an ISO `now`, and the degradation `auditRef`.
import { ok, err } from "@sow/contracts";
import type { Result, GbrainPin, HealthItem, AuditId, FailureClass } from "@sow/contracts";

/** The two spec-load-bearing `validatedOn` sentinels (kept private in the
 *  contract). While either is set, LIVE validation is still owed, so the
 *  version-pin check refuses to serve — even against a matching SHA. */
const PENDING_SENTINELS = ["PENDING_PHASE12", "PENDING_LIVE_VALIDATION"] as const;

/** True when `validatedOn` is a PENDING sentinel (owed validation), matched by
 *  the exact spec values and the `PENDING_` prefix convention. */
export function isPendingSentinel(validatedOn: string): boolean {
  return (
    (PENDING_SENTINELS as readonly string[]).includes(validatedOn) ||
    validatedOn.startsWith("PENDING_")
  );
}

/** What the running gbrain reports about itself (via `gbrain doctor --json`),
 *  probed by the caller. `undefined` = gbrain unavailable / unreachable. */
export interface RunningGbrainVersion {
  /** Full or abbreviated (≥7 char) lowercase-hex commit SHA of the running build. */
  readonly sha: string;
  /** `doctor` index `schema_version`; omitted when the build does not report it. */
  readonly indexSchemaVersion?: number;
}

/** Injected surroundings for building the degradation HealthItem — no ambient
 *  clock or id source enters this module. */
export interface VersionPinContext {
  /** ISO-8601 clock for `HealthItem.openedAt`. */
  readonly now: () => string;
  /** AuditId of the degradation audit record the caller records alongside. */
  readonly auditRef: string;
  /** Optional stable HealthItem id (else derived from the reason — dedupe id is
   *  (failureClass, subjectRef) per §10.3, not this field). */
  readonly healthItemId?: string;
  /** Optional open-taxonomy severity (arch_gap — §16 pins no closed set). */
  readonly severity?: string;
}

export type VersionPinDegradeReason =
  | "sha_mismatch"
  | "index_schema_mismatch"
  | "pending_validation"
  | "gbrain_unavailable";

/** Pin matched + LIVE-validated: the read/index surface serves against the
 *  pinned build. `writeThroughEligible` is `pin.writeThroughEnabled` (the
 *  version gate is already satisfied on this branch). */
export interface VersionPinServing {
  readonly mode: "serving";
  readonly pinnedSha: string;
  readonly indexSchemaVersion: number;
  readonly writeThroughEligible: boolean;
}

/** Fail-closed degradation: read-only/index-only + a System Health item. */
export interface VersionPinDegraded {
  readonly mode: "read_only_index_only";
  readonly reason: VersionPinDegradeReason;
  readonly healthItem: HealthItem;
}

const REASON_FAILURE_CLASS: Record<VersionPinDegradeReason, FailureClass> = {
  // The pinned build is not the one running (or its validation is still owed),
  // so the write-through / serving layer cannot safely run — surfaced under the
  // write-through failure class, degraded to read-only/index-only.
  sha_mismatch: "write_through_failed",
  index_schema_mismatch: "write_through_failed",
  pending_validation: "write_through_failed",
  // gbrain isn't answering at all.
  gbrain_unavailable: "connector_unreachable",
};

const REASON_MESSAGE: Record<VersionPinDegradeReason, string> = {
  sha_mismatch:
    "running gbrain SHA does not match the pinned SHA; degraded to read-only/index-only",
  index_schema_mismatch:
    "running gbrain index schema_version does not match the pinned indexSchemaVersion; degraded to read-only/index-only",
  pending_validation:
    "GbrainPin.validatedOn is a PENDING sentinel (LIVE validation owed); degraded to read-only/index-only",
  gbrain_unavailable:
    "gbrain is unavailable; degraded to read-only/index-only",
};

/** Case-insensitive SHA equality that also accepts an abbreviated (≥7 char) SHA
 *  on either side prefixing the other — `gbrain doctor` may report a short SHA
 *  while the pin stores the full 40-hex. */
function shaMatches(pinned: string, running: string): boolean {
  const a = pinned.toLowerCase();
  const b = running.toLowerCase();
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 7 && longer.startsWith(shorter);
}

function degrade(
  reason: VersionPinDegradeReason,
  ctx: VersionPinContext,
): Result<VersionPinServing, VersionPinDegraded> {
  const healthItem: HealthItem = {
    id: ctx.healthItemId ?? `gbrain-version-pin:${reason}`,
    failureClass: REASON_FAILURE_CLASS[reason],
    severity: ctx.severity ?? "error",
    message: REASON_MESSAGE[reason],
    auditRef: ctx.auditRef as AuditId,
    openedAt: ctx.now(),
    state: "open",
  };
  return err({ mode: "read_only_index_only", reason, healthItem });
}

/**
 * Verify the running gbrain against the pinned build. Fail-closed on any
 * mismatch / owed validation / unavailability; never throws (§16).
 */
export function checkVersionPin(
  pin: GbrainPin,
  running: RunningGbrainVersion | undefined,
  ctx: VersionPinContext,
): Result<VersionPinServing, VersionPinDegraded> {
  if (running === undefined) {
    return degrade("gbrain_unavailable", ctx);
  }
  if (!shaMatches(pin.gbrainSha, running.sha)) {
    return degrade("sha_mismatch", ctx);
  }
  if (
    running.indexSchemaVersion !== undefined &&
    running.indexSchemaVersion !== pin.indexSchemaVersion
  ) {
    return degrade("index_schema_mismatch", ctx);
  }
  if (isPendingSentinel(pin.validatedOn)) {
    return degrade("pending_validation", ctx);
  }
  return ok({
    mode: "serving",
    pinnedSha: pin.gbrainSha,
    indexSchemaVersion: pin.indexSchemaVersion,
    writeThroughEligible: pin.writeThroughEnabled,
  });
}
