# Session 045 — the real dashboard, Arc R: audit-driven recent-changes (R1–R4)

- **Date:** 2026-07-06 · **Track:** solo (contract + db + worker + knowledge) · **HEAD:** `bd344d0` → `534c7ed`.
- **Owner direction:** "C6 then the real dashboard." C6 skill introspection landed (session 044). For the dashboard,
  the owner chose the **canonical, heavier paths** (AskUserQuestion): Projects = the typed Project model;
  Recent-changes = **audit-driven, adding `workspaceId` to the frozen `AuditRecord`**. This session builds the
  **Recent-changes arc's deterministic core (R1–R4)**. Plan: `~/.claude/plans/snazzy-honking-stearns.md`.
- **Gate:** repo-wide `pnpm -w turbo run typecheck test` **31/31**. Dual-reviewer on the R1–R4 surface.

## The reframe (why this shape)

Exploration showed the dashboard **read path is already real** (renderer → tRPC `query.recentChanges` →
`readModel.ts` → `read_models` table, WS-8 enforced at 3 layers). The gap is the **producer**: the only writer of
`read_models[recent_changes|project_dashboards]` is the dev-only, flag-gated `provisionDev.ts`. So the work is to
make the producer real. Recent-changes was blocked (session 023) on two things: `AuditRecord` had no `workspaceId`,
and audit rows are generated only under Temporal. This arc clears the **workspaceId** blocker + builds the pure
projector; the **Temporal-gated always-on wiring (R5) is deferred**.

## What shipped — Arc R deterministic core (4 slices, TDD, per-slice commit)

- **R1 `66c3bde` — `AuditRecord.workspaceId` (optional) [frozen-contract round].** Added an OPTIONAL `workspaceId`
  (plain string, brand-free — Lesson §1 purity; optional per the EventLog/LogRecord precedent, because the
  Tool-Gateway external-write audit has no workspaceId in scope). Same-round: `audit-record.snap` + regenerated
  `audit-record.schema.json` (in properties, absent from required) + `ARCHITECTURE.md` Appendix A + the
  contracts `CLAUDE.md` invariants row. +3 tests; contracts 635/635.
- **R2 `596ff7f` — audit table column + query filter [dual-dialect].** Nullable `workspaceId: text()` on the audit
  table (both dialects; no sentinel — an append-only log stores NULL honestly for global events, unlike the
  approvals 0001 NOT-NULL sentinel) + a clean `0002_audit_workspace_id` migration (drizzle-kit, both dialects) +
  `operational-schema.snap` + `AuditQuery.workspaceId` equality filter in both adapters (a NULL-workspace row is
  excluded from a scoped query — the WS-8 posture). New repo-contract round-trip+filter test (both dialects); DB
  334 green.
- **R3 `175c9c2` — populate `workspaceId` at the append sites.** The two KnowledgeWriter semantic-write audits
  (the real "changes"): commit (`buildCommitAuditRecord` gains an optional workspaceId, folded only when present;
  the writer passes `plan.workspaceId`) + tombstone (`command.workspaceId`). **Deferred:** the worker-composition
  disposition audit + the Tool-Gateway external-write audit (the latter has no workspaceId in scope by design —
  stays honestly NULL/global). Knowledge 349 green.
- **R4 `534c7ed` — the pure `projectRecentChanges` projector.** `AuditRecord[] → {changes: UiSafeRecentChange[]}`,
  scoped to one workspace; the deferred real projector session 023 anticipated (reuses its `collapseToSummaryLine`).
  **WS-8 fail-closed** at two layers (foreign OR null-workspace record dropped; an empty served scope → empty feed,
  never an unscoped dump). **Lesson §5 redact-by-type**: `kind`/`summary` derive ONLY from the controlled `event`
  vocabulary (never the free-text before/after summaries or payloadHash); `changeId` = an opaque
  U+0000/U+0001-delimited sha256 of the record's identity. safeParse-gated, sorted newest-first by parsed instant.
  13 tests.

## Reviews (dual, on the R1–R4 surface)

- **security-reviewer: 0 crit / 0 high / 0 medium** (3 lows). WS-8 verified adversarially at both the DB filter
  (NULL/foreign excluded by SQL NULL semantics) and the projector (foreign+global dropped); redaction is strict
  redact-by-type from a controlled vocabulary with a hashed opaque `changeId`. The load-bearing **low** — the
  projector must reject an empty served scope — was **fixed in-slice** (`if (!workspaceId) return {changes:[]}`).
  Deferred lows: `UiSafeRecentChange.kind` has no single-line refine (contract-track, note); no projector self-cap
  (DB query is limit-bounded).
- **code-quality-reviewer: 1 HIGH + 3 MED found, all fixed in-slice.** HIGH: the event key was `knowledge.committed`
  but the real emitted event is `knowledge_writer.commit` (revision.ts) — corrected + the event map expanded to all
  4 real audit events (`knowledge_writer.commit/.tombstone`, `ingestion.triage.disposition.recorded`,
  `external_write.created`). MED: lexicographic sort → parsed-instant (`Date.parse`); the test fixture used the wrong
  event literal → corrected; missing fallback-branch tests → added (unmapped-safe, unsafe/malformed, empty-scope,
  real-events). LOW (changeId boundary-shifting) → fixed with the control-char delimiters.

## Deferred (Temporal-gated) — R5

- **R5 always-on wiring:** wire `projectRecentChanges` to write `recent_changes` rows as real audit appends happen
  (replacing the dev-only `provisionDev` recent-change seed). Waits on Temporal running + observed real audit
  generation. The pure core is done + fully tested; only the activation waits.

## Docs reconciled

`IMPLEMENTATION_PLAN.md` (§9.5 recent-changes note) · memory `sow-dashboard-real-producers` (new) · handoff
`docs/team-handoffs/001-2026-07-06-ws8-scoping-resume.md` (RESUME block).

## NEXT (owner-directed) — Arc P: the typed Project model

- **P1** the `Project` frozen seam contract (frontmatter + bi-temporal timeline + lifecycle enum) + `project_capture`
  on `ProvenanceOrigin` [frozen-contract, additive]. **P2** the 7th state machine `packages/domain/src/state/project.ts`
  (`idea→planning→active→…`, `defineMachine` convention). **P3** the concrete projectSync→dashboard seam (a real
  `UiSafeProjectDashboard` from `SyncOutputsProjection` + a concrete `ProjectSyncUpdateDashboardPort` upserting
  `read_models[project_dashboards]` + a concrete `ValidateNarrativePort` wrapping `validateNoInference`). **P4**
  activation (Temporal-gated, deferred). Full slice detail in the plan file + the P-tasks explorations.
- Sub-forks the P1 explorer surfaced (decide at Arc-P start): the 7th machine is the ENTITY lifecycle (not the
  existing `projectSyncMachine` run lifecycle); canonical state = frontmatter-only (invariant-clean) vs an
  operational mirror column; `UiSafeProjectDashboard.status` free-string vs typed enum (a 2nd frozen change +
  desktop coordination).
