# Stakeholders and Reviewers

Status: rough-draft planning artifact for `/arch-finalize`.

## Primary Reviewer Lens

| Stakeholder | Cares About | Would Reject If | Evidence Needed | Architecture Must Address |
|---|---|---|---|---|
| Owner / product author | Buildability, privacy, local-first ergonomics, automation quality, Obsidian ownership | Draft drifts from PRD, cuts V1 silently, or leaves implementers to decide core boundaries | Locked decisions, open questions, anchored sections, clear build tracks | Full architecture contract and handoff |
| `/arch-finalize` reviewer | Gaps, inconsistencies, missing failure modes, untestable requirements | Decisions are implicit, research claims are stale, or anchors cannot drive tasks | Decision log, traceability, research, risk list, diagram plan | Adversarial finalization workflow |
| Future `/tasks-gen` session | Task-ready anchors and dependency DAG | Architecture lacks § anchors, shared contracts, or parallelization seams | §2.5 DAG, spec anchor index, Appendix A model inventory | Build-order and testable contract |

## Secondary Reviewer Lenses

| Stakeholder | Cares About | Would Reject If | Evidence Needed | Architecture Must Address |
|---|---|---|---|---|
| Security/privacy reviewer | Workspace leakage, egress, prompt injection, secrets, retention/deletion | Raw Employer Work crosses boundaries, agents hold mutating tools on untrusted content, or hidden GBrain truth emerges | Threat model, egress gates, WS-7/WS-8 tests, ING-7 job-admission gate | Trust boundaries and security tests |
| Open-source maintainer | Installability, repeatable setup, dependency pins, clear adapters | Fresh install requires undocumented services or Hermes; GBrain/Hermes versions drift | Install path, doctor/preflight, pinned versions, adapter conformance | Maintainable local dev and version contract |
| Operator/support persona | Recovery, health, outboxes, retry visibility, troubleshooting | Failures disappear or require manual DB spelunking | System Health requirements, audit trails, runbooks, outbox states | Observability and operational UX |
| Data owner / employer policy lens | Raw work data control and third-party processors | Employer Work raw content reaches cloud without explicit acknowledgment | Workspace egress policy, System Health state, audit | Egress gate and provider allowlists |

## Tolerated Tradeoffs

- [locked decision] Larger Electron footprint is acceptable to reduce Rust/Node sidecar friction and keep the app TypeScript-first.
- [locked decision] More setup overhead from repo/vault per workspace and GBrain brain per workspace is acceptable for stronger privacy boundaries.
- [locked decision] Extra V1 architecture work for SQLite/Postgres dual adapters is acceptable to keep hosted-compatible storage honest from day one.
- [locked decision] Provider breadth increases conformance burden; strict schema gates and adapter tests are non-negotiable.

