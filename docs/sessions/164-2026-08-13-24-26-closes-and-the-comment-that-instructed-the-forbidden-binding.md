# Session 164 — `24.26` closes, and the comment that instructed the forbidden binding

**Date:** 2026-08-13 · **Phase:** 24 (hardening tail) · **Area:** `packages/knowledge` (+ one lead-authorized `apps/desktop` comment fix)
**Predecessor:** `162-2026-08-13-required-from-birth-green-under-both-and-a-notice-that-carries-nothing.md`
**Successor:** _(filled in by the next `/session-end`)_

**Commits:** `46e34ca8` (24.26 step 3 of 3) · `9f9862bd` (the desktop residual, `#55`)

---

## Why this session existed

A second dispatch after `162` closed out: worker's step 2 (`e8ffd7a7`) had landed, so `### 24.26`'s final leg was unblocked. The round had been sealed with the sequence mid-flight — the state the task existed to prevent, and the reason it was filed before step 1 was ever dispatched.

## What was built

**`46e34ca8` — `### 24.26` step 3 of 3, closing the sequence.** `KnowledgeWriterDeps.workspacePathCheck` becomes required; the `?? enforceWorkspacePathScope` fallback and the knowledge-side `LEGACY_UNPREFIXED_WORKSPACE_ID` are deleted; `apps/worker/src/composition/legacy-workspace.ts` survives as the value's single home. Five files, all `packages/knowledge`.

**`9f9862bd` — the desktop residual.** Comment-only, own commit, lead-authorized, **explicitly not precedent**.

## Decisions made

1. **`enforceWorkspacePathScope` deleted, not kept with an inlined literal.** Keeping it would have re-created a module-level home for the exempt id — the defect the task removes. The four test calls were re-pointed at **one** module-scope instance rather than four scattered literals, which answers the reasonable objection to deleting it.
2. **The blast radius was measured, not censused** — and measured twice. See TDD/verification below.
3. **The desktop comment was fixed rather than filed.** Desktop is an unqueued track, so "file it" meant leaving a live instruction to perform the forbidden binding indefinitely.

## Decisions explicitly NOT made

- **No fail-closed guard on the now-required check.** The orchestrator's ruling stands (record, don't guard), but its stated reason — *"a guard would be the deleted fallback wearing a different hat"* — was **refuted** and withdrawn: a fail-closed `err` return admits nothing, whereas the fallback admitted writes under a hardcoded id. They are opposites. Filed as its own task; the false equivalence is recorded in-code so nobody re-derives from it.
- **Nothing else in `apps/desktop`**, including things noticed while in the file.

## TDD compliance

**Clean.** The `@ts-expect-error` pin was written before the flip and verified RED for the right reason. The two behavioural tests (`applyPlan_uses_the_SUPPLIED_exempt_id`, `omitted_workspacepathcheck_runtime_behaviour_is_pinned_not_inferred`) were written before their code existed.

⚠ **One deliberate inversion, not a violation:** the ADD test's *assertion* was measured before it was written, because the orchestrator's instruction was explicitly *"record what you see — do not make it throw, and do not guard it."* Probed first (`TypeError: workspaceScope is not a function`), then asserted. Pinning a measured outcome requires measuring first.

## Verification

- **Typecheck 0 errors across all 11 packages**, measured **per-package**. ⛔ `pnpm typecheck` alone is not sufficient here: turbo halts dependents when a task fails, so it reported the one expected error and then skipped the four packages depending on `@sow/knowledge` (`Tasks: 13 successful, 16 total`). A blast radius read off that run is measured only on the package you changed — the exact direction `L81` warns about.
- Suites: knowledge **749 / 0**, worker **2096 / 0**, workflows **622 / 0**.
- **L81 blast radius: exactly one site** (`workspace-path-guard.test.ts:32`), via a declared two-command window restored byte-identical.
- ⭐ **The type pin is self-blocking:** re-widening the field to optional reds the pin (`TS2578`) **and** breaks the invocation site (`TS2722`/`TS18048`), because the fallback is gone. The guarantee is structural, not merely pinned.

## Cross-doc invariant audit

`KnowledgeWriterDeps.workspacePathCheck` optional→required is a dep-surface change; the orchestrator confirmed at Step 2.5 that the row question is resolved on their side and not a Step-9 blocker. Recorded here so it is not lost. No Appendix-A model touched.

## Reachability

The guard is reached from `applyPlan` step 4.5, via `createCommitActivity` → `deps.applyPlan`, from three production call sites — `buildActivities.ts` (both the meeting `commit` **and** the `sourceCommit` path, which reuse one deps literal) and `semanticApprovalDispatch.ts`. Security review enumerated these rather than assuming: only two production `applyPlan` importers exist repo-wide, and no `Partial<>`, spread-from-config, or cast appears in any `src`. **No tested-but-unwired surface added** — this slice deletes an alternative, it does not add a path.

## Open follow-ups

1. **`#49` re-scoped by the orchestrator** — its first half stands (the 9 sites take zero coverage from the flip); its second half was withdrawn as mine and wrong.
2. **The no-guard question** is now its own task, carrying the corrected reason.
3. **Worker's step-2 comments** (`buildActivities.ts:590-592`, `semanticApprovalDispatch.ts:74-75`, and a test) still say the supplied check is "behaviourally inert until step 3" — step 3 has landed, so they are now load-bearing; two also cite a line that no longer exists.
4. **`### 24.61`** remains armed for whoever moves the exempt id to config; this slice introduced no runtime path to that argument.

## What this session is worth remembering for

⭐ **Deleting a false reassurance is right; replacing it with silence is not.** The docblock I removed claimed a divergence between the desktop `toWorkspaceId` and the guard's exempt id leaves the stranded workspace *"writable-but-no-longer-served (inert, not a leak)."* It is served **to the other workspace** — the old workspace keeps committing unprefixed, `assign` maps legacy to the new target, and `decideHitScope` keeps those hits for that workspace's ask. I deleted the wrong analysis and nearly shipped a gap where the truer, worse one belonged. It also refined a conclusion the lead, the orchestrator and I had all signed off: *"two different facts"* was true and **incomplete** — alone it licenses changing one without the other. Correct statement: **two facts with a coupled safe-change rule.** The desktop comment was exactly the damage the incomplete version permitted.

⭐ **A mechanical rename can walk a TRUE sentence into a FALSE one.** A blind `LEGACY_UNPREFIXED_WORKSPACE_ID` → `EXEMPT_WS` `sed` rewrote a sentence into *"`EXEMPT_WS` remains the sole source in production"* — a test-local literal claimed as production's source for a rule-4 exemption, in the file whose other comments I was rewriting for honesty. **Strictly worse than the staleness it replaced**, since the original at least named a real production symbol. Both code-quality HIGHs came from that one `sed`, and only a reviewer caught them.

⭐ **A count that survived two corrections was never one population.** My scoping for `#49` was wrong, my first correction was also wrong, and the third was right: the nine `deps: {} as never` sites are four `ExternalWriteDeps` (a different type, no such field) plus five that inject fake `applyPlan`s. Grouping by the literal `deps: {} as never` grouped by **spelling**, not by **type**.
