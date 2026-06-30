# Decisions

Status: rough-draft decision log for `/arch-finalize`.

## Locked Decision Summary

| Area | Decision | Status | Rationale | Fallback |
|---|---|---|---|---|
| Planning | Expanded mode | Locked | PRD is integration-heavy, privacy-heavy, and review-driven | Default mode if artifact burden becomes too high |
| Build posture | Production-grade | Locked | Real personal/work data, side effects, privacy, lifecycle, and OSS install require hardening | Explicit MVP deferrals only by owner decision |
| Proof spine | Meeting closeout first | Locked | Exercises routing, GBrain, provider schema, KnowledgeWriter, Tool Gateway, approvals, idempotency, audit | Daily brief if meeting spike fails |
| V1 scope | Full PRD V1 remains in scope | Locked | Owner chose full PRD V1; meeting closeout is sequencing, not scope cut | Explicit scoped V1 cut |
| Human actors | Single owner/operator only | Locked | V1 is personal/self-hosted; employer/client are policy constraints | Add reviewer/auditor roles later |
| Desktop shell | Electron | Locked | User chose TypeScript-first local control plane over Tauri/Rust sidecar boundary | Reopen shell ADR if packaging/security spike fails |
| Process model | Electron main supervises Node/TypeScript worker | Locked | Keeps UI shell thin and product logic isolated from renderer/main | External daemon |
| App boundary | Hybrid preload IPC + loopback worker API | Locked | Privileged desktop operations need IPC; dashboard/status data benefits from local API | IPC-only |
| Local API | tRPC commands/queries + event stream | Locked | TypeScript monorepo and shared contracts | REST + WebSocket |
| Workspace Markdown | Repo/vault per workspace | Locked | Aligns trust boundary, Obsidian use, Git backup, and raw data isolation | Monorepo subdirectories |
| Global Markdown | Separate sanitized Global/Coordination repo | Locked | Keeps global briefs inspectable without raw workspace leakage | DB-only GCL |
| GBrain topology | Brain per workspace | Locked | Strongest retrieval boundary and aligns with vault-per-workspace | Source-scoped personal brain |
| Cross-context UX | Sanitized grouped global summaries with drill-down | Locked | Preserves usable global views without raw cross-brain retrieval | Always ask workspace first |
| Workflow engine | Temporal owns product workflows | Locked | Durable retries, schedules, approval waits, restart recovery | Custom scheduler not recommended |
| Hermes autonomy | Hermes cron/Kanban allowed through gateways | Locked | Owner runs Hermes; gateways enforce safety rather than banning scheduler | Disable standalone Hermes autonomy |
| Operational storage | SQLite + standard Postgres adapters from day one | Locked | Local-first plus hosted-compatible architecture | SQLite-only V1 |
| DB tooling | Drizzle | Locked | TypeScript-first schemas/migrations across SQLite/Postgres | Kysely + SQL |
| Hosted provider | Plain Postgres, not Supabase-specific | Locked | Keeps provider-neutral hosted path; Supabase can host later | Supabase platform ADR later |
| Monorepo | TypeScript monorepo with pnpm + Turbo | Locked | Supports contracts, packages, parallel tracks, OSS install | npm workspaces |
| Local auth | macOS session + Keychain | Locked | Single-owner V1; avoids separate auth surface | App unlock later |
| Employer egress | Workspace settings gate + System Health visibility | Locked | Explicit, durable privacy control | Per-run prompt |
| Model providers | Claude, OpenAI, OpenRouter, Ollama, LM Studio | Locked | User wants cloud/provider breadth plus local zero-egress option | Claude-only critical path |
| Local models | Optional zero-egress path, not release gate | Locked | Prevents local model quality from blocking V1 | Required zero-egress path |
| Provider routing | Workspace + capability matrix | Locked | Privacy/cost/capability vary by workspace and job | Global defaults |
| Provider output | Strict JSON Schema gate before side effects | Locked | Prevents provider variance from reaching write layers | Repair pass later if needed |
| Testing | Contract/eval-heavy | Locked | Privacy/idempotency/provider/storage risks are load-bearing | Balanced standard testing |
| Parallelization | Parallel after contracts | Locked | Shared contracts must freeze before tracks split | Mostly serial |

## ADR-001 - Electron Desktop Shell

Status: Locked.

Context: PRD named Tauri, but user reopened the decision and chose Electron.

Options considered:

| Option | Pros | Cons | Build Risk | Security Risk | PRD Alignment |
|---|---|---|---|---|---|
| Electron | TypeScript-first, fewer Rust/Node seams, easier local worker integration | Larger app, stricter Electron security discipline needed | Medium | Medium if misconfigured | User-confirmed change |
| Tauri | Smaller native shell, capability model, sidecar containment | Rust/Node bridge friction, most product code still TS | Medium | Low/medium | Original PRD |
| SwiftUI | Native Mac feel | Highest integration burden with TS workflows/providers | High | Medium | Weak |

Decision: Electron with unprivileged renderer, thin main, dedicated Node/TypeScript worker.

What would change it: Phase-0 Electron security/packaging spike fails or app footprint becomes unacceptable.

## ADR-002 - Workspace Knowledge Isolation

Status: Locked.

Decision: one Markdown repo/vault and one GBrain brain per workspace. GCL stores sanitized projections and global coordination data only.

Rationale: workspace privacy and Employer Work confidentiality are core product risks. Structural isolation is easier to audit than source-filter-only retrieval.

Fallback: personal-owned brain with source filters for Personal Business/Personal Life if multi-brain GBrain ergonomics fail.

## ADR-003 - Operational Storage

Status: Locked.

Decision: app-owned operational store has SQLite local and standard Postgres adapters from day one, using Drizzle for schemas/migrations/type-safe queries.

Rationale: local-first V1 needs easy embedded storage; hosted-compatible V1.1 path should not require a storage rewrite. Drizzle fits TypeScript and both target dialects.

Tradeoff: higher V1 test burden and need to avoid dialect-specific assumptions.

Fallback: SQLite-only V1 with Postgres adapter deferred if dual contract becomes too slow.

## ADR-004 - Model Provider Layer

Status: Locked.

Decision: add ModelProviderPort and provider matrix for Claude, OpenAI, OpenRouter, Ollama, and LM Studio. Strict schema gate before side effects.

Rationale: user wants multiple cloud routes and local zero-egress capability. Provider behavior varies, so conformance tests become the contract.

Fallback: disable provider/capability pairs that fail conformance; keep critical path on the best passing provider.

## ADR-005 - API Boundary

Status: Locked.

Decision: Electron renderer uses preload IPC for privileged desktop/lifecycle actions and local loopback tRPC API plus event stream for worker commands/queries/status.

Rationale: IPC is safer for privileged operations; tRPC keeps TypeScript app/worker contracts type-safe.

Fallback: REST + WebSocket if tRPC streaming or packaging proves awkward.

## ADR-006 - Build Track Strategy

Status: Locked.

Decision: freeze shared contracts first, then parallelize worker/storage/workflows, desktop UI/API, integrations/providers, and eval/security.

Rationale: the scaffold expects a §2.5 DAG and shared-contract inventory. This system has independent areas only after model/schema/API contracts are stable.

Fallback: mostly serial build if team-mode overhead outweighs wall-clock benefit.

