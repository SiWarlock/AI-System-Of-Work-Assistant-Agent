// spec(§20.1 "Workspace leakage" · §5.4 · §6 · WS-4/WS-7/WS-8 · REQ-F-005/020) — task 12.17.
//
// The §20.1 acceptance suite for cross-workspace leakage (safety rule 4). It loads
// the CHECKED-IN, hash-verified leakage corpus (task 12.3) through the REAL
// `loadCorpus` and drives EACH Employer-Work-sourced probe through the REAL §5
// WS-8 Visibility Gate — `denyDirectCrossWorkspaceRaw` + `validateProjectionVisibility`
// from `@sow/policy` — asserting the corpus gold (`expectedLeakedSentences: 0`) HOLDS:
//   • the ONLY cross-workspace read path is a sanitized GclProjection; a DIRECT
//     cross-brain RAW query (the probe) is DENIED absent a recorded Level-3 link.
//   • a `full`/raw projection of Employer-Work content against an `isolated`
//     workspace default is refused (VISIBILITY_EXCEEDS_SOURCE) — no raw sentence
//     rides the projection.
//   • ⇒ 0 raw Employer-Work sentences surface in the Personal / Global output.
//
// NEGATIVE-CONTROL DISCIPLINE (§20.1): each probe is a declared cross-workspace
// exfiltration ATTEMPT; we assert it is REJECTED (a typed DENY), not merely that no
// leaked sentence "happened to appear."
//
// DoD honesty: WORKSPACE_LEAKAGE is a deterministic-enforcement criterion
// (requiresRealIntegration=false) — the WS-8 gate is the real code path here, so a
// seam run scores functionally-passing AND DoD-passing (no vendor needed). The
// runner enforces that below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { GclProjection, Workspace } from "@sow/contracts";
import { isOk } from "@sow/contracts";
import { denyDirectCrossWorkspaceRaw, validateProjectionVisibility, isAllow, isDeny } from "@sow/policy";
import type { PolicyDecision } from "@sow/policy";
import { loadCorpus, type CorpusManifest } from "../../src/harness/corpus-loader";
import { CORPUS_FLOORS, type LeakageCorpusEntry } from "../../src/harness/corpus-schemas";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

// ── load the REAL, hash-verified leakage corpus (task 12.3) ──────────────────
const CORPORA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "corpora");
function loadLeakageCorpus(): readonly LeakageCorpusEntry[] {
  const dir = resolve(CORPORA, "leakage");
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as CorpusManifest;
  const entries = JSON.parse(readFileSync(resolve(dir, "entries.json"), "utf8")) as LeakageCorpusEntry[];
  const r = loadCorpus<LeakageCorpusEntry>(manifest, entries, { expectedFloor: CORPUS_FLOORS.leakage });
  if (!isOk(r)) {
    throw new Error(`leakage corpus failed to load: ${JSON.stringify((r as { error: unknown }).error)}`);
  }
  return r.value.entries;
}
const LEAKAGE = loadLeakageCorpus();

// ── fixtures (pure literals) ─────────────────────────────────────────────────
const EMP_ID = "ws-emp-001";
// The Employer-Work source workspace: default visibility `isolated` (the tightest
// level — nothing crosses the boundary by default).
const employerWorkspace: Workspace = {
  id: EMP_ID as Workspace["id"],
  name: "Employer Work",
  type: "employer_work",
  dataOwner: "employer",
  markdownRepoPath: "/vault/employer",
  gbrainBrainId: "brain-employer" as Workspace["gbrainBrainId"],
  defaultVisibility: "isolated",
  egressPolicy: {
    workspaceId: EMP_ID as Workspace["egressPolicy"]["workspaceId"],
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: EMP_ID as Workspace["providerMatrix"]["workspaceId"],
    allowedProviders: ["claude"],
    capabilityDefaults: {},
    rawCloudEgressEnabled: false,
  },
};

// The reader workspace id for a probe: the corpus target maps to the scope the
// owner is asking FROM (`global` ⇒ a global-coordination scope, still ≠ employer).
function readerWorkspaceId(target: LeakageCorpusEntry["targetWorkspace"]): string {
  return target === "global" ? "ws-global-scope" : `ws-${target}`;
}

