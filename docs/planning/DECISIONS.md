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
| GBrain write-through | Write-through ON in V1, fail-closed (divergence/parity layer); DB-canonical reversal rejected | Locked (2026-06-30, ADR-007) | Owner wants gbrain generative features; safe via bytes-from-Markdown serving + gbrain-independent derive + HMAC stamp + OS one-writer; reverses the Phase-0 read-only deferral | Per-workspace `writeThroughEnabled` OFF → read-only/index-only (the named §6 fallback) |
| Stream primitive | WebSocket (tRPC v11 subscription) | Locked (2026-06-30) | Phase-0 spike 0.5: WS/SSE both lossless; WS wins on loopback auth (token off the URL) | SSE via httpSubscriptionLink (validated drop-in) |
| Hermes surface | Hybrid: one-shot CLI subprocess + Kanban (RT-7) | Locked (2026-06-30) | Phase-0 spike 0.3: live meeting-close mock passed; lowest lifecycle friction | Claude Agent SDK carries the meeting.close critical path |
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
| Contract authoring | Zod-as-source: one `.strict()` Zod schema → `z.infer` TS type + generated strict JSON Schema (ajv-strict gate) + frozen field-set snapshot | Locked (2026-06-30, ADR-008) | Single source ⇒ TS/Zod/JSON-Schema cannot drift; the candidate-data gate (REQ-S-006) compiles the generated schemas | Hand-author all three with a field-name parity test |
| DB schema source | Single-dialect Drizzle `sqlite-core` source + portable column types; pure repo interfaces; pg-core mirror + both-dialect contract suite deferred to Phase 2 | Locked (2026-06-30, ADR-009) | SQLite is the V1 default (§13); Drizzle has no truly dialect-neutral builder, so author the portable source now and mirror at adapter time | Dual per-dialect table defs from a shared column-spec factory |
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

## ADR-007 - GBrain Write-Through & Divergence/Parity Layer (V1)

Status: Locked (2026-06-30). Reverses the Phase-0 read-only/index-only deferral; supersedes the "GBrain read-only/index-only branch" no-go in the Phase-0 spike criteria.

Decision: GBrain write-through ships ON in V1, fail-closed. Markdown stays the only canonical truth and KnowledgeWriter its only autonomous writer (DB-canonical reversal was considered and rejected). gbrain is DB-first natively, so SoW inverts by policy: the GBrain DB is a pointer/ranking index only; serving re-hydrates answer bytes from committed Markdown; the canonical "what should exist" set is derived by a SoW-owned, gbrain-independent Markdown parser. Three safety legs — bytes-from-Markdown serving (default-deny), gbrain-independent allow-set + unforgeable HMAC provenance stamp (SecretsPort key the generative/runtime never hold), and OS-level one-writer lockdown (vault read-only mount + ACL for every gbrain process). gbrain's generative features (synthesize/dream/patterns/Minions) survive as a propose-only source: output → GBrainProposedFact → validation → KnowledgeMutationPlan → KnowledgeWriter → Markdown. `writeThroughEnabled` is per-workspace, default OFF (read-only/index-only fallback) until the four GO conditions pass live against the pinned gbrain SHA.

Rationale: owner wants gbrain's generative value without surrendering the no-hidden-brain / egress-enforceability / Obsidian-durability properties that depend on Markdown-canonical. Adversarially hardened (8-agent design workflow: ground → 3 designs → 3 safety critics → synthesis). Full spec: `docs/design/gbrain-write-through-divergence.md`. Contract: ARCHITECTURE.md §6/§12/§13/§16/Appendix A; build: IMPLEMENTATION_PLAN.md Phase-4 4.14–4.20 + Phase-12 12.7/12.22/12.23.

Fallback: per-workspace `writeThroughEnabled` stays OFF → GBrain runs read-only/index-only (still DoD-satisfying, REQ-D-001) if containment can't be proven for a workspace.

## ADR-008 - Contract Authoring Model (Zod-as-source)

Status: Locked (2026-06-30). Governs how every `packages/contracts` Appendix-A model is authored across all six build tracks.

Context: each frozen seam model needs three coherent representations — a runtime-safe TypeScript type (for compile-time safety downstream), a runtime validator (Zod), and a strict JSON Schema (the candidate-data gate, REQ-S-006). Hand-authoring all three invites silent drift between them, which is exactly the cross-track Finding the §2.5 freeze exists to prevent.

