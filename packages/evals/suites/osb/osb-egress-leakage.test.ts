// spec(§5 rule 5 · WS-8 rule 4 · §6 · §8) — task 13.1 gate (b): the OSB
// anti-corruption-layer egress-leakage eval.
//
// Loads the CHECKED-IN, hash-verified leakage corpus (task 12.3 — previously
// consumed only by the floor check in `test/corpora/corpora-floors.test.ts`) and
// drives each Employer-Work-sourced entry through THREE real, already-wired
// governance gates — never a fixture/fake gate:
//   • rule 4 (a): `denyDirectCrossWorkspaceRaw` — the direct cross-brain raw read.
//   • rule 4 (b): `validateProjectionVisibility` — a raw/full GCL projection.
//   • rule 5:     `vetoJobEgress` — the downstream synthesis job (§6/§13.8, what a
//     `registerSource()`-admitted OSB candidate actually feeds) is vetoed off the
//     cloud route while egress acknowledgment is OFF (no cloud fallback).
//
// NEGATIVE-CONTROL DISCIPLINE (§20.1 convention): each probe is a declared
// exfiltration/egress ATTEMPT; every assertion checks it is REJECTED with its
// PROTECTIVE reason (never merely "no sentence happened to appear").
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isOk, type GclProjection } from "@sow/contracts";
import { isAllow, isDeny, validateProjectionVisibility } from "@sow/policy";
import { loadCorpus, type CorpusManifest } from "../../src/harness/corpus-loader";
import { CORPUS_FLOORS, type LeakageCorpusEntry } from "../../src/harness/corpus-schemas";
import {
  osbCrossWorkspaceRawDecision,
  osbProjectionDecision,
  osbCloudEgressDecision,
  osbLeakedSentences,
  scoreOsbEgressLeakage,
  deniedProtectively,
  buildOsbSynthesisJob,
  OSB_SOURCE_WORKSPACE,
} from "../../src/osb/egress-leakage";

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

describe("task 13.1 gate (b) — OSB egress-leakage eval", () => {
  it("loads >=15 Employer-Work-sourced cases from the hash-verified corpus", () => {
    expect(LEAKAGE.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.leakage);
    for (const e of LEAKAGE) {
      expect(e.sourceWorkspace).toBe("employer-work");
    }
  });

  it.each(LEAKAGE.map((e) => [e.id, e] as const))(
    "%s — rule 4(a): the direct cross-brain raw read is DENIED",
    (_id, entry) => {
      const d = osbCrossWorkspaceRawDecision(entry);
      expect(isDeny(d), `${entry.id}: direct cross-brain raw read must be denied`).toBe(true);
      if (isDeny(d)) expect(d.reason).toBe("DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL");
    },
  );

  it.each(LEAKAGE.map((e) => [e.id, e] as const))(
    "%s — rule 4(b): a raw/full projection is refused (VISIBILITY_EXCEEDS_SOURCE)",
    (_id, entry) => {
      const d = osbProjectionDecision(entry);
      expect(isDeny(d), `${entry.id}: raw projection exceeds isolated default`).toBe(true);
      if (isDeny(d)) expect(d.reason).toBe("VISIBILITY_EXCEEDS_SOURCE");
    },
  );

  it.each(LEAKAGE.map((e) => [e.id, e] as const))(
    "%s — rule 5: the downstream synthesis job is vetoed off the cloud route (ack OFF, no fallback)",
    (_id, entry) => {
      const d = osbCloudEgressDecision(entry, false);
      expect(isDeny(d), `${entry.id}: unacknowledged employer-raw egress must be denied`).toBe(true);
      if (isDeny(d)) expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    },
  );

  it.each(LEAKAGE.map((e) => [e.id, e] as const))(
    "%s — 0 raw Employer sentences surface once all three gates are consulted",
    (_id, entry) => {
      expect(osbLeakedSentences(entry)).toBe(0);
    },
  );

  // ⚠ ALLOW-SIDE CONTROLS — without these, every deny assertion above is equally
  // satisfied by a brick wall that refuses everything (the #28 lesson pinned in
  // workspace-leakage.test.ts). Each leg gets its own, since a wall in ANY ONE of
  // the three gates would be invisible to the other two.
  it("rule 4(b) allow-side: an isolated-level projection is WITHIN the employer default", () => {
    const withinDefault: GclProjection = {
      workspaceId: OSB_SOURCE_WORKSPACE.id,
      visibilityLevel: "isolated",
      projectionType: "raw-context",
      sanitizedPayload: {},
      sourceRefs: [],
    };
    const d = validateProjectionVisibility(withinDefault, OSB_SOURCE_WORKSPACE);
    expect(isAllow(d)).toBe(true);
  });

  it("rule 5 allow-side: acknowledgment ON permits the cloud route (the deny above is a decision)", () => {
    const d = osbCloudEgressDecision(LEAKAGE[0]!, true);
    expect(isAllow(d)).toBe(true);
  });

  it("buildOsbSynthesisJob carries the entry's raw content and reaches the veto as such", () => {
    const job = buildOsbSynthesisJob(LEAKAGE[0]!);
    expect(job.carriesRawContent).toBe(true);
    expect(job.trustLevel).toBe("untrusted");
  });

  it("scoreOsbEgressLeakage: 0 total leaked sentences over the whole corpus", () => {
    const report = scoreOsbEgressLeakage(LEAKAGE);
    expect(report.cases).toBe(LEAKAGE.length);
    expect(report.totalLeakedSentences).toBe(0);
  });

  it("deniedProtectively distinguishes a protective deny from a malformed-input deny", () => {
    const protective = osbCrossWorkspaceRawDecision(LEAKAGE[0]!);
    expect(deniedProtectively(protective, "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL")).toBe(true);
    expect(deniedProtectively(protective, "SOME_OTHER_REASON")).toBe(false);
  });
});
