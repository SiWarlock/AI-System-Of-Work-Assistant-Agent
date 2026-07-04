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

// The measured §5.4 metric: how many raw Employer sentences actually surfaced
// through the gate. A DENY means the raw path never opened ⇒ 0 sentences leaked.
function leakedSentences(entry: LeakageCorpusEntry): number {
  const readerId = readerWorkspaceId(entry.targetWorkspace);
  const direct = denyDirectCrossWorkspaceRaw({ fromWorkspaceId: readerId, toWorkspaceId: EMP_ID });
  const projection = validateProjectionVisibility(rawEmployerProjection, employerWorkspace);
  // Raw content surfaces ONLY if BOTH the direct raw read AND the raw projection
  // were permitted. Either gate denying ⇒ 0 raw sentences cross.
  if (isDeny(direct) || isDeny(projection)) return 0;
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
      const d = validateProjectionVisibility(rawEmployerProjection, employerWorkspace);
      expect(isDeny(d), `${entry.id}: raw projection exceeds isolated default`).toBe(true);
      if (isDeny(d)) {
        expect(d.reason).toBe("VISIBILITY_EXCEEDS_SOURCE");
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
