// spec(§12/§20.1) — EVAL-1 coverage meta-test (task 12.1, REQ-T-001).
//
// This is the LINCHPIN meta-test: it proves EVALUATION_CRITERIA maps the PRD
// §20.1 acceptance tests 1:1 to a named suite/fixture, that every criterion
// carries an explicit hard-coded threshold (a MISSING threshold hard-fails —
// never silently defaults), and that the runner enforces DoD honesty (a
// real-integration-required criterion scored from a mock cannot be reported
// DoD-passing).
//
// It is deterministic and pure (no clock/network/randomness) — the harness
// itself is test-first code.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isOk, isErr } from "@sow/contracts";
import {
  EVAL_CRITERIA,
  PRD_20_1_ACCEPTANCE_TESTS,
  criterionById,
  criterionForPrdTest,
  type EvalCriterion,
} from "../src/harness/criteria-registry";
import {
  scoreMeasurement,
  scoreById,
  evaluateThreshold,
  EvalConfigError,
} from "../src/harness/runner";
import { corpusContentHash, loadCorpus, type CorpusManifest } from "../src/harness/corpus-loader";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");

const acceptance = (): readonly EvalCriterion[] =>
  EVAL_CRITERIA.filter((c) => c.category === "acceptance");

describe("§20.1 coverage oracle", () => {
  it("names exactly 19 unique PRD §20.1 acceptance tests", () => {
    expect(PRD_20_1_ACCEPTANCE_TESTS).toHaveLength(19);
    expect(new Set(PRD_20_1_ACCEPTANCE_TESTS).size).toBe(19);
  });

  it("maps every §20.1 acceptance test to exactly one criterion (1:1)", () => {
    for (const name of PRD_20_1_ACCEPTANCE_TESTS) {
      const matches = acceptance().filter((c) => c.prdTest === name);
      expect(matches, `§20.1 test "${name}" must map to exactly one criterion`).toHaveLength(1);
    }
  });

  it("has no acceptance criterion pointing outside the §20.1 oracle", () => {
    const oracle = new Set(PRD_20_1_ACCEPTANCE_TESTS);
    for (const c of acceptance()) {
      expect(oracle.has(c.prdTest), `criterion ${c.id} references unknown §20.1 test "${c.prdTest}"`).toBe(
        true,
      );
    }
  });

  it("criterionForPrdTest resolves each §20.1 name", () => {
    for (const name of PRD_20_1_ACCEPTANCE_TESTS) {
      expect(criterionForPrdTest(name)?.prdTest).toBe(name);
    }
  });
});

describe("registry integrity", () => {
  it("has unique criterion ids", () => {
    const ids = EVAL_CRITERIA.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every criterion an explicit threshold (no silent default)", () => {
    for (const c of EVAL_CRITERIA) {
      expect(c.threshold, `criterion ${c.id} lacks a threshold`).toBeDefined();
      expect(["min", "max", "gate"]).toContain(c.threshold.kind);
    }
  });

  it("gives every criterion a well-formed suite path + real-integration flag", () => {
    for (const c of EVAL_CRITERIA) {
      expect(c.suite.length, `criterion ${c.id} has empty suite path`).toBeGreaterThan(0);
      expect(/\.(test|bench)\.ts$|\.(ts)$/.test(c.suite), `criterion ${c.id} suite path "${c.suite}"`).toBe(
        true,
      );
      expect(typeof c.requiresRealIntegration).toBe("boolean");
      expect(c.spec.length).toBeGreaterThan(0);
    }
  });

  it("flags at least one real-integration-required DoD criterion", () => {
    // §20.2: the DoD cannot be satisfied by mocks — some criteria MUST be real.
    expect(EVAL_CRITERIA.some((c) => c.requiresRealIntegration)).toBe(true);
  });

  it("flags the meeting-closeout spine as real-integration-required", () => {
    expect(criterionById("MEETING_CLOSEOUT_REPLAY")?.requiresRealIntegration).toBe(true);
  });

  it("ships the canonical EVALUATION_CRITERIA.md at the package root", () => {
    expect(existsSync(resolve(PKG_ROOT, "EVALUATION_CRITERIA.md"))).toBe(true);
  });
});

