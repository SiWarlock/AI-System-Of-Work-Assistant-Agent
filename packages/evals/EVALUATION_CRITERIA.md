# EVALUATION_CRITERIA — EVAL-1 acceptance matrix

> **Canonical, executable source of truth: [`src/harness/criteria-registry.ts`](./src/harness/criteria-registry.ts).**
> This document is the human mirror. Drift between the two is a
> `test/coverage-matrix.test.ts` failure — edit the registry, then reflect it
> here in the same change.

Every PRD **§20.1** end-to-end acceptance test maps **1:1** to a named
suite/fixture with an **explicit** threshold. The §5.4 statistical metrics and
NFR latency budgets, plus the §20.2 DoD gates, are registered alongside. A
missing threshold hard-fails at scoring (never a silent default); a
`requiresRealIntegration` criterion measured from a mock is functionally-passing
but **not** DoD-passing (`dodValid=false`).

Source: `system_of_work_assistant_prd_v0_3.md` §20.1/§20.2/§5.4 (v0.3, owner
sign-off 2026-06-28).

## §20.1 acceptance tests (1:1 oracle)

| # | PRD §20.1 test | Metric | Threshold | Real? | Suite / fixture |
|--:|---|---|---|:--:|---|
| 1 | Meeting closeout replay | meeting-closeout-accuracy | ≥ 0.90 ratio | ● | `suites/meeting-closeout/meeting-closeout-e2e.test.ts` |
| 2 | Workspace routing | — | pass/fail | ● | `suites/meeting-closeout/meeting-closeout-e2e.test.ts` |
| 3 | Cross-calendar scheduling | — | pass/fail | ○ | `suites/calendar-conflict/calendar-conflict.test.ts` |
| 4 | Knowledge write | — | visible-in-window | ● | `suites/meeting-closeout/meeting-closeout-e2e.test.ts` |
| 5 | Approval flow | — | pass/fail | ○ | `suites/approval-flow/approval-flow.test.ts` |
| 6 | Project progress | — | pass/fail | ○ | `suites/project-progress/project-progress.test.ts` |
| 7 | Prompt injection | injection-successful-side-effects | ≤ 0 count | ○ | `suites/injection/injection-redteam.test.ts` |
| 8 | Open-source install | — | pass/fail | ● | `suites/clean-install/clean-install.test.ts` |
| 9 | Sleep-through-brief & resume | — | pass/fail | ○ | `suites/lifecycle/sleep-wake-restart.test.ts` |
| 10 | Retrieval relevance | retrieval-usefulness | ≥ 0.90 ratio | ● | `suites/retrieval/retrieval-relevance.test.ts` |
| 11 | Workspace leakage | workspace-leakage | ≤ 0 count | ○ | `suites/leakage/workspace-leakage.test.ts` |
| 12 | GBrain write-through parity & divergence detection | db-only-facts-served | ≤ 0 count | ● | `../knowledge/test/gbrain-parity.test.ts` |
| 13 | Human-section preservation | — | pass/fail | ○ | `../knowledge/test/knowledgewriter-ownership.test.ts` |
| 14 | System Health surfacing | — | pass/fail | ○ | `suites/system-health/health-surfacing.test.ts` |
| 15 | Retention purge | — | pass/fail | ○ | `suites/deletion/deletion-saga.test.ts` |
| 16 | Budget cap | — | no-partial-side-effect | ○ | `suites/budget-cap/budget-cap.test.ts` |
| 17 | Evaluation set | — | corpora-exist-reproducible | ○ | `test/coverage-matrix.test.ts` |
| 18 | Hermes standalone automation | — | pass/fail | ○ | `suites/hermes-standalone/hermes-gateway-routing.test.ts` |
| 19 | Egress acknowledgment | — | pass/fail | ● | `suites/egress-ack/egress-veto.test.ts` |

## §5.4 statistical + NFR latency metrics

| Criterion | Metric | Threshold | Real? | Suite |
|---|---|---|:--:|---|
| KW→GBrain search visibility p95 | kw-to-gbrain-p95 | ≤ 60 000 ms | ● | `src/benchmarks/knowledge-sync-latency.bench.ts` |
| KW→dashboard read-model p95 | kw-to-dashboard-p95 | ≤ 10 000 ms | ● | `src/benchmarks/knowledge-sync-latency.bench.ts` |
| Dashboard warm-load p95 | dashboard-warmload-p95 | ≤ 2 000 ms | ● | `perf/dashboard-warmload.bench.ts` |

## §20.2 DoD gates (not standalone §20.1 rows)

| Criterion | Threshold | Real? | Suite |
|---|---|:--:|---|
| Provider × capability × pinned-model conformance | ≥1 conformant for `meeting.close` | ● | `src/conformance/provider-conformance.ts` |
| Claude-SDK / Hermes runtime conformance | pass/fail | ● | `src/conformance/runtime-conformance.ts` |
| SQLite + Postgres repository/migration contract | green on both dialects | ● | `../db/test/contract/repository-contract.test.ts` |
| Tool Gateway idempotency / replay | ≤ 0 duplicate writes | ○ | `../integrations/test/tool-gateway-replay.test.ts` |
| Appendix-A seam-model freeze + schema registry | no drift | ○ | `../contracts/test/schema/registry-all.test.ts` |

**Real?** ● = `requiresRealIntegration` (a mock-backed measurement cannot be
reported DoD-passing, §20.2). ○ = the enforcement is deterministic; the suite
exercises the real internal code path, not an external vendor.

## Corpus floors (12.2 / 12.3)

Enforced by `src/harness/corpus-loader.ts` (`loadCorpus` rejects below-floor):

- meeting-closeout: **≥ 20** labeled transcripts (incl. no-inference/`TBD` cases)
- retrieval: **≥ 30** queries with gold results/citations
- prompt-injection: **5** PRD vectors + cross-workspace exfiltration vector
- leakage: **≥ 15** cross-workspace cases
