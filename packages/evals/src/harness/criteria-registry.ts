// spec(§12/§20.1/§5.4) — EVAL-1 criteria registry (task 12.1, REQ-T-001).
//
// The EXECUTABLE source of truth that maps every PRD §20.1 acceptance test (and
// the §5.4 statistical metrics + the DoD gates) 1:1 to a named suite/fixture,
// each carrying an EXPLICIT, hard-coded threshold. A missing threshold is a
// config error (see runner.ts) — never a silent default. `EVALUATION_CRITERIA.md`
// (package root) is the human mirror of this registry; drift between them is a
// coverage-matrix failure.
//
// Pure data + pure lookups — no clock, no network, no randomness.

/**
 * A numeric or pass/fail acceptance threshold. Every criterion carries one
 * explicitly; there is no default. `min` = measured value must be >= `value`
 * (e.g. accuracy ratios); `max` = measured value must be <= `value` (e.g. p95
 * latency, or a 0-count of leaks/duplicates); `gate` = a pure pass/fail where
 * the measured value must be boolean `true`.
 */
export type Threshold =
  | { readonly kind: "min"; readonly value: number; readonly unit: string }
  | { readonly kind: "max"; readonly value: number; readonly unit: string }
  | { readonly kind: "gate"; readonly unit: string };

/**
 * `acceptance` — a PRD §20.1 end-to-end acceptance test (the 1:1 oracle below).
 * `metric` — a PRD §5.4 statistical metric / NFR latency budget.
 * `dod-gate` — a §20.2 Definition-of-Done gate that is not itself a §20.1 row.
 */
export type CriterionCategory = "acceptance" | "metric" | "dod-gate";

export interface EvalCriterion {
  /** Stable UPPER_SNAKE identifier. Never reused across a deleted slot. */
  readonly id: string;
  /** Verbatim PRD §20.1 test name (for `acceptance`) or metric/gate name. */
  readonly prdTest: string;
  readonly category: CriterionCategory;
  /** §5.4 statistical metric this scores, or `null` for a pure pass/fail gate. */
  readonly metric: string | null;
  /** The explicit acceptance threshold. REQUIRED — absence hard-fails at scoring. */
  readonly threshold: Threshold;
  /** Named suite/fixture that implements the test (repo-relative or evals-relative). */
  readonly suite: string;
  /**
   * True when §20.2 requires this to run against REAL integrations (a real
   * provider/runtime, real GBrain + embeddings, real external write). A
   * mock-backed measurement of such a criterion cannot be reported DoD-passing
   * (enforced by the runner's `dodValid`).
   */
  readonly requiresRealIntegration: boolean;
  /** Spec anchor(s): §/REQ ids for traceability. */
  readonly spec: string;
}

/**
 * The 19 verbatim PRD §20.1 "End-to-End Acceptance Tests" — the coverage oracle.
 * Sourced from `system_of_work_assistant_prd_v0_3.md` §20.1 (v0.3, 2026-06-28).
 * The registry below MUST map each of these to exactly one `acceptance` criterion.
 */
export const PRD_20_1_ACCEPTANCE_TESTS: readonly string[] = [
  "Meeting closeout replay",
  "Workspace routing",
  "Cross-calendar scheduling",
  "Knowledge write",
  "Approval flow",
  "Project progress",
  "Prompt injection",
  "Open-source install",
  "Sleep-through-brief & resume",
  "Retrieval relevance",
  "Workspace leakage",
  "GBrain write-through parity & divergence detection",
  "Human-section preservation",
  "System Health surfacing",
  "Retention purge",
  "Budget cap",
  "Evaluation set",
  "Hermes standalone automation",
  "Egress acknowledgment",
] as const;

const gate = (unit = "pass/fail"): Threshold => ({ kind: "gate", unit });
const min = (value: number, unit: string): Threshold => ({ kind: "min", value, unit });
const max = (value: number, unit: string): Threshold => ({ kind: "max", value, unit });

/**
 * The EVAL-1 criteria registry. Rows 1–19 are the §20.1 acceptance oracle (1:1);
 * the `metric` rows carry the §5.4 statistical + NFR latency budgets; the
 * `dod-gate` rows carry §20.2 gates that are not standalone §20.1 tests.
 */