describe("runner — threshold evaluation", () => {
  it("min threshold passes at/above the floor, fails below", () => {
    const t = { kind: "min", value: 0.9, unit: "ratio" } as const;
    expect(evaluateThreshold(t, 0.95).pass).toBe(true);
    expect(evaluateThreshold(t, 0.9).pass).toBe(true);
    expect(evaluateThreshold(t, 0.89).pass).toBe(false);
  });

  it("max threshold passes at/below the ceiling, fails above", () => {
    const t = { kind: "max", value: 0, unit: "count" } as const;
    expect(evaluateThreshold(t, 0).pass).toBe(true);
    expect(evaluateThreshold(t, 1).pass).toBe(false);
  });

  it("gate threshold passes only on boolean true", () => {
    const t = { kind: "gate", unit: "pass/fail" } as const;
    expect(evaluateThreshold(t, true).pass).toBe(true);
    expect(evaluateThreshold(t, false).pass).toBe(false);
  });

  it("fails (does not throw) on a value/threshold type mismatch", () => {
    const min = { kind: "min", value: 0.9, unit: "ratio" } as const;
    expect(evaluateThreshold(min, true).pass).toBe(false);
    const gate = { kind: "gate", unit: "pass/fail" } as const;
    expect(evaluateThreshold(gate, 1).pass).toBe(false);
  });
});

describe("runner — DoD honesty", () => {
  const realCrit = () => criterionById("MEETING_CLOSEOUT_REPLAY")!;

  it("marks a real-integration criterion scored from a mock as NOT DoD-passing", () => {
    const out = scoreMeasurement(realCrit(), {
      criterionId: "MEETING_CLOSEOUT_REPLAY",
      value: 0.99,
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(false);
    expect(out.dodPass).toBe(false);
  });

  it("marks the same criterion DoD-passing when scored from a real integration", () => {
    const out = scoreMeasurement(realCrit(), {
      criterionId: "MEETING_CLOSEOUT_REPLAY",
      value: 0.99,
      fromRealIntegration: true,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
  });

  it("treats a non-real criterion as DoD-valid regardless of integration source", () => {
    const c = criterionById("PROJECT_PROGRESS")!;
    expect(c.requiresRealIntegration).toBe(false);
    const out = scoreMeasurement(c, {
      criterionId: "PROJECT_PROGRESS",
      value: true,
      fromRealIntegration: false,
    });
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
  });

  it("scoreById resolves the criterion from the registry", () => {
    const out = scoreById({ criterionId: "PROJECT_PROGRESS", value: true, fromRealIntegration: false });
    expect(out.prdTest).toBe("Project progress");
    expect(out.dodPass).toBe(true);
  });
});

describe("runner — hard fail on config error", () => {
  it("throws EvalConfigError when a criterion has no threshold", () => {
    const broken = { ...criterionById("PROJECT_PROGRESS")!, threshold: undefined } as unknown as EvalCriterion;
    expect(() =>
      scoreMeasurement(broken, { criterionId: "PROJECT_PROGRESS", value: true, fromRealIntegration: true }),
    ).toThrow(EvalConfigError);
  });

  it("throws EvalConfigError when scoreById gets an unknown criterion", () => {
    expect(() =>
      scoreById({ criterionId: "NOT_A_REAL_CRITERION", value: true, fromRealIntegration: true }),
    ).toThrow(EvalConfigError);
  });
});

describe("corpus loader — versioned + content-hash + floor", () => {
  const entries = [{ id: "a", gold: 1 }, { id: "b", gold: 2 }];
  const good = (): CorpusManifest => ({
    corpusId: "unit-corpus",
    version: "1.0.0",
    contentHash: corpusContentHash("unit-corpus", "1.0.0", entries),
    entryCount: entries.length,
    floor: 2,
  });

  it("loads a well-formed versioned corpus", () => {
    const r = loadCorpus(good(), entries);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.entries).toHaveLength(2);
  });

  it("rejects an unversioned corpus", () => {
    const r = loadCorpus({ ...good(), version: "  " }, entries);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("unversioned");
  });

  it("rejects a content-hash mismatch", () => {
    const r = loadCorpus({ ...good(), contentHash: "sha256:deadbeef" }, entries);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("hash_mismatch");
  });

  it("rejects an entry-count mismatch", () => {
    const r = loadCorpus({ ...good(), entryCount: 5 }, entries);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("count_mismatch");
  });

  it("rejects a corpus below its declared floor", () => {
    const r = loadCorpus({ ...good(), floor: 10 }, entries);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("below_floor");
  });

  it("rejects a corpus below an expectedFloor override", () => {
    const r = loadCorpus(good(), entries, { expectedFloor: 20 });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("below_floor");
  });

  it("computes an object-key-order-independent content hash", () => {
    const a = corpusContentHash("c", "1", [{ x: 1, y: 2 }]);
    const b = corpusContentHash("c", "1", [{ y: 2, x: 1 }]);
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("changes the content hash when an entry value changes", () => {
    const a = corpusContentHash("c", "1", [{ x: 1 }]);
    const b = corpusContentHash("c", "1", [{ x: 2 }]);
    expect(a).not.toBe(b);
  });
});
