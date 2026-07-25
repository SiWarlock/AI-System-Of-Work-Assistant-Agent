# /tdd brief — uisafe_projection_types_desktop_unblock

## Feature
Three **additive** UI-safe projection types (in `packages/contracts/src/api/ui-safe.ts`) that unblock the remaining Phase-9 desktop surfaces — a **UiSafe schedule/calendar** type (9.9 Calendar), **`UiSafeApproval` + `targetSystem` + `workspaceId`** (9.8), and an **opaque `changeId`** on `UiSafeRecentChange` (9.5). All additive, UI-safe-only (no raw content / secrets / raw cross-workspace detail), **no frozen Appendix-A snapshot change** (these are API projection types, not canonical models).

> **Widens phase scope because** it defines the `§5` UI-safe-projection contracts + `§10` read-model-serving shapes behind the Phase-9 `§11` surfaces — the contract leg the desktop 9.9/9.8/9.5 slices consume.

## Use case + traceability
- **Task ID:** 9.9, 9.8, 9.5
- **Architecture sections it implements:** `ARCHITECTURE.md §5` (renderer renders ONLY UI-safe projections — the redaction boundary) · `§11` (the Calendar / Approvals / Recent-Changes surfaces) · `§10` (read-model serving shapes).
- **Related context:**
  - These types are the **contract leg** the free contract-implementer lands so the idle desktop track can then build 9.9/9.8/9.5. The renderer consumes UI-safe projections only; the worker procedures produce them (both downstream slices, not here).
  - **9.9 UiSafe schedule/calendar type:** `READ_MODEL_KEYS` has no schedule/calendar key today; the 9.20 "honest-empty schedule" is a hardcoded literal. 9.9 needs a UI-safe schedule type carrying busy/free + **generic conflict explanations only — NEVER raw cross-workspace event detail** (Flow 3 / REQ-F-009); availability via the GCL projection, never a blended raw calendar read.
  - **9.8 `UiSafeApproval` enrichment:** add `targetSystem` + `workspaceId` (the payload editor + workspace attribution need them). `edit` verb already maps server-side; this is the type the renderer editor binds.
  - **9.5 opaque `changeId`:** add an opaque worker-mediated ref to `UiSafeRecentChange` for the audit-link affordance — a SHA-256-over-identity string (worker derives via `deriveChangeId`; the contract just types it as an opaque string the renderer never interprets). Shares the opaque-ref pattern with 9.10 Leg D (health-item audit-ref).

