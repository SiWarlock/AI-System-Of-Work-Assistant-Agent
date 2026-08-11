# /tdd brief — desktop_operator_guard_comment_and_9.40_stale_comments

## Feature
Comment-only edit, no behavior change. Update the operator-guard comment at `apps/desktop/worker-host/index.ts:178` so it describes the SHIPPED enforcement mechanism (`24.12`'s structural workspace-path guard, landed `c86030f9`) instead of claiming operator discipline is the enforcement — plus fix the two stale comments left over from `9.40`'s deleted proposal-row mechanism.

## Use case + traceability
- **Task ID:** `24.27`
  (filed 2026-08-11 to give a recorded residual item — lead-ruled acceptance-bearing on block-release condition (a) — a real task number instead of a bare cross-reference; see task 24.27's full text for the originating remedy)

> **This brief widens phase scope because Phase 24 is a cross-cutting hardening/audit-remediation phase — its tasks originate from the 24.6 safety-assertion audit, which sweeps every area, so a remediation task legitimately cites the anchor its originating finding lives under (here, §16) rather than only Phase 24's own declared set.**
- **Architecture sections it implements:** none new — this brings a comment in line with already-shipped, already-documented behavior (§16, safety rule 4, per `24.12`).
- **Related context:** `IMPLEMENTATION_PLAN.md:2991` (24.12's full residual text — read this first, it states the exact constraint). `24.12` shipped `c86030f9` (knowledge, `packages/knowledge/src/knowledge-writer/workspace-path-guard.ts` + a pipeline step in `applyPlan`). The 9.40 stale comments: `apps/desktop/test/copilot-panel.test.tsx:478` and `:487` — leftover references to the proposal-row mechanism `9.40` deleted (`d5e987d4`), origin: your own session doc `147`'s close-out note ("desktop idle close-out, 9.42 blocked on providers, 24.12 has no desktop leg" — this brief is what unblocks that idle state now that `24.12` has landed).

## Acceptance criteria (what "done" means)
- [ ] `apps/desktop/worker-host/index.ts:178`'s comment (around the `copilotLegacyContentPolicy: { mode: "assign", toWorkspaceId: workspaceId("personal-business") }` construction) no longer implies operator discipline is what prevents cross-workspace content leakage through the `assign` bridge — it states that `packages/knowledge/src/knowledge-writer/workspace-path-guard.ts` (landed `c86030f9`) is the structural enforcement, and that this constant is the value the guard's `LEGACY_UNPREFIXED_WORKSPACE_ID` currently duplicates (cross-reference `24.26`, filed 2026-08-11, which is the tracked fix for that duplication — name it in the comment so a future reader isn't left rediscovering the drift).
- [ ] ⛔ **Do NOT relocate this into a typed opt-in flag** — `24.12`'s own text rules this out explicitly (`IMPLEMENTATION_PLAN.md:2991`): "it is NEITHER structural enforcement NOR a detector — it is a BETTER COMMENT," and a flag doesn't change what it is. This slice is a comment edit, full stop.
- [ ] `apps/desktop/test/copilot-panel.test.tsx:478` and `:487` no longer reference the deleted proposal-row mechanism (`9.40`, `d5e987d4`) — read the current test file first to see what's actually there now (the mechanism may already be gone from the test body itself, with only the comments stale).
- [ ] `/preflight` clean (this must not regress `apps/desktop/test/bundle/main-bundle-resolution.test.ts` — per `24.25`'s now-closed disposition, that failure is established environmental/L83; if it recurs, cite L83 per the new convention rather than re-filing blind).

## Wiring / entry point (Step 7.5)
None — comment-only, no behavior change, nothing to wire.

## Files expected to touch
**Modified:**
- `apps/desktop/worker-host/index.ts` (comment only, line ~178)
- `apps/desktop/test/copilot-panel.test.tsx` (comments only, lines ~478, ~487)

## RED test outline (Step 2)
None — this is a comment-only change with no testable behavior. Skip Step 2's RED/GREEN cycle; go straight from Step 1 (confirm files) to the edit, then `/preflight` as the verification gate.

## Cross-doc invariant impact (implementer flags at Step 9; orchestrator writes the docs)
- **Model field changes:** none.
- **Orchestrator doc rows to write hot:** none.
- **§2.5-seam (shared-contract) model touched?** <!-- spec-lint:mention --> No.

## Things to flag at Step 2.5
1. **Should the comment cite `24.26` by task number, or just describe the drift in prose without a task-number citation that could go stale?** My default vote: **cite `24.26` by number** — this project has repeatedly found that a prose-only pointer ("see the other place this value lives") degrades into an unmappable bare reference once nobody remembers which task that was (Carry-forward's own `a5` finding on bare `#N` references); a task number is checkable, a vague cross-reference isn't.

## Dependencies + sequencing
- **Depends on:** `24.12` ✅ `c86030f9` (landed — this is why the slice is now unblocked).
- **Blocks:** nothing tracked; discharges `24.12`'s residual item (2).

## Estimated commit count
**1.** Comment-only, single focused edit across two files, no safety-critical code change (the code was already shipped by `24.12`).

## Lessons-logged candidates anticipated
- None anticipated — this is closing out an already-diagnosed obligation, not discovering a new pattern. If something surfaces during the edit (e.g. the 9.40 stale comments turn out to hide a real leftover code path, not just prose), flag it at Step 9 as a new finding rather than folding it silently into this slice.

## How to invoke
1. Read this brief + `IMPLEMENTATION_PLAN.md:2991` (24.12's full residual text) + the current state of both target files.
2. Run `/tdd desktop_operator_guard_comment_and_9.40_stale_comments`.
3. Step 1 — confirm the file list; Step 2.5 — answer the one design question; skip Step 2's test cycle (none applies) and go to the edit + `/preflight`.
