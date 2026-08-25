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
import { existsSync, readFileSync } from "node:fs";
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

// spec(§12/§20.1) — hollow-coverage detector (task AC-1). `existsSync` alone
// answers "does the declared suite file exist", not "does anything in it
// actually run" — a file of pure `it.todo` stubs satisfies the former while
// certifying nothing. This counts EXECUTING it()/test() calls (including the
// `.each`/`.concurrent`/`.extend` modifier forms) and deliberately excludes
// the dormant `.todo`/`.skip`/`.fails` forms AND any mention of either inside
// a comment — `clean-install.test.ts:6` and `doctor-prereqs.test.ts:203` both
// say "it.todo" in prose, and a regex that doesn't strip comments first
// miscounts both as executing.
//
function executingTestCount(source: string): number {
  // Strip block comments then line comments FIRST — otherwise a comment that
  // echoes real call syntax (e.g. documenting `it("...")` in prose, exactly
  // like the two real files above) gets miscounted as an executing call.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // Bare `it(`/`test(` calls. The dormant forms `it.todo(`/`it.skip(`/`it.fails(`
  // never match this — the `.todo` etc. sits directly between `it` and `(`, so
  // `\s*\(` cannot bridge it. No explicit subtraction is needed.
  const calls = stripped.match(/\b(?:it|test)\s*\(/g) ?? [];
  // `.each`/`.concurrent`/`.extend` are executing modifier forms; `.todo`/
  // `.skip`/`.fails` are deliberately excluded from this alternation.
  const modifiers = stripped.match(/\b(?:it|test)\.(?:each|concurrent|extend)\b/g) ?? [];
  return calls.length + modifiers.length;
}

describe("executingTestCount — the hollow-coverage detector", () => {
  it("counts an executing it()", () => {
    expect(executingTestCount('it("x", () => {});')).toBe(1);
  });

  it("does not count it.todo / it.skip / test.todo (dormant forms)", () => {
    const source = ['it.todo("a");', 'it.skip("b", () => {});', 'test.todo("c");'].join("\n");
    expect(executingTestCount(source)).toBe(0);
  });

  it("does not count a mention inside a line comment", () => {
    // Mirrors the real regression (clean-install.test.ts:6, doctor-prereqs.test.ts:203
    // both mention `it.todo` in prose) AND adds a live `it("...")` call-shape so this
    // assertion is load-bearing against a naive (non-comment-stripping) implementation,
    // not just the dormant-token exclusion — a bare mention of `it.todo` never contains
    // an opening paren, so it can't discriminate the stripping step on its own.
    const source = '// tracked as `it.todo` so the row is visible; see it("example") in the sibling suite\n';
    expect(executingTestCount(source)).toBe(0);
  });

  it("does not count a mention inside a block comment", () => {
    const source = '/* tracked as it.todo; see it("example") for context */\n';
    expect(executingTestCount(source)).toBe(0);
  });

  it("counts it.each and a plain test() as executing", () => {
    expect(executingTestCount('it.each([1, 2])("case %i", (n) => {});')).toBeGreaterThanOrEqual(1);
    expect(executingTestCount('test("y", () => {});')).toBeGreaterThanOrEqual(1);
  });
});

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

  // ⚠ A well-FORMED path is not a REAL one. The assertion above tests `c.suite` with a filename
  // REGEX, so `suites/does-not-exist.test.ts` satisfies it completely — and 5 of the 24 declared
  // paths did not resolve to a file on disk, including the `MEETING_CLOSEOUT_REPLAY` spine that the
  // test below singles out as the real-integration DoD anchor.
  //
  // That is a FALSE coverage claim, not a missing one: the matrix asserted these criteria were
  // covered by named suites, the suites did not exist, and the meta-test that exists to catch
  // exactly this reported green. A missing suite is a known gap; a dangling pointer to a missing
  // suite is a gap that has been marked as closed.
  //
  // The regex cannot be strengthened into this — only the filesystem knows. Resolution of the
  // individual dangling entries is a scope decision (correct the pointer vs. write the suite, which
  // mean opposite things), but this tripwire is decision-independent: however each is resolved, a
  // pointer that stops resolving fails HERE rather than silently re-opening the claim.
  // ⛔ KNOWN-DANGLING BASELINE — these are FALSE COVERAGE CLAIMS that are recorded, not accepted.
  // Each names a criterion whose declared suite does not exist, so the criterion is currently
  // certified by nothing. Resolving them is a per-criterion scope decision (correct the pointer vs.
  // WRITE the missing suite — which mean opposite things: one makes the CLAIM honest, the other
  // makes the COVERAGE real), and three of them are safety-classed — KNOWLEDGE_WRITE (one-writer),
  // WORKSPACE_ROUTING (workspace isolation), TOOL_GATEWAY_IDEMPOTENCY (external-write envelope).
  // Silently re-pointing those at a convenient nearby suite would MANUFACTURE the appearance of
  // coverage, which is the defect itself. So they are listed here, in code, unmissable.
  //
  // ⚠ THIS LIST MAY ONLY EVER SHRINK. It is a ratchet, not an allowlist — see the length assertion
  // below. A baseline that can be appended to at zero cost is exactly the emptiable-label defect
  // (L74) this suite has been closing; the count pin is what stops this from becoming one.
  // ⛔ UNCOVERED: no suite exists for these. Per the #29 disposition, an absent suite is marked
  // UNCOVERED rather than re-pointed at a plausible neighbour — proximity is not coverage, and
  // manufacturing the appearance of it on a safety-classed criterion is the defect itself.
  // 6 → 4: HUMAN_SECTION_PRESERVATION and TOOL_GATEWAY_IDEMPOTENCY were re-pointed with PROOF
  // (named assertions verified to cover the criterion's actual claim, not merely to sit nearby).
  // Each entry below was resolved by a bounded READ of the candidate suite's actual assertions
  // against the criterion's actual claim (metric + threshold), not by counting keyword references —
  // "strong candidate" is the proximity trap in better clothes. Two criteria left this list that way
  // (HUMAN_SECTION_PRESERVATION, TOOL_GATEWAY_IDEMPOTENCY: matched at METRIC level, see the registry
  // comments). ⚠ Marking a criterion uncovered when a suite probably does cover it is ALSO a claim
  // outrunning its evidence — under-claiming is safer than over-claiming but it is not free.
  const KNOWN_DANGLING_SUITES: readonly string[] = [
    // ⛔ The three below share ONE never-written suite: suites/meeting-closeout/meeting-closeout-e2e.test.ts.
    // That directory contains only `no-inference-validator.test.ts`, which is not the spine.
    // ⚠ CONSTRAINED, NOT SKIPPED: the spine is `requiresRealIntegration: true` — it needs live infra
    // (real Temporal + a real vault + a real gbrain), so it cannot be satisfied by a unit suite. A
    // successor should read this as blocked on infrastructure, not deferred for convenience.
    "MEETING_CLOSEOUT_REPLAY", // the real-integration DoD spine
    "WORKSPACE_ROUTING", // rule 4 (workspace isolation)
    "KNOWLEDGE_WRITE", // rule 1 (one-writer)
  ];

  it("resolves every declared suite path to a file on disk (known-dangling set may only shrink)", () => {
    const dangling = EVAL_CRITERIA.filter((c) => !existsSync(resolve(PKG_ROOT, c.suite))).map((c) => c.id);
    const unexpected = dangling.filter((id) => !KNOWN_DANGLING_SUITES.includes(id));
    const detail = EVAL_CRITERIA.filter((c) => unexpected.includes(c.id))
      .map((c) => `${c.id} → ${c.suite}`)
      .join("\n");
    // A NEW dangling pointer fails here — the regression this tripwire exists for.
    expect(unexpected, `NEW dangling suite path(s) — the file does not exist:\n${detail}`).toEqual([]);
    // ⛔ THE RATCHET. Appending to the baseline to silence a failure raises this count and fails,
    // so widening the known-false set is a visible, reviewable act rather than a quiet one. When a
    // criterion is genuinely fixed, DELETE its entry and lower this number — never the reverse.
    // ⚠ THE CEILING COUNTS **CRITERIA**, NOT PATHS. The two differ — today it is 3 CRITERIA across
    // 1 path (`suites/meeting-closeout/meeting-closeout-e2e.test.ts`, still cited by all three of
    // MEETING_CLOSEOUT_REPLAY, WORKSPACE_ROUTING and KNOWLEDGE_WRITE). State the unit explicitly: a
    // ceiling ambiguous between the two invites a later "correction" in the wrong direction, and
    // because this number may only ever be LOWERED, a wrong unit bakes in permanently.
    expect(
      KNOWN_DANGLING_SUITES.length,
      "the known-dangling baseline may only shrink — this ceiling counts CRITERIA (not paths); fix a criterion, do not add one",
    ).toBeLessThanOrEqual(3);
    // Non-vacuity: a stale baseline naming criteria that now resolve is itself a false record.
    const staleBaseline = KNOWN_DANGLING_SUITES.filter((id) => !dangling.includes(id));
    expect(staleBaseline, `baseline lists criteria that now RESOLVE — delete them: ${staleBaseline.join(", ")}`).toEqual(
      [],
    );
  });

  // ⚠ A file that RESOLVES is not a suite that RUNS. The tripwire above only asks "does the declared
  // path exist" — `suites/clean-install/clean-install.test.ts` exists and is entirely `it.todo`, so it
  // satisfies that check completely while certifying nothing. That is the SAME false-coverage shape as
  // the dangling-pointer defect above, one layer deeper: the matrix reported OPEN_SOURCE_INSTALL
  // covered, and zero tests for it have ever executed.
  //
  // ⛔ KNOWN-HOLLOW BASELINE — same discipline as KNOWN_DANGLING_SUITES: a recorded, reviewable ratchet,
  // not an allowlist. THIS LIST MAY ONLY EVER SHRINK (see the length assertion below). A suite of
  // `it.todo` stubs is a coverage CLAIM with nothing behind it; adding a stub `it()` here to silence a
  // failure — rather than a real assertion, or an entry in this ratchet — is the exact defect this
  // tripwire exists to catch.
  const KNOWN_HOLLOW_SUITES: readonly string[] = [
    "OPEN_SOURCE_INSTALL", // suites/clean-install/clean-install.test.ts — 3 it.todo, 0 executing (Phase-11 / live-install gated)
  ];

  it("every declared .test.ts suite contains at least one EXECUTING test (hollow-coverage ratchet)", () => {
    // Restricted to `.test.ts` deliberately, and pinned so a later tightening can't silently break it:
    // PROVIDER_CONFORMANCE and RUNTIME_CONFORMANCE declare `src/conformance/*.ts` HARNESS MODULES (the
    // conformance runners themselves), not test files — `executingTestCount` has no meaning on them.
    for (const id of ["PROVIDER_CONFORMANCE", "RUNTIME_CONFORMANCE"]) {
      const c = criterionById(id);
      expect(c, `expected ${id} to exist in the registry`).toBeDefined();
      expect(
        c!.suite.endsWith(".test.ts"),
        `${id} suite "${c!.suite}" was expected to be a non-.test.ts harness module, excluded from the hollow check`,
      ).toBe(false);
    }

    const checkable = EVAL_CRITERIA.filter(
      (c) => c.suite.endsWith(".test.ts") && existsSync(resolve(PKG_ROOT, c.suite)),
    );
    // Non-vacuity: the .test.ts + exists filter must not have emptied the checked set.
    expect(checkable.length).toBeGreaterThan(0);

    const hollow = checkable
      .filter((c) => executingTestCount(readFileSync(resolve(PKG_ROOT, c.suite), "utf8")) < 1)
      .map((c) => c.id);
    const unexpectedHollow = hollow.filter((id) => !KNOWN_HOLLOW_SUITES.includes(id));
    const hollowDetail = EVAL_CRITERIA.filter((c) => unexpectedHollow.includes(c.id))
      .map((c) => `${c.id} → ${c.suite}`)
      .join("\n");
    // A NEW hollow suite fails here — the regression this tripwire exists for.
    expect(
      unexpectedHollow,
      `NEW hollow suite(s) — declared, resolves, but zero EXECUTING tests:\n${hollowDetail}`,
    ).toEqual([]);
    // ⛔ THE RATCHET, same shape as the dangling-pointer ceiling above: appending to silence a failure
    // raises this count and fails, so widening the known-hollow set is a visible, reviewable act.
    expect(
      KNOWN_HOLLOW_SUITES.length,
      "the known-hollow baseline may only shrink — fix the criterion's suite (add a real test), do not add one to this list",
    ).toBeLessThanOrEqual(1);
    // Non-vacuity: a stale baseline naming a criterion that now has executing tests is a false record.
    const staleHollowBaseline = KNOWN_HOLLOW_SUITES.filter((id) => !hollow.includes(id));
    expect(
      staleHollowBaseline,
      `hollow baseline lists criteria that now have executing tests — delete them: ${staleHollowBaseline.join(", ")}`,
    ).toEqual([]);
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
