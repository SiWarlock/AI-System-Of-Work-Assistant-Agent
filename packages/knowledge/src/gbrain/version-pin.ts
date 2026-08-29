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
  /**
   * Full or abbreviated (≥7 char) lowercase-hex commit SHA of the running build.
   *
   * ⛔ OPTIONAL SINCE `### 24.142`, AND THE REASON IS MEASURED, NOT DEFENSIVE. This field was
   * REQUIRED, with a docstring naming `gbrain doctor --json` as its source — and that probe
   * emits NO SHA. Measured 2026-08-28 against the installed `gbrain 0.35.1.0` (the exact
   * version `### 12.7` names): `--version`/`version` give the tag only, `doctor --json --fast`
   * gives `{"schema_version":2,"status":…,"health_score":…,"checks":[…]}`, and `check-update`
   * is not a command in this build. ⇒ `resolveRunning` could only ever return `undefined`, so
   * ***the pin could never MATCH — only DEGRADE.*** The one check standing between an unpinned
   * gbrain build and the serving surface was structurally unable to pass.
   */
  readonly sha?: string;
  /**
   * Human-readable release tag the build DOES report (e.g. `"0.35.1.0"`). A strictly WEAKER
   * identity than the SHA — it is what the binary claims about itself, with no commit behind it
   * — and it is used ONLY when {@link VersionPinOptions.allowTagFallback} is explicitly on.
   */
  readonly tag?: string;
  /** `doctor` index `schema_version`; omitted when the build does not report it. */
  readonly indexSchemaVersion?: number;
}

/**
 * Opt-in relaxations for {@link checkVersionPin}. Omitted ⇒ the shipped default, byte-equivalent
 * to before this existed.
 */
export interface VersionPinOptions {
  /**
   * Accept a matching `tag` as the build identity when the running build reports NO SHA.
   *
   * ⛔ DEFAULT OFF, and it must stay an OWNER decision: this trades a commit-exact pin for the
   * build's own self-reported label. It does NOT delete the SHA axis — a build that DOES report a
   * SHA is still held to it, and a MISMATCHED tag still degrades. It only decides what happens
   * when the SHA is absent: degrade (default), or serve on the weaker identity (opt-in).
   * ⭐ Whichever is chosen, {@link VersionPinServing.identity} records which pin was satisfied.
   */
  readonly allowTagFallback?: boolean;
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
  | "gbrain_unavailable"
  /**
   * gbrain ANSWERED but reports no commit SHA, and the tag fallback is off.
   * ⭐ DISTINCT from `gbrain_unavailable` on purpose (worker `L79`): "never answered" and
   * "answered without a SHA" are different states with different operator actions — collapsing
   * them would tell an owner their brain is unreachable while it runs fine.
   */
  | "sha_unreported";

/** Pin matched + LIVE-validated: the read/index surface serves against the
 *  pinned build. `writeThroughEligible` is `pin.writeThroughEnabled` (the
 *  version gate is already satisfied on this branch). */
export interface VersionPinServing {
  readonly mode: "serving";
  readonly pinnedSha: string;
  readonly indexSchemaVersion: number;
  readonly writeThroughEligible: boolean;
  /**
   * WHICH identity actually satisfied the pin — `"sha"` (commit-exact) or `"tag"` (the weaker
   * self-reported label, only reachable via `allowTagFallback`).
   * ⭐ STRUCTURAL, not a comment: a consumer that requires a commit-exact pin can branch on this,
   * and a tag match can never be mistaken for a SHA match by a reader who skipped the docs.
   */
  readonly identity: "sha" | "tag";
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
  // The build is reachable and its index is fine; what is missing is the IDENTITY evidence, so
  // this belongs with the other pin failures, not with unreachability.
  sha_unreported: "write_through_failed",
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
  sha_unreported:
    "running gbrain reports no commit SHA, so the pinned SHA cannot be verified; degraded to " +
    "read-only/index-only (a tag-identity fallback exists and is off by default)",
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
  opts?: VersionPinOptions,
): Result<VersionPinServing, VersionPinDegraded> {
  if (running === undefined) {
    return degrade("gbrain_unavailable", ctx);
  }
  // IDENTITY, in strict order of strength. A reported SHA is ALWAYS authoritative — the fallback
  // can never rescue a build whose SHA is present and wrong.
  let identity: "sha" | "tag";
  if (running.sha !== undefined) {
    if (!shaMatches(pin.gbrainSha, running.sha)) return degrade("sha_mismatch", ctx);
    identity = "sha";
  } else if (opts?.allowTagFallback === true) {
    // STRICT equality on the tag: it is already a weak identity, and a prefix/loose compare would
    // make `0.3` accept `0.35.1.0`. An absent tag serves nothing.
    if (running.tag === undefined || running.tag !== pin.gbrainTag) return degrade("sha_mismatch", ctx);
    identity = "tag";
  } else {
    return degrade("sha_unreported", ctx);
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
    identity,
  });
}
