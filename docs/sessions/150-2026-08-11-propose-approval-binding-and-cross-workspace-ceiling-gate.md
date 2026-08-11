# 150 — worker: bind ProposeKnowledgeApprovalPort (13.8i-B) + route the cross-workspace read through the live GCL ceiling (24.17)

**Date:** 2026-08-11
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/144-2026-07-31-meeting-sibling-plans-and-13.8i-b-premise-defect.md`
**Successor session:** _(unwritten — the next worker-implementer)_

---

## Why this session existed

Resumed as `worker-implementer` after a full team teardown (per handoff `021-2026-07-31-full-teardown-resume-prompt.md`), head of queue on two slices in order: (1) `13.8i-B`, which the predecessor session (144) stopped before Step 1 on a false brief premise, fully re-scoped as brief 241 v2; (2) `24.17`, dispatched mid-session as the round's highest-severity (safety rule 4) finding from the 24.6 pre-go-live audit.

---

## What was built

### Slice 1 — 13.8i-B: bind `ProposeKnowledgeApprovalPort` on both living-vault paths

Brief `docs/briefs/241-13.8i-B-…md` v2. Independently re-verified all three RESOLVED premises against live code (file:line exact matches) before building, and resolved the brief's one deliberately-unruled design question via Step 2.5 with main-orchestrator: **widen** `ProposeKnowledgeApprovalErrorCode` to `"mint_failed" | "not_armed"` (not reuse `mint_failed`) — the driver already distinguished unbound-from-rejected before this slice, so widening preserves an existing distinction rather than adding an unowed one. One ADD from orchestrator review: pin that the "default boot mints zero cards" guarantee rests on upstream living-vault dormancy, not on this port's absence (a genuine shift in the guarantee's basis, since this slice binds the port unconditionally with no separate arming flag).

**Files modified:**
- `apps/worker/src/boot.ts` — new `withProposeKnowledgeApproval` post-processor (unconditional bind, no arming flag; states in-code "there is no second propose-side gate"), wired last in the `proofSpineParams` composition chain.
- `apps/worker/src/composition/buildActivities.ts` — new `proposeKnowledgeApproval?` field on `ProofSpineParams`; two new activities `sourceProposeKnowledgeApproval`/`meetingProposeKnowledgeApproval`, both delegating to the SAME port instance (mirrors the `meetingCommit`/`sourceCommit` per-path-naming convention).
- `apps/worker/src/composition/living-vault.ts` — new `createProposeKnowledgeApprovalActivity`: mirrors `createLivingVaultActivity`'s SHAPE (L59) but not its `ok([])` return — the unarmed branch is a typed `not_armed` err, never `ok(...)` (would be a false proof of a durable write) and never a throw.
- `apps/worker/src/temporal/workflows.ts` — both `sourceIngestionWorkflow`/`meetingCloseoutWorkflow` construct the propose-approval proxy unconditionally (mirrors the `livingVault` proxy pattern — the Temporal sandbox cannot read boot config).
- `packages/workflows/src/ports/sourceIngestion.ts` — `ProposeKnowledgeApprovalErrorCode` widened; new exported `proposeApprovalSurfaceInfo` helper (extracted during Step-9 code-quality review to remove byte-identical duplication between the two drivers, mirroring the existing `commitFailureClass` export precedent, contracts L119).
- `packages/workflows/src/workflows/sourceIngestion.ts` + `meetingCloseout.ts` — route `not_armed` → the existing frozen `write_through_blocked` FailureClass (zero taxonomy expansion — an exact semantic match found in `shared-enums.ts:150-155`, task 13.15), everything else → `write_through_failed`.
- Tests: `apps/worker/test/living-vault-propose-approval.test.ts`, `apps/worker/test/composition/proposeKnowledgeApprovalBinding.test.ts` (new), `packages/workflows/test/source-living-vault-binding.test.ts`, `packages/workflows/test/meeting-closeout.test.ts`.

**Commit:** `fdbc2c85a5e7d5ef8a3bdc3cb26c611e291f6503`.

**Tests:** 9 new (RED-confirmed before GREEN — see TDD compliance). Full suites: `@sow/workflows` 605/605, `@sow/worker` 2070/2070, repo-wide `pnpm -w typecheck` 20/20 clean.

**Mutation-verified:** (1) the `not_armed`→`write_through_blocked` / else→`write_through_failed` branch — one mutation on the shared helper reds BOTH drivers' tests, confirming they're genuinely wired to it, not independently duplicating it. (2) the activity's `not_armed`-never-`ok` pin — mutating it to `ok(...)` reds the activity test. Both reverted, confirmed clean via `git diff --stat`.

**Reviews:** security-reviewer (mandatory, invariant-touching): 0 findings across all 8 verified invariants (no second writer, no candidate-data leak, WS-8 scoping, `write_through_blocked` confirmed pre-existing, default-boot dormancy traced through the real driver loops). code-quality-reviewer: 4 findings, 0 high — 1 medium fixed in-slice (the duplicated failureClass/reason logic → `proposeApprovalSurfaceInfo`), 3 flagged-not-fixed per the reviewer's own recommended action (`step-9-flag`): duplicated hand-rolled test fakes across 3 files with no shared support module; the composition-root wiring (`buildActivities.ts`→`temporal/workflows.ts`) has no swap-discriminating test (orchestrator recorded as a task, sharpened severity down since both activities currently delegate to the identical port instance — behaviorally inert today); a minor test-readability nit (deferred).

**Self-caught during Step 9 fix:** the `proposeApprovalSurfaceInfo` extraction initially broke `tsc -p tsconfig.build.json` (a cross-statement type-narrowing pattern that only held inside the ORIGINAL inline call site's enclosing `if`/`else` didn't survive extraction into a standalone function) — `vitest` did not catch it (it doesn't typecheck). Rewrote using an explicit `if`/`else` that narrows correctly on its own, re-ran the full repo-wide typecheck (20/20 clean) before calling it done. Banked by the orchestrator as contracts L129.

### Slice 2 — 24.17: route the cross-workspace read through the real GCL Visibility Gate

Brief `docs/briefs/245-24.17-…md`. **SAFETY RULE 4** — the highest-severity finding from the 24.6 audit. Independently re-verified all 6 VERIFIED premises and resolved all 4 UNVERIFIED items myself at Step 2.5 (including correcting one file-path error in the brief itself, `activities/buildGclProjection.ts` not `activities/projections/buildGclProjection.ts`). Chose Option (i) semantics but landed on a design the orchestrator explicitly praised as more precise than either the brief or the audit finding: **the link's frozen `scopeVisibilityLevel` and the source workspace's LIVE `defaultVisibility` are TWO INDEPENDENT gates, neither replacing the other** — not a collapse-to-one-implementation as originally framed (`ApprovedLink` in `@sow/policy`, initially suspected to be a second representation of the same link, turned out to serve an entirely unrelated mechanism — the direct-raw-retrieval hard denial — never exercised by this path at all).

**Files modified:**
- `apps/worker/src/composition/crossWorkspaceRead.ts` — the primary fix. Fetches the source workspace fresh per link (`deps.workspaceConfig.get(link.toWorkspaceId)`, new dep), defensively pre-checks the returned id (worker L55) and `defaultVisibility` shape, then routes every scope-matching row through `@sow/knowledge`'s `serveProjection` (ajv + Zod + the §5 ceiling) instead of a bare schema parse. Return type widened from a bare `readonly GclProjection[]` to `CrossWorkspaceReadOutcome { projections, visibilityExceededCount, workspaceCeilingUnavailableCount }` — the orchestrator's ADD: both withheld paths (a row exceeding the live ceiling; a link whose ceiling couldn't be evaluated) are counted rather than silently dropped, rule-7-safe (counts only, never content/path/id).
- `packages/workflows/src/activities/buildGclProjection.ts`, `activities/scopedRetrieval.ts`, `ports/dailyBrief.ts`, `ports/copilotQa.ts` — corrected four prose comments that asserted the GCL Visibility Gate was live/wired when nothing calls it; each now names the actual live gate (`crossWorkspaceRead.ts`) a future implementer should mirror, per the orchestrator's "don't replace wrong with vague" instruction.
- Tests: `apps/worker/test/composition/crossWorkspaceRead.test.ts` (9 pre-existing tests mechanically updated for the new wrapped return shape; 9 new).

**Commit:** `004ad65c2f5db8c23fb097e059800113d7b01c6d`.

**Tests:** 18 total. `crossWorkspaceRead.test.ts` 18/18; repo-wide `pnpm -w typecheck` 20/20 clean (run explicitly, not just the suite, per the orchestrator's nudge from the prior slice's L129 lesson).

**Mutation-verified, four separate properties:** (1) reverting to the frozen-scope-only comparison reds the load-bearing governing-state test + its non-vacuity partner + the raw-content test. (2) bypassing the fault/id-mismatch/malformed-default guard reds the counter test AND the L55 id-mismatch test — and reveals defense-in-depth: `serveProjection`'s own internal check still catches the id-mismatch case even without the pre-check, just via the harsher whole-read-abort path instead of the intended link-scoped skip. (3) and (4), added after code-quality review surfaced the gap: changing either the per-link or the per-row `continue` to `break` reds two new composed-case tests with exactly the predicted undercounts. All four reverted, confirmed clean via `git diff --stat`.

**Reviews:** security-reviewer (mandatory): 0 findings across 8 verification axes, independently confirmed the `malformed_policy_input` unreachability claim by reading `validateProjectionVisibility` itself and used codegraph to confirm zero production callers were introduced. code-quality-reviewer: 3 findings — 1 medium fixed (no test drove a single call combining two links or two same-link rows, so a `continue`-written-as-`break` regression would go uncaught; added and mutation-verified two composed-case tests), 1 low fixed (two doc sites under-enumerated the counter's own sub-causes), 1 low deferred per the reviewer's own recommendation (a comment names 2 of 4 exclusion reasons for an unreachable branch; the other 2 are excluded by the TS type contract, not either named runtime guard — assessed correct in substance by both reviewers, just imprecise wording).

---

## Decisions made

- **13.8i-B: bind the propose-approval port UNCONDITIONALLY at boot, no separate arming flag.** The zero-cards guarantee rests entirely on `livingVault`/`meetingVault` staying dormant (empty plan sets), not on this port's absence — confirmed safe and orchestrator-ruled "not an arming crossing."
- **13.8i-B: widen the error enum rather than reuse `mint_failed`.** Orchestrator ruling, reversing my own initial recommendation — the driver already distinguished unbound-from-rejected, so widening preserves a live distinction rather than manufacturing an unowed one.
- **13.8i-B: `write_through_blocked` (existing frozen FailureClass) for `not_armed`, not a new taxonomy member.** Found by checking the actual enum rather than assuming a new member was needed.
- **24.17: two independent gates (link scope + live workspace ceiling), not a collapse to one implementation.** The brief's initial framing ("collapse vs keep-both-and-agree") turned out to be the wrong fork entirely once `ApprovedLink` was confirmed to be an unrelated mechanism — orchestrator recorded my reframing as more precise than either the brief or the original audit finding.
- **24.17: both withheld paths are COUNTED, never silently `continue`d without a trace** (the orchestrator's ADD) — a `visibility_exceeds_source` on a stored row is genuinely ambiguous between a benign tightened ceiling and the tampered-row case `serveProjection` exists to catch; the count is the signal to investigate, not a verdict.
- **24.17: `malformed_policy_input` handled defensively via the same whole-read-abort path as raw-content/schema rejections, not a dedicated branch** — since two upstream guards make it unreachable at this call site by construction, adding a third explicit branch for dead code would be unowed complexity.

## Decisions explicitly NOT made

- **13.8i-B: the exact shared-test-fixture extraction for the 3 duplicated fake-repo implementations** (`apps/worker/test/composition/proposeKnowledgeApprovalBinding.test.ts`, `living-vault-propose-approval.test.ts`, `copilotProposeKnowledgeSink.test.ts`) — flagged at Step 9 per the code-quality reviewer's own recommended action, not built; would touch a third file outside this slice's stated scope.
- **13.8i-B: a swap-discriminating test for the `buildActivities.ts`→`temporal/workflows.ts` composition-root wiring** — judged this would need either mocking `@temporalio/workflow`'s `proxyActivities` or a full `TestWorkflowEnvironment`, neither done anywhere in this codebase for any of the other per-path-named activity pairs either; systemic pre-existing gap, not new to this slice. Orchestrator recorded as a task and sharpened its severity down (the swap is behaviorally inert today since both activities delegate to the identical port instance).
- **24.17: wiring `resolveApprovedCrossWorkspaceSlice` to any consumer.** Explicitly forbidden by the brief — Step 7.5 is `"none — consumer lands in 25.2/25.4"`; building a consumer here would arm a cross-workspace read path inside a hardening fix.
- **24.17: tightening the "unreachable by construction" comment to cite all 4 of `validateProjectionVisibility`'s malformed-input branches** (2 are excluded by the named runtime guards, 2 by `GclProjection`'s TS-required-field contract) — deferred per the code-quality reviewer's own recommendation; assessed correct in substance, just imprecise wording.

## TDD compliance

**13.8i-B: clean.** Every new test file edit was made and run (confirming genuine RED — `is not a function` errors for the not-yet-existing `createProposeKnowledgeApprovalActivity`/`withProposeKnowledgeApproval`) BEFORE the corresponding production code existed. GREEN confirmed after. Load-bearing pins mutation-verified post-GREEN. No violations.

**24.17: a disclosed deviation, mitigated by mutation-verification (contracts L107's shape).** The primary fix's production code (`crossWorkspaceRead.ts`'s rewrite) and its new test assertions were written in the same pass rather than red-first — I did not confirm the new ceiling-check tests failed against the pre-fix code before implementing. This was NOT true red-first TDD for the core fix. Mitigated the same way L107 describes: mutation-verification proves DISCRIMINATING POWER (four separate mutations, each correctly reds exactly the tests that should catch that specific regression), which substitutes for red-first's proof that a test wasn't derived from the implementation it's meant to catch — but does not fully substitute for red-first's independent-authorship guarantee. The two composed-case tests added during Step 9 review were similarly written and passed immediately, then mutation-verified (not red-first). Flagging explicitly rather than characterizing either slice as uniformly clean.

## Cross-doc invariant audit

Checked `packages/contracts/CLAUDE.md`'s Cross-doc invariants table (29 frozen Appendix-A models) against both slices' changes. **None touched.** `ProposeKnowledgeApprovalErrorCode`/`CrossWorkspaceReadOutcome`/`proposeApprovalSurfaceInfo` are all worker-composition-internal or workflow-port-internal types (mirrors 13.8f-B's established precedent: port-internal types carry no Appendix-A row, no snapshot owed). `git diff -- ARCHITECTURE.md` confirmed no uncommitted hot doc edit exists either. No violation; no doc edit owed.

## Reachability

- **13.8i-B:** `sourceProposeKnowledgeApproval`/`meetingProposeKnowledgeApproval` reachable via `sourceIngestionWorkflow`/`meetingCloseoutWorkflow`, both real Temporal-registered production workflows (same reachability tier as the pre-existing `sourceLivingVaultRewrite`/`meetingCommit` activities they mirror).
- **24.17:** `resolveApprovedCrossWorkspaceSlice` — **deliberately NOT wired to any consumer** (Step 7.5: "none — consumer lands in Phase 25.2/25.4"), a reachability-waived state per Lesson 11, confirmed zero callers exist by both this session's own grep and both reviewer subagents' independent codegraph checks.

## Open follow-ups

1. **13.8i-B — shared test-fixture extraction** for the 3 duplicated fake-repo implementations (`ApprovalRepository`/`PendingKnowledgeMutationRepository`/`WorkspaceConfigRepository` fakes) across `proposeKnowledgeApprovalBinding.test.ts`, `living-vault-propose-approval.test.ts`, `copilotProposeKnowledgeSink.test.ts`. No shared support module exists in `apps/worker/test/`. Orchestrator-flagged, not yet a numbered task as of this session's end.
2. **13.8i-B — the composition-root wiring gap** (no swap-discriminating test for `buildActivities.ts`'s two propose-approval activity registrations feeding `temporal/workflows.ts`'s two proxies). Orchestrator recorded as a task; systemic across every per-path-named activity pair in the file, not specific to this slice.
3. **13.8i-B side finding (packages/integrations/src/health/health-signal.ts's stale `write_through_blocked` citation-rot comment)** — routed to providers-integrations as task `24.16`; **already landed this same round** (commit `0de758d1` per the shared git log), no longer open.
4. **24.17 — the "unreachable by construction" comment's precision** (names 2 of 4 exclusion branches). Deferred per the code-quality reviewer's own recommendation; low severity, correct in substance.
5. **24.17 blocks Phase 25.2/25.4's read consumer** (unchanged from the brief) — the natural next step once that phase is scheduled, not this session's territory.
6. **Both slices' commits already landed individually** (`fdbc2c85`, `004ad65c`) — nothing left uncommitted from this session except this doc.