Options considered:

| Option | Pros | Cons |
|---|---|---|
| Zod-as-source | One authored artifact per model; TS type = `z.infer`, JSON Schema = generated (`zod-to-json-schema`, `additionalProperties:false` from `.strict()`); the three representations are structurally incapable of drifting; shared sub-shapes authored once and imported | Adds `zod-to-json-schema` dep; `.refine` conditional invariants are not expressible in JSON Schema (enforced by Zod + tests instead); branded `z.infer` types need an explicit-interface workaround under `declaration: true` (TS4023) |
| Hand-author all three | No codegen dependency | Three sources to keep in sync per model; drift caught by a parity test (detective) rather than prevented (structural) |

Decision: **Zod-as-source.** Per model: one `.strict()` Zod schema → `export type X = z.infer<…>` → `emitJsonSchema(XSchema, X_SCHEMA_ID)` writes a self-contained draft-07 JSON Schema; the ajv-strict registry (`defaultSchemaRegistry`) compiles every `schemas/*.schema.json` by `$id`; the domain `validate(output, schemaId)` gate is the candidate-data boundary. Each model also ships a hand-authored field-set snapshot (`__snapshots__/<model>.snap`) that freezes the top-level field-name set; a field change forces a visible snapshot diff. Conditional invariants live in `.refine()` + tests (JSON Schema stays structural); deeper validators are Phase-1 task 1.11.

What would change it: if `declaration`-emit ergonomics or JSON-Schema fidelity of generation prove unworkable, fall back to hand-authoring with a field-name parity test.

Implementation: `packages/contracts/src/schema/{emit,field-set,registry}.ts`, `packages/domain/src/validation/schema-gate.ts`, `packages/contracts/test/_helpers/freeze.ts`. Built 2026-06-30 (IMPLEMENTATION_PLAN.md tasks 1.2–1.9 + the 27-model freeze).

**Consequence (candidate-data gate composition).** Because `zod-to-json-schema` drops `.refine`, the ajv `validate()` gate is **structural-only** and does not enforce cross-field invariants (e.g. read_only⇒!allowsMutating, KMP non-empty sourceRefs, egress ack⇔acknowledgedAt, Divergence HARD-floor). The candidate-data gate (safety rule 2) is therefore the **composition** ajv `validate()` + the model's Zod `parse` + the §3 universal rules (`packages/domain/src/validation/universal-rules.ts` + no-inference) + the §5/§6/§7 predicates — never ajv alone. Pinned by `packages/domain/test/fixtures/fixtures.test.ts` (full ajv+Zod biconditional). Open Finding for §5/§7/§9 wiring.

## ADR-009 - Operational-Store DB Schema Source (single-dialect now, mirror at adapter time)

Status: Locked (2026-06-30). Scope: Phase-1 task 1.14 (`@sow/db` schema source + repository interfaces). The concrete adapters, migrations, and the both-dialect contract suite are Phase-2/§4 (REQ-D-003).

Context: §4 requires SQLite (local) **and** standard Postgres adapters from day one, both passing one repository contract suite. Drizzle has no single dialect-neutral table builder — tables are declared per-dialect (`drizzle-orm/sqlite-core` vs `pg-core`). Phase 1 must freeze a schema *source* + the repository *interfaces* (the durable cross-track contract) without yet building the adapters.

Decision: author the Phase-1 schema source once in `drizzle-orm/sqlite-core` (SQLite is the V1 default, §13) using only **portable column types** (text, integer, `integer({mode:'boolean'})`, `text({mode:'json'})` for nested values, ISO-text timestamps) — no pg-only `jsonb`/`uuid`/`serial`. Repository interface contracts are pure TypeScript (no Drizzle import) so domain can depend on interfaces, never a driver (§2.5). A column-name parity drift-guard asserts the 6 directly-persisted flat models' table columns match their frozen contract field-sets. The **pg-core mirror + migrations + the both-dialect repository contract suite are Phase-2/worker.**

Rationale: freezes the load-bearing contract (interfaces + column-name parity) now while keeping the table source minimal and portable; avoids prematurely committing to a dual-definition mechanism before the adapters exist. SourceEnvelope persists as event-log payloads (per `DATA_MODEL.md`), not a flat config table, so it is excluded from the flat-parity set by design.

What would change it: if Phase-2 finds the portable-types subset too restrictive, switch to dual per-dialect table definitions generated from a shared column-spec factory (the fallback).

