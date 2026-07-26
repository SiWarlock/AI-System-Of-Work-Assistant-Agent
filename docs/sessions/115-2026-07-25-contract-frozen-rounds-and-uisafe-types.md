# Session 115 — contract track: frozen-contract rounds + UI-safe projection types (ARC-2 + Wave-2)

- **Date:** 2026-07-25
- **Phase:** 13 (ARC-2 frozen-contract foundation) + Wave-2 contract legs (13.13 / 13.16 / desktop-9.x unblocks)
- **Role:** contract-implementer (single-track `main`)
- **Predecessor session:** prior contract-track arc (Phase-9/13 contract work; not re-linked — parallel-implementer numbering collided at 112–114 this round)
- **Successor session:** _TBD (post-pause)_

## Why this session existed

The owner approved a parallel remaining-build plan. The contract track owned **ARC-2 — the FROZEN-CONTRACT foundation batch** (the one hard bottleneck downstream Task/Project work waited on), followed by three Wave-2 contract legs that unblock idle downstream tracks (desktop Phase-9 surfaces, provint research provider, the 13.16 task-rollup surface). All four slices are contract-first: they freeze the shape; the producing procedures + consuming surfaces land downstream.

## What was built (4 slices, 4 commits — all on `main`)

### #15 — ARC-2 frozen-contract batch — `54b052a7`
- **Files created:** `packages/contracts/src/models/task.ts` (typed `Task` Appendix-A seam model) · `.../models/__snapshots__/task.snap` · `schemas/task.schema.json` · `test/models/task.test.ts` · `packages/db/src/schema/task.ts` + `schema/pg/task.ts` (dual-dialect `task` rollup table).
- **Files modified:** `shared-enums.ts` (NEW `Priority` + `TaskLifecycle` enums; `FailureClass` +4 operational members `db_unavailable`/`provider_routing_unavailable`/`outbox_blocked`/`write_through_blocked`) · `zod-brands.ts` (`TaskId`) · `index.ts` barrel · `fixtures/valid.ts` + `fixtures/index.ts` (`validTask` seam fixture) · `schemas/health-item.schema.json` (regen) · `test/primitives/shared.test.ts` (membership rows) · db `interfaces.ts` (`TaskRow` + `TaskRepository`) + schema barrels + both adapters + test-DDL + `repository-contract.test.ts` (dual-dialect block) · `workflows/src/activities/healthItem.ts` (4 `defaultSeverityForFailureClass` case arms) + test · `providers/src/broker/broker.ts` (retyped `NO_ELIGIBLE_PROVIDER_HEALTH_CLASS` → `satisfies FailureClass`) · `domain/test/fixtures/fixtures.test.ts` (`ZOD_BY_ID` + fixture registration).
- Task is Markdown-canonical; the db `TaskRepository` stores an operational `TaskRow` **rollup index** (mirrors `ProjectRegistryRow`), never a second Task writer (safety rule 1). Passes the both-dialect repo-contract suite (SQLite + Postgres, 228).

### #21 — UiSafe types (desktop Phase-9 unblock) — `28dd42ba`
- **Files modified:** `packages/contracts/src/api/ui-safe.ts` + `test/api/ui-safe.test.ts`.
- NEW `UiSafeSchedule`/`UiSafeScheduleEntry` (busy/free + generic-conflict-only, **no** workspace attribution — REQ-F-009 cross-workspace timing gate); `UiSafeApproval` +optional `targetSystem` (closed enum) + `workspaceId` (plain, global-inbox attribution, GclProjection precedent); a verify-only pin on the already-present opaque `changeId` (9.5). Additive/optional ⇒ existing parsing consumers unbroken.

### #26 — 13.13 ProviderId perplexity+xai frozen round — `50b302b0`
- **Files modified:** `enums.ts` (`ProviderId` +`perplexity`+`xai`) · 3 model source doc-comments (route/profile/matrix) · `test/primitives.test.ts` + `test/primitives/shared.test.ts` (membership pins) · **5** regenerated ProviderId-embedding schemas (`provider-route`/`profile`/`matrix` + `agent-job` + `workspace`) · NEW `test/models/providerid-research.test.ts` (rule-5 pins).
- Each new provider is its OWN member (rule-5 no-alias); the §5 egress veto is **ProviderId-agnostic** (keys on `route.egressClass==="local"` + a loopback-endpoint proof), so a cloud research route fails closed by construction. Dormant — no transport/config (§ARM-RESEARCH).

### #37 — 13.16 UiSafeTaskRollup projection type — `41e0dcca`
- **Files modified:** `ui-safe.ts` + `test/api/ui-safe.test.ts`.
- Additive `UiSafeTaskRollup { items: UiSafeTaskRollupItem[] }` (`taskId`/`title`/`status`/`priority?`/`dueDate?`/`projectRef?`), pre-ranked, `.strict()`, `.max(200)`. Priority optional — absent IS the unset state (no-inference); **no** `workspaceId` anywhere (WS-8 single-workspace ranked list).

## Decisions made

