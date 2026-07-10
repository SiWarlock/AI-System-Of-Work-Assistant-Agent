// spec(§13/§12/§6) — write-through enablement-refusal gate (Phase 11.3). The pure,
// fail-closed AND that decides whether `writeThroughEnabled` MAY be flipped ON for a
// workspace: `decideWriteThroughEnablement(inputs) → {enabled, refusals[]}`. `enabled`
// only when EVERY setup leg is EXPLICITLY satisfied; any absent/unknown/false/malformed
// leg yields that leg's DISTINCT refusal + `enabled:false` (never enabled-by-omission).
// Reuses the built pin leg (`pinValidatedForEnablement`); never throws (§16). This is the
// one-time FLIP-PRECONDITION gate — distinct from `evaluateEnablementGate` (runtime
// auto-revert). Real leg PRODUCERS + the flip itself are deferred (bucket B / HITL).
import { describe, it, expect } from "vitest";
import type { GbrainPin, ParityReport, WorkspaceId, RevisionId } from "@sow/contracts";
import { GbrainPinSchema, ParityReportSchema } from "@sow/contracts";
import { pinValidatedForEnablement } from "../src/gbrain/enablement/write-through-flag";
import {
  decideWriteThroughEnablement,
  type WriteThroughEnablementInputs,
  type EnablementRefusalLeg,
} from "../src/gbrain/enablement/decide-enablement";

const SHA40 = "3933eb6a3933eb6a3933eb6a3933eb6a3933eb6a";
const WS = "ws-employer" as WorkspaceId;
const REV = "rev-current" as RevisionId;

/** A pin whose `validatedOn` is a real date ⇒ enablement-eligible (`pinValidatedForEnablement` true). */
function validatedPin(overrides: Partial<GbrainPin> = {}): GbrainPin {
  return GbrainPinSchema.parse({
    gbrainSha: SHA40,
    gbrainTag: "0.35.1.0",
    gbrainRepo: "https://github.com/example/gbrain",
    indexSchemaVersion: 2,
    validatedOn: "2026-06-30",
    validationRef: "docs/design/gbrain-write-through-divergence.md",
    writeThroughEnabled: false,
    ...overrides,
  });
}

/** A pin still owing LIVE validation (PENDING sentinel) ⇒ NOT enablement-eligible. */
function pendingPin(): GbrainPin {
  return validatedPin({ validatedOn: "PENDING_LIVE_VALIDATION" });
}

/** A ParityReport for WS@REV; clean+complete by default (containment proven). */
function report(overrides: Partial<ParityReport> = {}): ParityReport {
  const draft = {
    reportId: "report-1",
    workspaceId: WS as string,
    reconciledAtRevision: REV as string,
    gbrainSchemaVersion: 2,
    canonicalFactCount: 3,
    dbFactCount: 3,
    divergences: [],
    cleanForServing: true,
    coverageComplete: true,
  };
  return { ...ParityReportSchema.parse(draft), ...overrides };
}

/** All six setup legs explicitly satisfied. */
function greenInputs(overrides: Partial<WriteThroughEnablementInputs> = {}): WriteThroughEnablementInputs {
  return {
    pin: validatedPin(),
    parityReport: report(),
    conformanceGreen: true,
    reindexComplete: true,
    embeddingKeyPresent: true,
    noStrayWriter: true,
    ...overrides,
  };
}

// One row per leg: how to make it fail (both a false VALUE and, separately, key OMISSION),
// plus the distinct refusal leg id it must produce.
const LEG_ROWS: ReadonlyArray<{
  readonly key: keyof WriteThroughEnablementInputs;
  readonly failValue: WriteThroughEnablementInputs[keyof WriteThroughEnablementInputs];
  readonly expected: EnablementRefusalLeg;
}> = [
  { key: "pin", failValue: pendingPin(), expected: "pin_not_validated" },
  { key: "parityReport", failValue: report({ cleanForServing: false }), expected: "divergence_not_clean" },
  { key: "conformanceGreen", failValue: false, expected: "conformance_not_green" },
  { key: "reindexComplete", failValue: false, expected: "reindex_not_complete" },
  { key: "embeddingKeyPresent", failValue: false, expected: "embedding_key_absent" },
  { key: "noStrayWriter", failValue: false, expected: "stray_writer_present" },
];