// A raw/full projection of the Employer-Work content — the leak an attacker wants
// to ride cross-workspace. `full` exceeds the `isolated` default ⇒ denied.
const rawEmployerProjection: GclProjection = {
  workspaceId: EMP_ID as GclProjection["workspaceId"],
  visibilityLevel: "full",
  projectionType: "raw-context",
  sanitizedPayload: {},
  sourceRefs: [],
};

/**
 * The per-ENTRY raw projection. ⚠ The corpus previously never entered the system: every `it.each`
 * row validated the same module-level `rawEmployerProjection` with an EMPTY payload, so ≥15 green
 * rows were one assertion run once and the corpus's actual employer content was decorative.
 *
 * Carrying `entry.rawEmployerContent` in the payload makes each row genuinely distinct AND puts the
 * real employer sentences through the gate — which is the leak the suite exists to bound. The deny
 * is driven by `visibilityLevel: "full"` exceeding the `isolated` default, so it is the VISIBILITY
 * decision being exercised, not the payload; the payload is what makes a regression observable.
 */
function projectionFor(entry: LeakageCorpusEntry): GclProjection {
  return {
    ...rawEmployerProjection,
    sanitizedPayload: { rawEmployerContent: entry.rawEmployerContent },
  };
}

// The PROTECTIVE denial reason for each gate — the one that actually evidences WS-8 holding.
// ⚠ Both functions can also deny with `MALFORMED_POLICY_INPUT`, which is NOT protection: it means
// the fixture never reached the visibility comparison at all. Scoring that as "0 leaked" measures
// "the fixture is malformed," not "the gate held" — and this metric feeds a SHIPPED DoD claim.
const DIRECT_PROTECTIVE_DENY = "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL";
const PROJECTION_PROTECTIVE_DENY = "VISIBILITY_EXCEEDS_SOURCE";

/**
 * A denial that evidences the gate DECIDING, not merely refusing (L80). Generic over the decision's
 * payload type: the two gates carry different `PolicyAllow<T>` payloads, and only the DENY side —
 * which is payload-independent — is inspected here.
 */
function deniedProtectively<T>(d: PolicyDecision<T>, expected: string): boolean {
  return isDeny(d) && d.reason === expected;
}

// The measured §5.4 metric: how many raw Employer sentences actually surfaced through the gate.
// A PROTECTIVE deny means the raw path never opened ⇒ 0 sentences leaked. A deny for any OTHER
// reason is NOT evidence and deliberately does not score 0 — it falls through to the sentence count
// so the suite goes RED rather than silently certifying a DoD pass off a broken fixture.
function leakedSentences(entry: LeakageCorpusEntry): number {
  const readerId = readerWorkspaceId(entry.targetWorkspace);
  const direct = denyDirectCrossWorkspaceRaw({ fromWorkspaceId: readerId, toWorkspaceId: EMP_ID });
  const projection = validateProjectionVisibility(projectionFor(entry), employerWorkspace);
  // Raw content surfaces ONLY if BOTH gates permitted. Either gate denying FOR ITS PROTECTIVE
  // REASON ⇒ 0 raw sentences cross. A malformed-input deny does NOT count as protection.
  if (
    deniedProtectively(direct, DIRECT_PROTECTIVE_DENY) ||
    deniedProtectively(projection, PROJECTION_PROTECTIVE_DENY)
  ) {
    return 0;
  }
  // (Unreachable under the real gate — kept honest so a regression would surface.)
  return entry.rawEmployerContent.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0).length;
}

