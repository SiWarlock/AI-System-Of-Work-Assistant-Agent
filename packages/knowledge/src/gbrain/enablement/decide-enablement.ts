// Write-through enablement-refusal gate (Phase 11.3; §13 GBrain upgrade & write-through
// enablement · §12 parity/divergence · §6 write-through/one-writer · safety rule 1).
//
// `decideWriteThroughEnablement(inputs) → { enabled, refusals[] }` is the PURE, fail-closed
// AND that decides whether the per-workspace `writeThroughEnabled` flag MAY be flipped ON.
// `enabled` is `true` IFF EVERY setup leg is EXPLICITLY satisfied; any absent / unknown /
// false / malformed leg yields that leg's DISTINCT refusal and `enabled:false` — never
// enabled-by-omission. PURE: no I/O, no clock, never throws (§16) — a throw while reading a
// malformed leg value folds fail-closed to that leg's refusal.
//
// ── TWO-GATE DESIGN (deliberate; NOT duplication of `evaluateEnablementGate`) ──────────────
// This gate answers a DIFFERENT question at a DIFFERENT moment than the runtime gate in
// `write-through-flag.ts`:
//   • decideWriteThroughEnablement (HERE) = the ONE-TIME FLIP-PRECONDITION gate — "may the
//     operator promote `writeThroughEnabled` ON at all?". It adds the SETUP legs the runtime
//     gate omits — divergence-clean (a clean+complete `ParityReport` proves containment) and
//     full-reindex-complete — and is FAIL-CLOSED-ON-OMISSION (all inputs optional; a
//     partial / `{}` input refuses every missing leg).
//   • evaluateEnablementGate (`write-through-flag.ts`) = the RUNTIME CONTINUOUS auto-revert
//     gate — 9 all-required §12-GO condition legs re-checked every resolve inside
//     `resolveWriteThrough`; a regressed leg auto-reverts the live flag. It does NOT carry a
//     ParityReport leg (`resolveWriteThrough` checks containment separately, right after it).
// Both gates only AND upstream boolean RESULTS. For the SHARED legs (conformance-green,
// embedding-key-present, no-stray-writer) this gate consumes the SAME upstream signal as the
// runtime path — it does not re-derive the condition — so there is no logic to drift.
//
// The real leg PRODUCERS (run the §12 divergence suite against the actual pinned SHA, the
// read-token-rejects-write conformance run, the full-reindex completeness check, the Keychain
// embedding-key probe, the stray-gbrain-writer process probe — several overlap the
// install-doctor's bucket-B collectors) are DEFERRED (bucket B), as is the `writeThroughEnabled`
// flip itself (owner-gated HITL). This slice builds ONLY the deterministic composition.
//
// PURE decision logic: reuses the built pin leg `pinValidatedForEnablement`; imports no
// clock / network / fs.
import type { GbrainPin, ParityReport } from "@sow/contracts";
import { pinValidatedForEnablement } from "./write-through-flag";

/**
 * The closed set of setup legs the flip-precondition gate ANDs — one DISTINCT refusal per
 * leg, named for the blocking condition (failure-framed, matching `UnmetEnablementCondition`).
 */
export type EnablementRefusalLeg =
  | "pin_not_validated"
  | "divergence_not_clean"
  | "conformance_not_green"
  | "reindex_not_complete"
  | "embedding_key_absent"
  | "stray_writer_present";

/** A single blocking leg + a distinct human-readable reason (no catch-all). */
export interface EnablementRefusal {
  readonly leg: EnablementRefusalLeg;
  readonly reason: string;
}

/**
 * The injected per-leg outcomes. EVERY field is OPTIONAL — an absent leg is treated as
 * UNSATISFIED (fail-closed-on-omission), so a partial or `{}` input refuses every missing
 * leg. The caller resolves each leg against the ACTUAL pinned / installed gbrain (the real
 * producers are deferred, bucket B); this gate only composes their results.
 */