const ALL_LEGS: readonly EnablementRefusalLeg[] = LEG_ROWS.map((r) => r.expected);

/** The four boolean legs (the ParityReport/pin legs are covered separately). */
const BOOLEAN_LEG_ROWS: ReadonlyArray<{
  readonly key: keyof WriteThroughEnablementInputs;
  readonly expected: EnablementRefusalLeg;
}> = [
  { key: "conformanceGreen", expected: "conformance_not_green" },
  { key: "reindexComplete", expected: "reindex_not_complete" },
  { key: "embeddingKeyPresent", expected: "embedding_key_absent" },
  { key: "noStrayWriter", expected: "stray_writer_present" },
];

/** Truthy-but-NOT-`true` values a strict `=== true` gate must still treat as unsatisfied. */
const TRUTHY_NOT_TRUE: readonly unknown[] = [1, "true", "yes", {}, [], "false"];

describe("decideWriteThroughEnablement (write-through FLIP-precondition gate)", () => {
  // ── 1. all_legs_green_enables ──────────────────────────────────────────────
  it("every leg present + satisfied ⇒ enabled:true with empty refusals", () => {
    const d = decideWriteThroughEnablement(greenInputs());
    expect(d.enabled).toBe(true);
    expect(d.refusals).toEqual([]);
  });

  // ── 2. each_failing_leg_has_distinct_refusal ───────────────────────────────
  it.each(LEG_ROWS)(
    "a single failing leg ($expected) ⇒ enabled:false + exactly that leg's refusal (others pass)",
    ({ key, failValue, expected }) => {
      const d = decideWriteThroughEnablement(greenInputs({ [key]: failValue }));
      expect(d.enabled).toBe(false);
      expect(d.refusals.map((r) => r.leg)).toEqual([expected]);
      expect(d.refusals.every((r) => r.reason.length > 0)).toBe(true);
    },
  );

  it("a fully-failing input ⇒ a refusal per leg, all pairwise-distinct (no catch-all)", () => {
    const allFail: WriteThroughEnablementInputs = {
      pin: pendingPin(),
      parityReport: report({ cleanForServing: false, coverageComplete: false }),
      conformanceGreen: false,
      reindexComplete: false,
      embeddingKeyPresent: false,
      noStrayWriter: false,
    };
    const d = decideWriteThroughEnablement(allFail);
    expect(d.enabled).toBe(false);
    const legs = d.refusals.map((r) => r.leg);
    const reasons = d.refusals.map((r) => r.reason);
    expect(legs.length).toBe(ALL_LEGS.length);
    expect(new Set(legs).size).toBe(legs.length); // legs pairwise-distinct
    expect(new Set(reasons).size).toBe(reasons.length); // reasons pairwise-distinct
    // Exact, UNSORTED order — pins the deterministic evaluation order (refusals are a contract).
    expect(legs).toEqual([...ALL_LEGS]);
  });

  // A truthy-but-not-`true` leg value must NOT satisfy a boolean leg (guards the strict
  // `=== true` checks against a future `!!x` / truthy-coercion regression — the safety
  // invariant's tightest edge).
  it.each(BOOLEAN_LEG_ROWS)(
    "a truthy-but-not-true value for $key does NOT satisfy the leg ($expected) — strict === true",
    ({ key, expected }) => {
      for (const truthy of TRUTHY_NOT_TRUE) {
        const d = decideWriteThroughEnablement(greenInputs({ [key]: truthy as unknown as boolean }));
        expect(d.enabled).toBe(false);
        expect(d.refusals.map((r) => r.leg)).toEqual([expected]);
      }
    },
  );

  it("a ParityReport with truthy-but-not-true clean/coverage flags does NOT satisfy the divergence leg", () => {
    for (const truthy of TRUTHY_NOT_TRUE) {
      const truthyReport = {
        ...report(),
        cleanForServing: truthy as unknown as boolean,
        coverageComplete: truthy as unknown as boolean,
      };
      const d = decideWriteThroughEnablement(greenInputs({ parityReport: truthyReport }));
      expect(d.enabled).toBe(false);
      expect(d.refusals.map((r) => r.leg)).toEqual(["divergence_not_clean"]);
    }
  });

  it("a dirty-but-covered ParityReport and a clean-but-incomplete one both refuse the divergence leg", () => {
    const dirty = decideWriteThroughEnablement(greenInputs({ parityReport: report({ cleanForServing: false }) }));
    const incomplete = decideWriteThroughEnablement(greenInputs({ parityReport: report({ coverageComplete: false }) }));
    expect(dirty.refusals.map((r) => r.leg)).toEqual(["divergence_not_clean"]);
    expect(incomplete.refusals.map((r) => r.leg)).toEqual(["divergence_not_clean"]);
  });

  // ── 3. absent_leg_fails_closed (never enabled-by-omission) ──────────────────
  it.each(LEG_ROWS)("an OMITTED leg ($expected key) ⇒ that leg is refused, never enabled-by-omission", ({ key, expected }) => {
    const partial: WriteThroughEnablementInputs = { ...greenInputs() };
    delete partial[key];
    const d = decideWriteThroughEnablement(partial);
    expect(d.enabled).toBe(false);
    expect(d.refusals.map((r) => r.leg)).toEqual([expected]);
  });

  // ── 4. empty_input_refuses_every_leg ───────────────────────────────────────
  it("decideWriteThroughEnablement({}) ⇒ enabled:false with a refusal for every required leg", () => {
    const d = decideWriteThroughEnablement({});
    expect(d.enabled).toBe(false);
    expect([...d.refusals.map((r) => r.leg)].sort()).toEqual([...ALL_LEGS].sort());
  });

  // ── 5. pin_leg_reuses_built_predicate ──────────────────────────────────────
  it("a PENDING-sentinel pin refuses the pin leg VIA the built pinValidatedForEnablement (reuse, not re-impl)", () => {
    const pin = pendingPin();
    // Couple the assertion to the reused predicate: the gate refuses iff the built leg does.
    expect(pinValidatedForEnablement(pin)).toBe(false);
    const d = decideWriteThroughEnablement(greenInputs({ pin }));
    expect(d.enabled).toBe(false);
    expect(d.refusals.map((r) => r.leg)).toEqual(["pin_not_validated"]);

    // And the inverse: a validated pin passes the pin leg.
    const validated = validatedPin();
    expect(pinValidatedForEnablement(validated)).toBe(true);
    expect(decideWriteThroughEnablement(greenInputs({ pin: validated })).enabled).toBe(true);
  });

  // ── 6. pure_and_never_throws ───────────────────────────────────────────────
  it("is pure: two calls on the same input are deep-equal and the input is not mutated", () => {
    const input = greenInputs({ conformanceGreen: false });
    const before = JSON.parse(JSON.stringify(input));
    const a = decideWriteThroughEnablement(input);
    const b = decideWriteThroughEnablement(input);
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(input))).toEqual(before); // input unmutated
  });

  it("never throws on a malformed leg value — folds fail-closed to a decision (§16)", () => {
    // A pin whose `validatedOn` is a number: the built predicate's string ops would throw;
    // the gate must catch it and refuse the pin leg, never propagate the throw.
    const malformedPin = { ...validatedPin(), validatedOn: 12345 } as unknown as GbrainPin;
    const malformed: WriteThroughEnablementInputs = greenInputs({
      pin: malformedPin,
      // A non-boolean conformance value must also read as unsatisfied (strict === true).
      conformanceGreen: "yes" as unknown as boolean,
    });
    let d!: ReturnType<typeof decideWriteThroughEnablement>;
    expect(() => {
      d = decideWriteThroughEnablement(malformed);
    }).not.toThrow();
    expect(d.enabled).toBe(false);
    const legs = d.refusals.map((r) => r.leg);
    expect(legs).toContain("pin_not_validated");
    expect(legs).toContain("conformance_not_green");
  });

  it("never throws on a null/garbage input object — folds every leg fail-closed", () => {
    expect(() => decideWriteThroughEnablement(null as unknown as WriteThroughEnablementInputs)).not.toThrow();
    const d = decideWriteThroughEnablement(null as unknown as WriteThroughEnablementInputs);
    expect(d.enabled).toBe(false);
    expect(d.refusals.length).toBe(ALL_LEGS.length);
  });
});