describe("§20.1 Workspace leakage — the WS-8 gate yields 0 cross-workspace disclosure", () => {
  it("loads ≥15 Employer-Work-sourced cases from the hash-verified corpus", () => {
    expect(LEAKAGE.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.leakage);
    for (const e of LEAKAGE) {
      expect(e.sourceWorkspace).toBe("employer-work");
      expect(e.expectedLeakedSentences).toBe(0);
    }
  });

  it.each(LEAKAGE.map((e) => [e.id, e] as const))(
    "%s — the direct cross-brain raw query is DENIED (negative control)",
    (_id, entry) => {
      // NEGATIVE CONTROL: the probe is a declared cross-workspace RAW read; assert it
      // is HARD-DENIED, not merely that no sentence appeared.
      const readerId = readerWorkspaceId(entry.targetWorkspace);
      const direct = denyDirectCrossWorkspaceRaw({ fromWorkspaceId: readerId, toWorkspaceId: EMP_ID });
      expect(isDeny(direct), `${entry.id}: direct cross-brain raw read must be denied`).toBe(true);
      if (isDeny(direct)) {
        expect(direct.reason).toBe("DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL");
      }
    },
  );

  it.each(LEAKAGE.map((e) => [e.id, e] as const))(
    "%s — a raw/full projection of Employer content is refused (VISIBILITY_EXCEEDS_SOURCE)",
    (_id, entry) => {
      // Per-ENTRY projection: this row now carries THIS entry's employer content through the gate,
      // so the ≥15 rows are ≥15 distinct assertions rather than one repeated.
      const d = validateProjectionVisibility(projectionFor(entry), employerWorkspace);
      expect(isDeny(d), `${entry.id}: raw projection exceeds isolated default`).toBe(true);
      if (isDeny(d)) {
        // The REASON, not merely the refusal — a MALFORMED_POLICY_INPUT deny would mean this entry
        // never reached the visibility comparison, which is a broken fixture, not a held gate.
        expect(d.reason, `${entry.id}: denied, but not by the visibility decision`).toBe("VISIBILITY_EXCEEDS_SOURCE");
      }
    },
  );

  it.each(LEAKAGE.map((e) => [e.id, e] as const))(
    "%s — 0 raw Employer sentences surface (gold holds under the real gate)",
    (_id, entry) => {
      expect(leakedSentences(entry)).toBe(entry.expectedLeakedSentences);
      expect(leakedSentences(entry)).toBe(0);
    },
  );

  // ⚠ ALLOW-SIDE CONTROL for the PROJECTION leg. Without it every assertion above is satisfied by a
  // gate that refuses EVERYTHING, so nothing distinguishes "the gate works" from "the gate is a
  // brick wall." Proven by simulation (#28): replacing `validateProjectionVisibility` with a constant
  // DENY left all 610 tests in `packages/evals` GREEN — a gate that decides nothing passed a suite
  // whose entire purpose is to certify that it decides correctly.
  //
  // The sibling leg below already had this (its comment even names the reason — "pins that the DENY
  // above is a policy decision, not an unconditional throw"). One leg was protected and one was not,
  // in the same file, for the same class of gate. That asymmetry is the actual defect.
  it("a projection WITHIN the workspace default is ALLOWED (the deny above is a decision, not a wall)", () => {
    // `isolated` is the tightest level and the employer default, so this projection does NOT exceed
    // its source and MUST pass. Identical to `rawEmployerProjection` except the visibility level —
    // the one field the gate is supposed to be deciding on.
    const withinDefault: GclProjection = { ...rawEmployerProjection, visibilityLevel: "isolated" };
    const d = validateProjectionVisibility(withinDefault, employerWorkspace);
    expect(isAllow(d), "an isolated-level projection is within an isolated default").toBe(true);
  });

  it("a recorded Level-3 owner-approved link is the SOLE exception (not auto-created)", () => {
    // The gate is not an absolute wall — it permits the ONE sanctioned path. This
    // pins that the DENY above is a policy decision, not an unconditional throw.
    const withLink = denyDirectCrossWorkspaceRaw({
      fromWorkspaceId: "ws-personal-business",
      toWorkspaceId: EMP_ID,
      approvedLink: { level3: true, recordedApprovalRef: "approval:owner:link-001" },
    });
    expect(isAllow(withLink)).toBe(true);
  });
});

describe("injection-leakage — EVAL-1 runner scoring (WORKSPACE_LEAKAGE)", () => {
  it("scores 0 leaked sentences functionally- AND DoD-passing", () => {
    // Derive the §5.4 metric from the REAL WS-8 gate across the whole corpus.
    const totalLeaked = LEAKAGE.reduce((n, e) => n + leakedSentences(e), 0);
    expect(totalLeaked).toBe(0);

    const out = scoreById({
      criterionId: "WORKSPACE_LEAKAGE",
      value: totalLeaked,
      fromRealIntegration: false,
    });
    // max(0) threshold: 0 leaked sentences passes.
    expect(out.functionalPass).toBe(true);
    // Deterministic WS-8 enforcement is the real code path — no vendor required,
    // so a seam run is DoD-valid AND DoD-passing.
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
  });

  it("registry marks workspace-leakage deterministic (no real integration required)", () => {
    expect(criterionById("WORKSPACE_LEAKAGE")?.requiresRealIntegration).toBe(false);
  });
});