export interface WriteThroughEnablementInputs {
  /** Pin leg source — enablement-eligible IFF `pinValidatedForEnablement(pin)` (reuse). */
  readonly pin?: GbrainPin;
  /** Divergence leg — the latest revision-scoped `ParityReport` (clean AND complete). */
  readonly parityReport?: ParityReport;
  /** The read-token-rejects-write conformance run went green vs the pinned SHA. */
  readonly conformanceGreen?: boolean;
  /** The full re-index against the pinned build completed. */
  readonly reindexComplete?: boolean;
  /** Embedding key present (doctor embeddings/embedding_provider GREEN — never a noEmbed index). */
  readonly embeddingKeyPresent?: boolean;
  /** No stray gbrain writer / cron / autopilot bound to a canonical brain (§13). */
  readonly noStrayWriter?: boolean;
}

/** `enabled ⇔ refusals empty`. `refusals` is `[]` exactly when `enabled` is true. */
export interface WriteThroughEnablementDecision {
  readonly enabled: boolean;
  readonly refusals: readonly EnablementRefusal[];
}

/** Distinct reason per leg — the operator sees exactly what blocks the flip. */
const LEG_REASON: Readonly<Record<EnablementRefusalLeg, string>> = {
  pin_not_validated:
    "config/gbrain.pin is not validated for enablement (validatedOn is a PENDING sentinel, or the pin is absent)",
  divergence_not_clean:
    "the latest ParityReport does not prove containment (cleanForServing && coverageComplete), or is absent",
  conformance_not_green:
    "the read-token-rejects-write conformance run is not green against the pinned SHA",
  reindex_not_complete: "the full re-index against the pinned build has not completed",
  embedding_key_absent:
    "the embedding key is absent (doctor embeddings/embedding_provider not GREEN — a noEmbed-degraded index)",
  stray_writer_present: "a stray gbrain writer / cron / autopilot is bound to a canonical brain",
};

// Fixed evaluation order → deterministic `refusals` ordering. Each predicate returns TRUE
// only when the leg is EXPLICITLY satisfied; absent / unknown / false ⇒ the leg refuses.
// Booleans are matched with strict `=== true` so a non-boolean value reads as unsatisfied.
const LEG_CHECKS: ReadonlyArray<
  readonly [EnablementRefusalLeg, (i: WriteThroughEnablementInputs) => boolean]
> = [
  ["pin_not_validated", (i) => i.pin !== undefined && pinValidatedForEnablement(i.pin)],
  [
    "divergence_not_clean",
    (i) =>
      i.parityReport !== undefined &&
      i.parityReport.cleanForServing === true &&
      i.parityReport.coverageComplete === true,
  ],
  ["conformance_not_green", (i) => i.conformanceGreen === true],
  ["reindex_not_complete", (i) => i.reindexComplete === true],
  ["embedding_key_absent", (i) => i.embeddingKeyPresent === true],
  ["stray_writer_present", (i) => i.noStrayWriter === true],
];

/**
 * Evaluate one leg fail-closed: a throw while reading a malformed leg value (e.g. a pin whose
 * `validatedOn` is not a string) is folded to UNSATISFIED (`false`) so the gate never throws
 * across the boundary (§16) — mirrors the install-doctor's `safeCheck → probe_error`.
 */
function legSatisfied(
  predicate: (i: WriteThroughEnablementInputs) => boolean,
  inputs: WriteThroughEnablementInputs,
): boolean {
  try {
    return predicate(inputs) === true;
  } catch {
    return false;
  }
}

/**
 * The write-through FLIP-PRECONDITION gate. PURE fail-closed AND: `enabled` only when EVERY
 * setup leg is explicitly satisfied; each unsatisfied / absent / malformed leg yields its
 * distinct refusal. `enabled === (refusals.length === 0)`. Never throws (§16).
 */
export function decideWriteThroughEnablement(
  inputs: WriteThroughEnablementInputs,
): WriteThroughEnablementDecision {
  const refusals: EnablementRefusal[] = [];
  for (const [leg, predicate] of LEG_CHECKS) {
    if (!legSatisfied(predicate, inputs)) {
      refusals.push({ leg, reason: LEG_REASON[leg] });
    }
  }
  return { enabled: refusals.length === 0, refusals };
}
