# Anchor Remap — `ARCHITECTURE_DRAFT.md` → `ARCHITECTURE.md`

`/arch-finalize` mapping from the Brain-1 draft anchors to the binding root `ARCHITECTURE.md`. Draft §2–§15, §2.5, §17, and Appendix A are preserved (stable — referenced by `DIAGRAM_PLAN.md` and the Spec Anchor Index). Only the head (Exec/Goals), the meta gap-audit-targets section, and the Spec-Anchor-Index/Open-Questions tail changed.

| Draft anchor | Final anchor | Note |
|---|---|---|
| §1 — Executive Summary | **Executive summary** (named, unnumbered) | Promoted to the template's prose summary + one-line posture. |
| §1A — Goals and Non-Goals | **§1 — Goals & non-goals** | Renumbered to template §1. |
| §2 — System Overview | §2 — System overview | Stable. Diagram updated (auth, fs-watch, GCL bidirectional). |
| §2.5 — DAG & seams | §2.5 — Subsystem dependency DAG & parallelization seams | Stable. |
| §3 — Shared Contracts and Domain | §3 — Shared Contracts & Domain | Stable; **EgressPolicy + ToolPolicy now defined**. |
| §4 — Operational Storage | §4 — Operational Storage | Stable; +encryption-at-rest, +migration rollback/backup, +Temporal-unavailable. |
| §5 — Policy, Security, and Egress | §5 — Policy, Security & Egress | Stable; +worker-API auth, +egress-veto rule. |
| §6 — Knowledge/Markdown/Obsidian/GBrain/GCL | §6 — Knowledge: Markdown, Obsidian, GBrain & GCL | Stable; +human-section preservation, +fs-watch reconcile (Obsidian Sync), +GCL bidirectional, +GBrain capability surface, +cross-workspace links. |
| §7 — Provider and Runtime Broker | §7 — Provider & Runtime Broker | Stable; +AgentRuntimePort vs ModelProviderPort layering, +matrix-routes-critical-path, +budget caps, +Hermes-surface spike. |
| §8 — Connector and Tool Gateways | §8 — Connector & Tool Gateways | Stable; +connector sync/health, +NotebookLM sync. |
| §9 — Temporal Workflows and Automation | §9 — Temporal Workflows & Automation | Stable; +8 previously-unspecified workflows, +deletion saga, +deferred-approval semantics. |
| §10 — Local App API | §10 — Local App API | Stable; +session-token auth. |
| §11 — Electron Desktop UI | §11 — Electron Desktop UI | Stable; +inbox triage, +workspace presets. |
| §12 — Eval and Test Harness | §12 — Eval & Test Harness | Stable; +7 DoD-required suites, +perf benchmark, +leakage corpus size. |
| §13 — Deployment and Install Strategy | §13 — Deployment, Install, Rollback & Repair | Stable; +packaging decision, +GBrain pin-upgrade gate, +migration rollback, +doctor/repair. |
| §14 — Alternatives Considered | §14 — Alternatives considered | Stable; +2 finalization alternatives. |
| §15 — Scope Boundaries and Deferred Work | §15 — Scope boundaries & deferred work | Stable; +V1.1 items from finalization. |
| §16 — Architecture Gap Audit Targets (meta) | **REMOVED** | Meta instruction to `/arch-finalize`; resolved by this audit (`docs/gap-audits/`). The §16 slot is reused. |
| — | **§16 — Cross-cutting concerns** (NEW) | Observability/logging+redaction, worker supervision, backup & recovery, config/time, error convention. |
| §17 — Repo Scaffold | §17 — Repo scaffold | Stable (kept numbered so `DIAGRAM_PLAN` sub-diagram 7 anchor stays valid). |
| §18 — Spec Anchor Index | **Spec Anchor Index** (named, unnumbered) | Moved to the template's named section; +7 new REQ rows. |
| — | **§18 — Open questions** (NEW) | OQ-001..012 dispositions + the Phase-0 perf-budget pass. |
| Appendix A — Model/Contract Inventory | Appendix A — Model / contract inventory | Stable; +EgressPolicy, ToolPolicy, Capability/ProviderRoute, ProviderProfile, WorkflowRunRef. |

**Downstream reference check:** `DIAGRAM_PLAN.md` spec-anchors point at §2–§13, §2.5, §17, Appendix A — all stable; only the Full-Scope diagram's `ARCHITECTURE_DRAFT.md` filename was updated to `ARCHITECTURE.md`. `DECISIONS.md` ADRs carry no "Related Architecture Anchors" lines, so none dangle.
