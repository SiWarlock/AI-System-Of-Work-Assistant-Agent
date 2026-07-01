# Phase 5 — Arch-Drift Audit

- **Gate:** `/phase-exit 5` · **Date:** 2026-07-01 · **Auditor:** `arch-drift-auditor`
- **Subject:** `packages/providers` (`@sow/providers`) @ HEAD `84c3c7e`.
- **Verdict: CLEAR** — 5 anchors audited (§7/§5/§3/§12/§16), 15 checkable statements · **0 DRIFT · 1 STALE-DOC · 1 AMBIGUOUS**.
- **Gates:** 232/232 providers tests green; `packages/evals` 34/34; `tsc --noEmit` clean.

## Anchor verdicts — all VERIFIED

- **§7 two-port split** — AgentRuntimePort vs ModelProviderPort are distinct interfaces; no adapter satisfies both (model adapters implement ModelProviderPort only; claude-agent-sdk/hermes implement AgentRuntimePort only).
- **§7 fixed gate order** — `broker.ts` runs admission → route resolution → egress veto → health/availability → budget-pre → run → budget-post → schema gate → emit, in exactly that order; each denial short-circuits so no later gate widens an earlier one.
- **§7 egress veto AFTER selection, narrow-only, fail-closed, no cloud fallback** — veto placed after route resolution; `egress-veto.ts` `sameEgressTarget` rejects any substituted/widened route as MALFORMED_POLICY_INPUT; `failClosedNoProvider` attaches an OBS-2 health item, never a silent fallback.
- **§7 adversarial fix — the vetted matrix route is the execution + budget target** (VERIFIED-BY-TEST): `broker.ts` builds `effectiveJob` and passes it to `budget.pre/post`, `run`, and `schema`; `test/adversarial-regressions.test.ts` pins `runRoute === MATRIX_ROUTE` + `budgetRoute === MATRIX_ROUTE` (≠ DIVERGENT_ROUTE) — green.
- **§7 strict side-effect rule** — the broker + schema-gate import no write adapter; `BrokerCandidate` is a KnowledgeMutationPlan/ProposedAction candidate only, never applied.
- **REQ-S-007 / COST-1/2 budget** — a cancelled/breached run's output is discarded BEFORE the schema gate (no partial side effect); a job with no bounded runtime cap is refused (fail-closed COST-2 floor); default caps sourced from config, never hardcoded.
- **§5** — OpenRouter is its own processor (`providerId "openrouter"`, never "openai"); ING-7 defense-in-depth in both runtime adapters + the Hermes empty-toolset refusal (LESSONS §1).
- **§12** — conformance gates matrix eligibility (non-passing → disabled + ineligible); real adapters transport-mocked, real runs key-gated (the intended §12 posture, not drift).
- **§16** — `provider-log-redaction.ts` structurally drops prompt/rawContent/response + scrubs credential shapes; every gate returns a typed `GateResult` (never throws); closed error enums.
- **§3** — all 13 AgentJob fields present with correct types + embedded ToolPolicy.

## Findings

- **STALE-DOC (carry-forward):** the frozen `FailureClass` enum (`shared-enums.ts`, 10 members) is missing `"provider_routing_unavailable"`. The broker legitimately needs a distinct health class for a fail-closed no-eligible-provider outcome and abstracts it behind `NO_ELIGIBLE_PROVIDER_HEALTH_CLASS='provider_routing_unavailable'` (typed `string`, flagged `arch_gap` in `broker.ts:52`) — same pattern as `policy_denial`/`egress_status`/`db_unavailable`. **To do:** add `provider_routing_unavailable` to the OBS-2 `FailureClass` taxonomy (ARCHITECTURE Appendix A HealthItem row + §16 + `health-item.ts` + snapshot) if §16 wants a distinct class.
- **AMBIGUOUS:** §7 says a budget breach "surfaces a System Health item (OBS-2)". The broker exports `budgetBreachHealthItem()` + emits an `AuditSignal.healthSignalClass`, but does not itself attach a `BrokerHealthItem` to the budget-breach `BrokerRejection` (only the no-provider path does). §9 workflow-11 ("System Health surfacing") is the canonical OBS-2 assembler — ambiguous whether "surfaces" means broker attachment or workflow-layer assembly. Pin at the §9 gate.

## Verdict

**CLEAR.** No §7/§5/§3/§12/§16 drift; the veto-binds-execution fix is confirmed; the two findings are a recorded `FailureClass` carry-forward + a §7/§9-boundary ambiguity, neither a blocker.