## Acceptance criteria (what "done" means)
- [ ] A new UI-safe schedule/calendar projection type in `ui-safe.ts` — busy/free + generic conflict explanation fields; **carries NO raw cross-workspace event detail** (a test pins that no raw title/attendee/body field exists on the type; generic-explanation only).
- [ ] `UiSafeApproval` gains `targetSystem` + `workspaceId` (branded `WorkspaceId`), additive — existing consumers still compile; a test pins the new fields validate + reject raw over-population.
- [ ] `UiSafeRecentChange` gains an opaque `changeId` string field — typed as an opaque worker-mediated ref (NOT a raw `auditRef`); a test pins it's a plain string with no interpretable structure required of the renderer.
- [ ] All three are `.strict()` / UI-safe (no raw content, secrets, prompts, or raw cross-workspace detail); the renderer-redaction posture holds (rule #7 / forbidden-pattern #5).
- [ ] **No frozen Appendix-A snapshot change** — confirm these UI-safe projection types are NOT snapshot-frozen canonical models (per lead); if any turns out to touch a frozen schema, STOP and flag at Step 2.5 (it would change the round's nature).
- [ ] All unit tests in `packages/contracts/test/api/…` pass; repo-wide `turbo typecheck` green (additive, should not break consumers); `/preflight` clean.

## Wiring / entry point (Step 7.5)
**none — consumers land downstream:** the desktop 9.9 Calendar surface + 9.8 Approvals editor + 9.5 Recent-Changes audit-link consume these types; the worker `query.calendar` proc / `deriveChangeId` / approval projection PRODUCE them. This slice defines the contract shapes only. State this explicitly.

## Files expected to touch
**Modified:**
- `packages/contracts/src/api/ui-safe.ts` — the 3 additive types/fields.
- `packages/contracts/src/index.ts` — barrel export any new type.
- `packages/contracts/test/api/…` — validators + additive-field tests.

If any of these turns out to require a frozen `schemas/*.json` / snapshot change, **flag at Step 2.5** — the lead scoped this as additive-no-snapshot.

## RED test outline (Step 2)
1. **`uisafe_schedule_carries_no_raw_cross_workspace_detail`** — the schedule type has generic-conflict/busy-free fields only; a test asserts no raw title/attendee/body field. Why: §5 / REQ-F-009 (generic explanations only).
2. **`uisafe_schedule_valid_shape_roundtrips`** — a valid busy/free + generic-conflict projection validates. Why: §11 Calendar surface.
3. **`uisafe_approval_targetsystem_workspaceid_additive`** — `UiSafeApproval` with the new fields validates; without them (existing shape) still validates additively. Why: additive, no consumer break.
4. **`uisafe_recentchange_changeid_opaque_string`** — `changeId` validates as an opaque string; not a raw `auditRef`. Why: rule #7 opaque-ref.
5. **`uisafe_types_reject_raw_overpopulation`** — a poisoned instance carrying a secret/raw field is rejected (`.strict()`). Why: forbidden-pattern #5.

## Cross-doc invariant impact (implementer flags at Step 9; orchestrator writes the docs)
- **Model field changes:** additive UI-safe projection fields (`UiSafeApproval` +2, `UiSafeRecentChange` +1, new schedule type). **No frozen Appendix-A canonical model change.**
- **Orchestrator doc rows to write hot:** if `ui-safe.ts` types appear in the `packages/contracts/CLAUDE.md` cross-doc table, add/adjust the rows (flag at Step 9). Otherwise none.
- **§2.5-seam model touched?** These are API projection types (not §2.5 canonical seam models); confirm no `schemas/ui-safe*.json` snapshot exists to bump (if one does → Step 2.5 flag).

## Things to flag at Step 2.5
1. **UiSafe schedule type shape.** My default vote: `{ workspaceId, entries: [{ start, end, busy: boolean, conflictExplanation?: string /* generic only */ }], … }` — busy/free windows + a GENERIC conflict string, NO raw event detail. Confirm the exact field set against the GCL projection the availability sources from.
2. **`UiSafeApproval.targetSystem` type.** My default vote: a closed enum (or a UI-safe string) of the external target systems; `workspaceId` a branded `WorkspaceId`. Confirm the `targetSystem` vocabulary.
3. **`changeId` typing.** My default vote: an opaque `string` (the SHA-256 derive is worker-side, out of scope here); the contract types it as a plain opaque ref the renderer passes back verbatim. Confirm no structured typing is wanted.
4. **Snapshot check.** My default vote: confirm NO `schemas/ui-safe*.json` / snapshot is frozen for these types (per lead: additive-no-snapshot). If one exists, flag — it changes the round.

## Dependencies + sequencing
- **Depends on:** ARC-2 (13.15 — landed `54b052a7`); the existing `ui-safe.ts` surface.
- **Blocks:** desktop 9.9 (Calendar), 9.8 (Approvals editor), 9.5 (audit-link) → `/phase-exit 9`. These are the idle desktop track's next slices.
- Independent of worker's 11.2 / 9.10 queue.

## Estimated commit count
**1** — three additive UI-safe types in one file, no safety invariant, no frozen-snapshot; one logical "unblock desktop Phase-9" unit. code-quality-reviewer (every-slice) suffices; security-reviewer not required (no safety-invariant touch — these TIGHTEN the UI-safe surface).

## Lessons-logged candidates anticipated
- **Convention candidate** — "UI-safe projection types are additive + `.strict()` + carry generic-only (never raw cross-workspace) detail; defined contract-first to unblock the consuming surface + producing procedure."
- **Architecture-doc note** — the schedule type's generic-conflict-only invariant (Flow 3 / REQ-F-009) — consumers depend on no-raw-cross-workspace-detail.

## How to invoke
1. Read end-to-end — Step-2.5 Q1/Q4 (schedule shape + snapshot check) need answers before GREEN.
2. Run `/tdd uisafe_projection_types_desktop_unblock`.
3. ⚠ **Routing note:** the current orchestrator (`main-orchestrator-2`) is cycling at the round seal — **Step-2.5 + Step-9 for this brief route to the FRESH orchestrator** (the lead will name it on spawn). If in doubt, address the orchestrator role via the task + await the fresh orch's review.
