# Phase 1 — Arch-Drift Audit

- **Gate:** `/phase-exit 1` · **Date:** 2026-06-30 · **Auditor:** `arch-drift-auditor`
- **Verdict: CLEAR** — 0 DRIFT · 1 STALE-DOC (fixed) · 5 AMBIGUOUS (arch_gaps, flagged in code)
- **Anchors audited:** §3 (27 models + universal rules) · §5 (EgressPolicy/ToolPolicy) · §7 (ProviderRoute/budget/conformance) · §9 + DOMAIN_MODEL.md (6 state machines) · §12 (snapshot posture) · §16 (typed-result convention)

## §3 + Appendix A — 27 models
All 27 `__snapshots__/*.snap` present and field-name-verified against Appendix A — **PASS on all 27** (no extra/missing/renamed top-level fields). Sub-shape spot-checks passed: `NotebookMapping.managedDocIds` 5 slots; `HealthItem.failureClass` 10-value OBS-2 enum (incl. `sync_lagging`/`rebuild_divergence`); `EgressPolicy` ack⇔acknowledgedAt refine; `ToolPolicy` read_only⇒!allowsMutating; `ProviderMatrix` route-provider ⊆ allowedProviders; `Workspace` id≡egressPolicy≡providerMatrix workspaceId; `KnowledgeMutationPlan.signedProvenanceStamp` optional (known lifecycle flag).

## §3 universal rules
`ruleSchemaValid` (delegates to schema-gate), `ruleExternalWriteKeys`, `ruleScopedMutation`, `ruleVisibilityDeclared` — all pure typed-Result; no-inference (`validateNoInference`) hard-rejects a non-TBD value lacking evidence (`inferred_owner_or_date` / `missing_evidence`), `TBD` always passes. **VERIFIED.** ajv gate structural-only confirmed (Lesson 3): gate = ajv + Zod parse + universal rules + §5/§6/§7 predicates, never ajv alone.

## §5 / §7
EgressPolicy/ToolPolicy refines enforced at construction + `isToolPolicyConsistent`/`effectiveAllowedTools` exposed for the §5 admission gate; ING-7 per-tool catalog check correctly noted as arch_gap (catalog unspecified upstream). ProviderRoute discriminated union + egressClass enum; AgentJob COST-1 budget fields; ProviderProfile conformanceStatus enum + no inline secret (REQ-S-003). **VERIFIED.**

## §9 + DOMAIN_MODEL — 6 state machines
Source / Meeting-Closeout / Knowledge-Mutation / Proposed-Action / AgentJob / Approval all match DOMAIN_MODEL transition graphs; terminals frozen; illegal/terminal → typed rejection (never throws); pinned forbidden/legal cases hold (Source captured→applied illegal + no external_write; KMP no backward edge out of committed_to_markdown; Approval deferred non-terminal + idempotent terminal re-apply; AgentJob running→cancelled_budget terminal). Approval carries a compile-time bidirectional drift guard against the frozen `ApprovalStatus` enum. **VERIFIED.**

## §12 / §16 / REQ-D-002
27 snapshots present; `defaultSchemaRegistry` compiles all under ajv strict + formats, fails fast on missing `$id`. `Result<T,E>` used across every Phase-1 boundary — no throw (schema-gate, universal-rules, no-inference, state transitions, db repo interfaces all return Results). `@sow/db` schema = sqlite-core only (ADR-009); no plaintext-secret columns; repo interfaces import no concrete driver; workspace-config columns match Appendix A. **VERIFIED.**

## Mismatch classification
- **DRIFT (code ≠ spec):** 0.
- **STALE-DOC (code right, spec lags):** 1 — `docs/planning/DOMAIN_MODEL.md` §Approval omitted `deferred → pending | expired`; ARCHITECTURE.md §9 is binding and the code is correct. **FIXED** this round (DOMAIN_MODEL.md §Approval updated).
- **AMBIGUOUS (open arch_gaps, all flagged in code; pin at §9/Phase-7):** 5 — Source `failed_retryable→processing` exit edge; Meeting-Closeout recovery exit edges (×3: provider_failed/schema_rejected/write_conflict); AgentJob `running→cancelled_budget` (COST-1) + `failed_retryable→admitted` retry. None contradicts a stated forbidden edge or omits a required one.

## Verdict
**CLEAR.** Known/expected items confirmed as-stated (ajv structural-only, pg mirror deferred, KMP stamp optional). The 5 ambiguous recovery edges carry to §9/Phase-7 workflow implementation.
