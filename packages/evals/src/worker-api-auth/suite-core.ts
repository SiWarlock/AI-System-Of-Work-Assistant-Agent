// spec(§12) — shared suite-result core for the worker-API §12 conformance suites
// (Task 8.7). The three named suites (AUTH · UI-SAFE LEAKAGE · APPROVAL
// EXACTLY-ONCE) each drive the REAL worker API modules (the 8.1 auth interceptor,
// the 8.2 UI-safe projectors, the 8.5 push stream, the 8.4 command router) and
// fold their per-case verdicts into a `SuiteResult`. DETERMINISTIC + PURE over the
// injected system-under-test: no clock, no network, no randomness of its own.
//
// A suite is a §12 leakage/auth conformance gate: a SINGLE failing case fails the
// whole suite (`allPassed === false`) — these are DoD gates for phase-exit 8, not
// best-effort metrics. Each case records its own `passed` + a REDACTION-SAFE
// `detail` (a stable case id + failure reason — NEVER a token, secret, or raw
// content: §16 / safety rule 7). The suite runner NEVER throws (§16): a case that
// would have thrown is caught and folded into a `passed: false` outcome.

/** One assertion within a suite: a named case + its pass/fail + a safe detail. */
export interface SuiteCase {
  /** Stable, human-readable case id (e.g. "auth.command.no-token"). */
  readonly id: string;
  /** True IFF the case's security expectation held. */
  readonly passed: boolean;
  /**
   * Redaction-safe explanation on failure (a reason code / field name only —
   * NEVER a token, secret, prompt, or raw content). Omitted on pass.
   */
  readonly detail?: string;
}

/** The folded outcome of a named §12 suite. */
export interface SuiteResult {
  /** The suite's stable name (the §12 named-suite entry / `wiringFactory` id). */
  readonly suite: string;
  /** Every case the suite exercised, in run order. */
  readonly cases: readonly SuiteCase[];
  /** True IFF EVERY case passed (a single failure fails the DoD gate). */
  readonly allPassed: boolean;
  /** Count of cases exercised (the corpus floor is asserted per-suite). */
  readonly total: number;
  /** Count of cases that passed. */
  readonly passedCount: number;
}

/** A single case builder — records a pass. */
export function pass(id: string): SuiteCase {
  return { id, passed: true };
}

/** A single case builder — records a fail with a redaction-safe detail. */
export function fail(id: string, detail: string): SuiteCase {
  return { id, passed: false, detail };
}

/**
 * Record a boolean expectation as a case. `expectation` true ⇒ pass; false ⇒ a
 * fail carrying `detail`. Keeps every suite's per-case shape uniform.
 */
export function expectCase(id: string, expectation: boolean, detail: string): SuiteCase {
  return expectation ? pass(id) : fail(id, detail);
}

/**
 * Fold a case list into a `SuiteResult`. A single failing case ⇒ `allPassed:
 * false` — the §12 gate posture (no partial credit).
 */
export function foldSuite(suite: string, cases: readonly SuiteCase[]): SuiteResult {
  const passedCount = cases.filter((c) => c.passed).length;
  return {
    suite,
    cases,
    total: cases.length,
    passedCount,
    allPassed: cases.length > 0 && passedCount === cases.length,
  };
}
