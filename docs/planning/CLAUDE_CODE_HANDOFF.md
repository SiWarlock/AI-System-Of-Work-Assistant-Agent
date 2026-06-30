# Claude Code Handoff

Status: rough-draft handoff for `/arch-finalize`.

## Goal

Review the rough-draft architecture package, run a second-pass gap audit, propose any load-bearing edits, confirm them with the human, then produce the finalized root `ARCHITECTURE.md`. Do not start implementation. Do not produce `IMPLEMENTATION_PLAN.md` until the architecture is finalized.

## Build Posture

Production-grade.

Audit against production-grade expectations:

- Auth/access model, even if single-owner.
- Input validation and schema gates.
- Error paths and retry/outbox behavior.
- Idempotency and replay safety.
- Observability/System Health.
- Secrets handling.
- Deploy/install/rollback/repair path.
- Security/trust boundaries.
- Test/eval gates.

## Inputs to Read

Read all of these end to end:

- `system_of_work_assistant_prd_v0_3.md`
- `docs/planning/PRODUCT_BRIEF.md`
- `docs/planning/USERS.md`
- `docs/planning/STAKEHOLDERS.md`
- `docs/planning/USER_FLOWS.md`
- `docs/planning/DOMAIN_MODEL.md`
- `docs/planning/REQUIREMENTS.md`
- `docs/planning/CONSTRAINTS.md`
- `docs/planning/EVALUATION_CRITERIA.md`
- `docs/planning/ASSUMPTIONS.md`
- `docs/planning/OPEN_QUESTIONS.md`
- `docs/planning/RESEARCH.md`
- `docs/planning/DECISIONS.md`
- `docs/planning/RISKS.md`
- `docs/planning/THREAT_MODEL.md`
- `docs/planning/DATA_MODEL.md`
- `docs/planning/ARCHITECTURE_DRAFT.md`
- `docs/planning/DIAGRAM_PLAN.md`

Also inspect the scaffold templates before finalizing root architecture:

- `scaffold/templates/ARCHITECTURE.md`
- `scaffold/templates/IMPLEMENTATION_PLAN.md`
- `scaffold/SCAFFOLDING-GUIDE.md`

## User-Confirmed Deviations from PRD

Treat these as locked unless the human reopens them:

- Electron replaces Tauri.
- Electron renderer is unprivileged; main process supervises a dedicated Node/TypeScript control-plane worker.
- One Obsidian-compatible Markdown repo/vault per workspace.
- One GBrain brain per workspace.
- Separate sanitized Global/Coordination Markdown repo plus GCL DB.
- Dual operational-store adapters from day one: SQLite and standard Postgres through Drizzle.
- TypeScript monorepo with pnpm workspaces and Turbo.
- Hybrid local boundary: preload IPC plus loopback tRPC API and event stream.
- ModelProviderPort includes Claude, OpenAI, OpenRouter, Ollama, and LM Studio.
- Local models are optional zero-egress path, not V1 release gate.
- Strict JSON Schema gates before side effects.
- Contract/eval-heavy test posture.

## Required Gap Audit

Return findings in these groups:

1. Critical gaps that block final architecture.
2. Important gaps that should be fixed before `/tasks-gen`.
3. Nice-to-have improvements.
4. Proposed edits to root `ARCHITECTURE.md`.
5. Questions requiring human decision.

Audit at least these dimensions:

- Missing user/system flows.
- Missing lifecycle states.
- Missing failure modes.
- Missing interfaces/schemas.
- Unclear source-of-truth boundaries.
- Unresearched external dependencies.
- Inconsistent PRD vs user-confirmed decisions.
- Overbuilt or underbuilt scope.
- Missing tests/evals.
- Missing deployment/install path.
- Missing security/trust boundaries.
- Missing diagrams.
- Missing task-planning anchors.
- Missing scaffold-compatible §2.5 DAG and Appendix A model inventory.

## Specific Scrutiny Points

- Reconcile every PRD reference to Tauri with the locked Electron decision.
- Verify Electron security posture is explicit enough.
- Check GCL design for every global/cross-workspace flow.
- Ensure provider matrix cannot bypass Employer Work egress policy.
- Ensure OpenRouter is treated as a separate external processor.
- Ensure local model routes are conformance-gated and not critical release gate.
- Ensure SQLite/Postgres dual storage is testable and not just aspirational.
- Ensure GBrain PGLite, Temporal persistence, and operational DB are separate.
- Ensure KnowledgeWriter remains sole semantic Markdown writer.
- Ensure Obsidian remains a first-class human surface.
- Ensure final DoD requires real integrations, not permanent stubs.

## Output Expectations for `/arch-finalize`

Produce root `ARCHITECTURE.md` using the project scaffold template shape:

- Executive summary.
- Goals/non-goals.
- System overview.
- `§2.5` dependency DAG and parallelization seams.
- Major subsystem sections.
- Stable anchors for every build-relevant contract.
- Spec Anchor Index.
- Appendix A model/contract inventory.
- Open questions.
- Alternatives considered.
- Risks/security.
- Deployment/install strategy.
- Claude Code review/build instructions.

After that, and only after architecture finalization, `/tasks-gen` should create `IMPLEMENTATION_PLAN.md` from the finalized root architecture and the scaffold task template.

