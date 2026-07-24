import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import { shouldShowOnboarding, shouldBackfillMarker, type FirstRunSignal } from "../../renderer/lib/first-run-gate";
import { isWorkspaceScope, type WorkspaceScope } from "../../renderer/store/scope";

// 9.17 (renderer leg) — the window-free, DI'd first-run gate decisions (LESSON 3). Consumes the durable
// marker signal (from the lifecycle:firstRunStatus preload channel) + the registry-derived
// `hasAnyOnboardedWorkspace` boolean → (a) a show-onboarding decision, (b) a backfill decision. The marker
// is an ADDITIVE authoritative signal, NOT a new hard lock (brief Q2): a CONCLUSIVE complete marker
// suppresses onboarding even under a transiently-empty registry (worker unreachable at boot — the bug this
// fixes); absent / faulted / pending ⇒ defer to the registry gate, so a real install is NEVER dropped into
// re-onboarding. BACKFILL (banked TWEAK): an existing/pre-feature install has NO marker, so the durable
// authority only kicks in after we write it once — when the registry shows onboarded but the marker is not
// (conclusively) complete, backfill it (idempotent). It gates ONLY the onboarding MOUNT — never the WS-8
// isolation predicate (safety rule 4 / LESSON 9).

const PRESENT: FirstRunSignal = ok(true); // marker conclusively says onboarding complete
const ABSENT: FirstRunSignal = ok(false); // marker conclusively absent (genuine first run)
const FAULT: FirstRunSignal = err("read_fault"); // inconclusive read fault
const PENDING: FirstRunSignal = undefined; // not yet read (async boot window)

describe("shouldShowOnboarding — authoritative durable first-run gate (marker + registry ⇒ mount decision)", () => {
  it("gate_shows_onboarding_only_when_marker_absent: decision table across marker × registry", () => {
    // spec(§11) — the authoritative gate + the additive-not-a-hard-lock fallback.
    // marker PRESENT ⇒ never show, even when the registry is transiently empty (the core fix).
    expect(shouldShowOnboarding(PRESENT, /* registryHasOnboarded */ false)).toBe(false);
    expect(shouldShowOnboarding(PRESENT, true)).toBe(false);
    // marker ABSENT + empty registry ⇒ genuine first run ⇒ show.
    expect(shouldShowOnboarding(ABSENT, false)).toBe(true);
    // marker ABSENT but the registry ALREADY holds an onboarded workspace ⇒ NOT a first run ⇒ don't show
    // (additive, never a hard lock: never re-onboard a real install).
    expect(shouldShowOnboarding(ABSENT, true)).toBe(false);
    // read-fault / pending ⇒ fall back to the registry-derived gate (`!hasAnyOnboardedWorkspace`).
    expect(shouldShowOnboarding(FAULT, false)).toBe(true);
    expect(shouldShowOnboarding(FAULT, true)).toBe(false);
    expect(shouldShowOnboarding(PENDING, false)).toBe(true);
    expect(shouldShowOnboarding(PENDING, true)).toBe(false);
  });

  it("gate_never_relaxes_ws8_isolation: no marker signal changes the isWorkspaceScope/isGlobal predicate", () => {
    // spec(safety rule 4 / LESSON 9) — the isolation single-source stays the registry-derived scope flag.
    // The gate's output varies with the marker, but isWorkspaceScope keys ONLY on the stable scope/isGlobal
    // and is provably independent of any first-run signal.
    const signals: FirstRunSignal[] = [PRESENT, ABSENT, FAULT, PENDING];
    const scopes: WorkspaceScope[] = ["global", "employer-work", "personal-business", "personal-life"];
    for (const scope of scopes) {
      const baseline = isWorkspaceScope(scope);
      // Global is the ONLY non-isolated scope; every bucket is workspace-scoped/isolated.
      expect(baseline).toBe(scope !== "global");
      // The predicate is constant regardless of the marker signal or the registry state.
      for (const signal of signals) {
        void shouldShowOnboarding(signal, true);
        void shouldShowOnboarding(signal, false);
        expect(isWorkspaceScope(scope)).toBe(baseline);
      }
    }
  });
});

describe("shouldBackfillMarker — set the durable marker for an existing install whose marker is absent", () => {
  it("backfills_only_when_registry_onboarded_and_marker_resolved_incomplete", () => {
    // spec(§11) — the banked TWEAK: an existing/pre-feature install has a populated registry but NO marker,
    // so the durable authority never engages until we write it once. Backfill IFF the registry shows onboarded
    // AND the marker read RESOLVED to not-complete (absent OR fault). NEVER on a complete marker (nothing to
    // do) and NEVER while the read is still PENDING (undefined — don't write before we know the state).
    expect(shouldBackfillMarker(ABSENT, /* registryHasOnboarded */ true)).toBe(true); // the target case
    expect(shouldBackfillMarker(FAULT, true)).toBe(true); // registry is authoritative evidence of onboarding
    expect(shouldBackfillMarker(PRESENT, true)).toBe(false); // already complete — no-op
    expect(shouldBackfillMarker(PENDING, true)).toBe(false); // read not resolved — don't write yet
    // no backfill when the registry is empty — nothing proves onboarding, and marker-absent+empty IS first-run.
    expect(shouldBackfillMarker(ABSENT, false)).toBe(false);
    expect(shouldBackfillMarker(FAULT, false)).toBe(false);
    expect(shouldBackfillMarker(PRESENT, false)).toBe(false);
    expect(shouldBackfillMarker(PENDING, false)).toBe(false);
  });
});