- **db `TaskRepository` stores an operational `TaskRow`, not the contract `Task`** — preserves the one-writer invariant (Markdown-canonical Task stays KnowledgeWriter-owned). Mirrors `ProjectRegistryRow`.
- **All 4 FailureClass members kept** (Q5 distinctness): `write_through_blocked` (precondition-gate HOLD) is distinct from the existing `write_through_failed` (attempt ERRORED); `outbox_blocked` has a near-planned Phase-21 producer.
- **UI-safe `workspaceId` is plain, not branded** (the file's "no branded fields on UI-safe shapes" rule); UI-safe types that must not blend cross-scope carry **no** `workspaceId` (schedule + task-rollup), while the global Approvals inbox carries an optional one (GclProjection attribution precedent).
- **ProviderId egress-classing is NOT a contract map** — it's per-route/profile `egressClass` data; the veto's fail-closed rests structurally on perplexity/xai's absence from `LOCAL_PROVIDERS` (surfaced to §ARM-RESEARCH ledger).
- **Bundled commits where files interleave** (#15: `shared-enums.ts`/`shared.test.ts` straddle both features → one honest frozen round instead of hunk-staging).

## Decisions explicitly NOT made (deferred)

- **9.5 `changeId` opaque-grammar tightening** (to `uiSafeOpaqueRef`) — deferred (risks the existing recent-changes producer; low residual carried by the orch).
- **`degraded-mode.ts` `worker_down`→`db_unavailable` flip** — deferred (visible health-class behavior change; the member-add discharges the frozen debt now).
- **`living_vault_synthesis` provenanceOrigin + any 13.8f/g contract needs** — post-pause carry-forwards (no pending frozen-contract work at pause).

## TDD compliance

**Clean.** Every slice was RED-first: the failing test was written and confirmed RED (for the right, not-yet-implemented reason) before any implementation, then GREEN. No TDD violations.

## Reachability

All four are **contract-foundation slices — reachable via the schema registry / freeze tests / parity guards; production producers + consumers land downstream** (stated at each Step 7.5, orchestrator-accepted):
- #15 Task/TaskRepository/FailureClass — the FailureClass members are reachable now via `defaultSeverityForFailureClass` (production §16 health path) + `broker.ts:450`; Task/TaskRepository production driver wiring = 13.16.
- #21/#37 UI-safe types — consumed by desktop 9.9/9.8/9.5 + the 13.16 renderer surface; produced by the worker `query.calendar`/`deriveChangeId`/approvals/task-rollup projections.
- #26 ProviderId — consumed by provint's `research-provider.ts` (13.13-impl, task #34, in progress) + the broker routing + processor allowlist (§ARM-RESEARCH).
- No tested-but-unwired gaps introduced (all are dormant-by-design contract shapes; downstream wiring is the named follow-up).

## Open follow-ups

**Cross-doc invariant changes — flagged at Step 9, orchestrator writes at `/orchestrate-end` (single-track; commits stagger by design):**
- ARCHITECTURE.md Appendix A — `Task` seam-model row + the 4 new HealthItem `FailureClass` members (#15); the 2 new `ProviderId`s + egress-cloud posture, §7 RES-1 "Contract note" stale-list fix (#26).
- `packages/contracts/CLAUDE.md` cross-doc table — `Task` row + FailureClass members (#15); the 2 new ProviderIds (#26). UI-safe types (#21/#37) confirmed NOT in the cross-doc table (no row owed).
- §DEC-CAT4 "PENDING" plan text reconciliation (security members already exist) — #15 F2.
- §ARM-RESEARCH ledger — **the structural invariant: perplexity/xai MUST NEVER enter `LOCAL_PROVIDERS` (policy/processors.ts:15)** — doing so reclassifies a cloud provider as loopback-local and re-opens the veto (#26 security-review catch; orch confirmed captured).

**Convention lessons (bank at `/orchestrate-end`):** new Appendix-A model = the full set in one round incl. the seam fixture + `ZOD_BY_ID` + membership-guard (#15); a new egress-classed provider = enum + regenerate ALL embedding schemas [survey empirically] + membership + rule-5 contract-surface test, fail-closed-by-construction via the veto's local-allowlist (#26); UI-safe projection types = additive `.strict()` + generic/priority-unset-representable + WS-8-no-workspaceId + array `.max()` flood-bound, contract-first (#21/#37).

**Future TODO (belongs to a phase):** 13.16 worker task-rollup producer + renderer highest-priority-tasks surface; provint 13.13 research-provider impl + egress-leakage eval; the deferred changeId tightening + degraded-mode flip.

## Notes

- **Territory clean:** every commit staged only contracts/domain/db + the sanctioned `healthItem.ts`/`broker.ts` tsc-fixes; the many concurrent cross-tree reds (worker #20/#28, retrieval #22/#33/#35, the anti-corruption count-pin 20-vs-19 owed by provint #34→evalsec) were each diagnosed foreign, never contract-track ripple.
- **Reviews:** dual reviewers per slice; **0 critical/high across all four**; #21 and #26 finished at 0 total security findings; #37 security 0 findings.