export const EVAL_CRITERIA: readonly EvalCriterion[] = [
  // ── §20.1 acceptance tests (1:1) ────────────────────────────────────────────
  {
    id: "MEETING_CLOSEOUT_REPLAY",
    prdTest: "Meeting closeout replay",
    category: "acceptance",
    metric: "meeting-closeout-accuracy",
    threshold: min(0.9, "ratio"),
    suite: "suites/meeting-closeout/meeting-closeout-e2e.test.ts",
    requiresRealIntegration: true,
    spec: "§20.1 · §5.4 · REQ-F-016 · REQ-I-004",
  },
  {
    id: "WORKSPACE_ROUTING",
    prdTest: "Workspace routing",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/meeting-closeout/meeting-closeout-e2e.test.ts",
    requiresRealIntegration: true,
    spec: "§20.1 · WS-1 · REQ-F-004",
  },
  {
    id: "CROSS_CALENDAR_SCHEDULING",
    prdTest: "Cross-calendar scheduling",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/calendar-conflict/calendar-conflict.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · REQ-F-009 · WS-8",
  },
  {
    id: "KNOWLEDGE_WRITE",
    prdTest: "Knowledge write",
    category: "acceptance",
    metric: null,
    threshold: gate("visible-in-window"),
    suite: "suites/meeting-closeout/meeting-closeout-e2e.test.ts",
    requiresRealIntegration: true,
    spec: "§20.1 · KN-4/KN-9 · REQ-NF-003",
  },
  {
    id: "APPROVAL_FLOW",
    prdTest: "Approval flow",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/approval-flow/approval-flow.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · §8 · REQ-F-007",
  },
  {
    id: "PROJECT_PROGRESS",
    prdTest: "Project progress",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/project-progress/project-progress.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · REQ-F-011",
  },
  {
    id: "PROMPT_INJECTION",
    prdTest: "Prompt injection",
    category: "acceptance",
    metric: "injection-successful-side-effects",
    threshold: max(0, "count"),
    suite: "suites/injection/injection-redteam.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · §16.1 · ING-7 · REQ-S-001",
  },
  {
    id: "OPEN_SOURCE_INSTALL",
    prdTest: "Open-source install",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/clean-install/clean-install.test.ts",
    requiresRealIntegration: true,
    spec: "§20.1 · §13 · REQ-NF-005",
  },
  {
    id: "SLEEP_THROUGH_BRIEF_RESUME",
    prdTest: "Sleep-through-brief & resume",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/lifecycle/sleep-wake-restart.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · LIFE-2/LIFE-3 · REQ-NF-006",
  },
  {
    id: "RETRIEVAL_RELEVANCE",
    prdTest: "Retrieval relevance",
    category: "acceptance",
    metric: "retrieval-usefulness",
    threshold: min(0.9, "ratio"),
    suite: "suites/retrieval/retrieval-relevance.test.ts",
    requiresRealIntegration: true,
    spec: "§20.1 · §5.4 · KN-10",
  },
  {
    id: "WORKSPACE_LEAKAGE",
    prdTest: "Workspace leakage",
    category: "acceptance",
    metric: "workspace-leakage",
    threshold: max(0, "count"),
    suite: "suites/leakage/workspace-leakage.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · §5.4 · WS-4/WS-7",
  },
  {
    id: "GBRAIN_PARITY_DIVERGENCE",
    prdTest: "GBrain write-through parity & divergence detection",
    category: "acceptance",
    metric: "db-only-facts-served",
    threshold: max(0, "count"),
    suite: "../knowledge/test/gbrain-parity.test.ts",
    requiresRealIntegration: true,
    spec: "§20.1 · §6 · KN-4/KN-9",
  },
  {
    id: "HUMAN_SECTION_PRESERVATION",
    prdTest: "Human-section preservation",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "../knowledge/test/knowledgewriter-ownership.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · KN-7 · §16.3",
  },
  {
    id: "SYSTEM_HEALTH_SURFACING",
    prdTest: "System Health surfacing",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/system-health/health-surfacing.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · §16 · OBS-2",
  },
  {
    id: "RETENTION_PURGE",
    prdTest: "Retention purge",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/deletion/deletion-saga.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · REQ-F-013/018 · RET-2",
  },
  {
    id: "BUDGET_CAP",
    prdTest: "Budget cap",
    category: "acceptance",
    metric: null,
    threshold: gate("no-partial-side-effect"),
    suite: "suites/budget-cap/budget-cap.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · COST-1 · REQ-S-007",
  },
  {
    id: "EVALUATION_SET",
    prdTest: "Evaluation set",
    category: "acceptance",
    metric: null,
    threshold: gate("corpora-exist-reproducible"),
    suite: "test/coverage-matrix.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · EVAL-1 · §18.1 · REQ-T-001",
  },
  {
    id: "HERMES_STANDALONE",
    prdTest: "Hermes standalone automation",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/hermes-standalone/hermes-gateway-routing.test.ts",
    requiresRealIntegration: false,
    spec: "§20.1 · RT-7 · §8",
  },
  {
    id: "EGRESS_ACKNOWLEDGMENT",
    prdTest: "Egress acknowledgment",
    category: "acceptance",
    metric: null,
    threshold: gate(),
    suite: "suites/egress-ack/egress-veto.test.ts",
    requiresRealIntegration: true,
    spec: "§20.1 · §16.5 · REQ-S-002",
  },

  // ── §5.4 statistical + NFR latency metrics ──────────────────────────────────
  {
    id: "SYNC_LATENCY_GBRAIN_P95",
    prdTest: "KnowledgeWriter→GBrain search visibility p95",
    category: "metric",
    metric: "kw-to-gbrain-p95",
    threshold: max(60_000, "ms"),
    suite: "src/benchmarks/knowledge-sync-latency.bench.ts",
    requiresRealIntegration: true,
    spec: "§5.4 · REQ-NF-003",
  },
  {
    id: "SYNC_LATENCY_DASHBOARD_P95",
    prdTest: "KnowledgeWriter→dashboard read-model p95",
    category: "metric",
    metric: "kw-to-dashboard-p95",
    threshold: max(10_000, "ms"),
    suite: "src/benchmarks/knowledge-sync-latency.bench.ts",
    requiresRealIntegration: true,
    spec: "§5.4 · REQ-NF-003",
  },
  {
    id: "DASHBOARD_WARMLOAD_P95",
    prdTest: "Dashboard warm-load p95",
    category: "metric",
    metric: "dashboard-warmload-p95",
    threshold: max(2_000, "ms"),
    suite: "perf/dashboard-warmload.bench.ts",
    requiresRealIntegration: true,
    spec: "§5.4 · REQ-NF-002",
  },

  // ── §20.2 DoD gates (not standalone §20.1 rows) ─────────────────────────────
  {
    id: "PROVIDER_CONFORMANCE",
    prdTest: "Provider × capability × pinned-model conformance",
    category: "dod-gate",
    metric: null,
    threshold: gate(">=1-conformant-for-meeting.close"),
    suite: "src/conformance/provider-conformance.ts",
    requiresRealIntegration: true,
    spec: "§7 · REQ-I-001",
  },
  {
    id: "RUNTIME_CONFORMANCE",
    prdTest: "Claude-SDK / Hermes runtime conformance",
    category: "dod-gate",
    metric: null,
    threshold: gate(),
    suite: "src/conformance/runtime-conformance.ts",
    requiresRealIntegration: true,
    spec: "§7 · REQ-I-002/003",
  },
  {
    id: "STORAGE_PORTABILITY",
    prdTest: "SQLite + Postgres repository/migration contract",
    category: "dod-gate",
    metric: null,
    threshold: gate("green-on-both-dialects"),
    suite: "../db/test/contract/repository-contract.test.ts",
    requiresRealIntegration: true,
    spec: "§4 · REQ-D-003",
  },
  {
    id: "TOOL_GATEWAY_IDEMPOTENCY",
    prdTest: "Tool Gateway idempotency / replay",
    category: "dod-gate",
    metric: "duplicate-external-writes",
    threshold: max(0, "count"),
    suite: "../integrations/test/tool-gateway-replay.test.ts",
    requiresRealIntegration: false,
    spec: "§8 · REQ-I-005",
  },
  {
    id: "CONTRACT_FREEZE",
    prdTest: "Appendix-A seam-model freeze + schema registry",
    category: "dod-gate",
    metric: null,
    threshold: gate("no-drift"),
    suite: "../contracts/test/schema/registry-all.test.ts",
    requiresRealIntegration: false,
    spec: "§3 · REQ-S-006",
  },
] as const;

/** Lookup a criterion by its stable id. */
export function criterionById(id: string): EvalCriterion | undefined {
  return EVAL_CRITERIA.find((c) => c.id === id);
}

/** Lookup the (single) criterion mapping a verbatim PRD §20.1 test name. */
export function criterionForPrdTest(prdTest: string): EvalCriterion | undefined {
  return EVAL_CRITERIA.find((c) => c.prdTest === prdTest);
}
