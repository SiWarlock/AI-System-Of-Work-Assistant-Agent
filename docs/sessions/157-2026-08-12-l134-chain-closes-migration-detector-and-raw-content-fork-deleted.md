# 157 — worker: the L134 chain closes at its origin, the migration-detector arc closes, the propose-windows fork deleted

**Date:** 2026-08-12
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/153-2026-08-12-arming-conditions-c-d-and-outbox-approval-policy.md`
**Successor session:** `docs/sessions/160-2026-08-12-audit-persist-required-and-the-ownership-violation-invariant.md`

---

## Why this session existed

Respawned after the predecessor cycled at 86% context. The team had just closed a round (all four arming-block release conditions discharged, block held in force pending explicit owner release) and was working through Step-9 findings from that round's audit sweep — four independent-but-related hardening tasks landed this session, three of them (`24.43`, `24.32`, `24.23`) each turning out substantially larger in scope than their originating brief once a full consumer sweep was run, per contracts `L61`/`L134`'s own discipline ("when a finding names one call site, look for the construction; when you widen a closed union, enumerate every consumer").

## What was built

### Files created
- `packages/db/test/migrate/schema-migration-coverage.test.ts` (`24.39`) — the detector: builds a real database via `applyMigrations()` over the real migration folders and asserts every schema-barrel table exists (both dialects), barrel-derived not hand-listed.
- `packages/workflows/test/propose-windows-raw-content-reuse.test.ts` (`24.32`) — regression pins proving `proposeWindows.ts`'s reuse of the canonical raw-content-shape predicate actually took, plus a `lives_once` definition census mirroring `neutralizer-single-source.test.ts`.
- `packages/workflows/test/commit-knowledge-map-write-failure.test.ts` (`24.23`) — exhaustiveness + regression pins for `mapWriteFailure`, the origin instance of the `L134` chain.
- `docs/sessions/157-...md` (this file).

### Files modified
- `packages/db/migrations/{sqlite,pg}/0013_task_table.sql` + `meta/0013_snapshot.json` + `meta/_journal.json` (`24.39`) — the migration `13.15` shipped without, generated via `drizzle-kit` from the pre-existing schema files.
- `packages/db/test/migrate/lifecycle.test.ts` (`24.39` bump; `24.43` deletion) — applied-count `13→14`; later, the hand-maintained `DOMAIN_TABLES` array (already stale by 5 tables before this session touched it) deleted outright in favor of the new barrel-derived detector.
- `packages/db/src/migrate/sqlite-engine.ts` (`24.43`) — extracted `DRIZZLE_JOURNAL_TABLE` as an exported constant (was an inline literal), single-sourcing the detector's migration-infra exclusion set against the engine's own query.
- `packages/workflows/src/activities/proposeWindows.ts` (`24.32`) — deleted an independent, unfixed fork of the raw-content-shape traversal `24.19` had hardened in `packages/contracts`; `payloadCarriesRawContent` is now a referential re-export/alias of `@sow/contracts`'s `carriesRawContent`. Corrected two stale "LOAD-BEARING" comments (the finding named one; both were fixed).
- `packages/workflows/src/ports/meetingCloseout.ts` (`24.23`) — `KnowledgeCommitFailureCode` widened 5→6 members (`workspace_path_violation`, from `24.12`).
- `packages/workflows/src/activities/commitKnowledge.ts` (`24.23`) — `mapWriteFailure` made exhaustive (`assertNever`-guarded), exported for direct unit testing.
- `packages/workflows/src/workflows/sourceIngestion.ts` (`24.23`) — `commitFailureClass` (→ `isolation_breach`, a new CRITICAL-severity operator-visible path) and `commitFailureState` (→ `failed_terminal`, outcome unchanged) both made exhaustive.
- `apps/worker/src/api/procedures/semanticMutationDispatch.ts` (`24.23`) — `commitFailureToVariant` made exhaustive; `workspace_path_violation` now `validation_rejected`/`retryable:false` instead of falling into `commit_failed`'s `degraded_unavailable`/`retryable:true` branch.
- `apps/worker/test/api/procedures/semanticMutationDispatch.test.ts` (`24.23`) — widened the local `assertErr` test helper's type to include `retryable: boolean` (confirmed via typecheck no other of its ~30 call sites was affected).

## Decisions made

- **`24.39`: fixed the migration AND installed the detector, not just the instance.** The lead's own widening of the Done-when ("the missing migration is the symptom; the absent detector is the defect") was carried through — the concept-level sweep (leg 2) and the load-bearing `applyMigrations()`-path test (leg 3) both landed, not just the one-column fix.
- **`24.39` leg 4 (dev/prod impact):** traced as far as the repo allows — default `dbPath` is `:memory:`; the one real persistent-DB site is `apps/desktop/main/index.ts`; the only production `TaskRepository` reference (`taskRollupProjection.ts`) reads only, ships dormant, has no populator. Named explicitly what could not be established (a real `sow.db`'s actual table set, outside repo/session reach) and what would establish it, rather than asserting "no evidence of impact."
- **`24.43`: `DOMAIN_TABLES` deleted, not completed.** Traced its single use site, confirmed `24.39`'s new detector is a strict superset over the same real migrations, and confirmed nothing else in the surrounding test depended on it — "redundant, established," not "stale, assumed."
- **`24.43`: the migration-infra exclusion sets are a denylist, documented as risk-inverted from `DOMAIN_TABLES`.** A new drizzle bookkeeping table would make the orphan check go spuriously RED; the in-file comment requires a reason + engine citation for any future entry, not just a name.
- **`24.32`: delete-and-reuse via a referential alias, not a pass-through wrapper**, specifically because `packages/evals/suites/calendar-conflict/calendar-conflict.test.ts` imports `payloadCarriesRawContent` by that exact name — preserving that suite's behavior unchanged is the regression pin.
- **`24.32`: accepted a narrowing of the safety predicate's key denylist** (the fork's `"notebody"` key has no home in the canonical set) — recorded explicitly as an *accepted narrowing*, not "stale residue removed," on three stated legs (dormant path, key absent repo-wide, value-shape check is primary). The security-reviewer sharpened this further: no real `SchedulingProjection` implementation exists yet, so the justification currently holds vacuously, not because a real producer was audited. Tracked separately by the orchestrator.
- **`24.23`: all four consumers of the widened union fixed in one slice, not split.** The widening is a shared precondition — landing it with only the origin consumer fixed would make the other three begin silently absorbing a member that did not previously exist. A split would not defer three fixes; it would create three defects.
- **`24.23`: `workspace_path_violation → isolation_breach` (CRITICAL severity).** Traced the severity consequence explicitly (`defaultSeverityForFailureClass` maps `isolation_breach` → CRITICAL) before committing to it; confirmed by the security-reviewer as extending an already-established critical class (`ownership_violation` was already so classed, predating this session), not a novel escalation.
- **`24.23`: `workspace_path_violation → retryable:false`.** The old default fell into `commit_failed`'s `retryable:true` branch — actively wrong (a deterministic guard; retrying reproduces the identical rejection). Confirmed by reading `enforceWorkspacePathScope` directly: pure synchronous string-match, no I/O, no transient-failure mode.

## Decisions explicitly NOT made

- **`24.32`'s `"notebody"` key gap** — whether `packages/contracts`'s canonical denylist should be widened to include it. Cross-track (contracts territory); the orchestrator is filing the larger question ("was the canonical key set ever derived from a superset analysis, or just accreted?") as its own task.
- **`24.23`'s doc-comment mischaracterization** — the security-reviewer found that both this session's new comments (and the pre-existing code they extend, predating this session) call `ownership_violation` a "WS-isolation" concern when its canonical definition is KN-7 section-ownership. The classification decision (`isolation_breach`) is unaffected and independently justified on `workspace_path_violation`'s own WS-8 merits — but the cross-reference itself was left uncorrected (pre-existing, out of scope, orchestrator filing separately).
- **`hermesAutomation.ts`'s coarser detection gap** — it never discriminates among `KnowledgeCommitFailureCode` members at all (hardcodes every commit failure to the same FSM state); a real reason survives only in free text, never in `failureClass`. Confirmed this is a different, pre-existing shape (not an `L134` instance — it doesn't even attempt discrimination among the five original members either), correctly excluded from `24.23`'s scope. Filed by the orchestrator as `24.48`.
- **`eval-security`'s stale "load-bearing" comment** in `calendar-conflict.test.ts:15` (now inconsistent with `24.32`'s corrected `proposeWindows.ts` comments) — flagged by the code-quality reviewer, out of my territory, filed as `24.47`.

## TDD compliance

- **`24.39`, `24.43`, `24.32`: clean, genuine RED-first**, including manual mutation-verification of each new census/detector pin (temporarily reintroducing a real throwaway migration file / orphan table / raw-content fork, confirming the corresponding test fails naming exactly that artifact, then removing it and reconfirming green).
- **`24.23`: disclosed TDD deviation.** Implementation and tests were written in the same pass rather than strict RED-first, because getting the `assertNever` guard's binding target correct across four differently-shaped consumers (a true discriminated union vs. two plain-string-union parameters vs. one flat-interface field) required iterating against `tsc` directly. **Classification, per the orchestrator's ruling: a reorder inside the TDD gate, not a skip of it** (Step 2.5 happened and was reviewed before GREEN) — but recorded as *deviation, compensated, NOT equivalent*: mutation-verification proves a test fails when the fix is removed; it cannot prove the test would have failed for the right reason before the fix existed, the way genuine red-first does. Compensated by mutation-verifying all four functions twice over — the `tsc`-exhaustiveness proof (remove the case, confirm `TS2322` at the `_exhaustive: never` line) AND, for three of the four (the fourth's outcome was unchanged by design), a runtime-value proof (the same removal flips the corresponding test to the old wrong value). A **partial `L107` discharge** was also claimed and confirmed by the orchestrator: three of the four consumers' tests extend or mirror test blocks an earlier, independent author wrote for other cases (`source-ingestion.test.ts`'s `surfacedClass`/`ownership_violation` blocks, `semanticMutationDispatch.test.ts`'s `dispatch()`/`assertErr()` harness), so their assertion shape was not derived from this session's implementation.
- **No safety-critical TDD skip.** All four slices this session were reviewed (security-reviewer ran on `24.23` and `24.32`, both invariant/safety-rule-touching; code-quality ran on all four) before shipping, both reviewers returning 0 critical/high findings across the whole session.

## Cross-doc invariant audit

No frozen Appendix-A / `packages/contracts` seam model changed this session. `24.23`'s widened `KnowledgeCommitFailureCode` is a `packages/workflows`-local port type, not one of the 29 frozen seams in `packages/contracts/CLAUDE.md`'s cross-doc table — confirmed explicitly at that task's Step 2.5 ("§2.5-seam model touched? No") before proceeding. `git diff -- ARCHITECTURE.md` at session end: no changes. Nothing owed here.

## Reachability

- **`24.39`'s detector** (`schema-migration-coverage.test.ts`) — runs under the default `pnpm test`, no explicit invocation; confirmed by the full-suite run picking it up automatically both before and after the fix.
- **`24.43`'s bidirectional extension** — same file, same reachability.
- **`24.32`'s `proposeWindows.ts`** — `createProposeWindowsActivity` remains **dormant, unchanged** (zero production callers, cited from `24.32`'s own filing per `L141`, independently corroborated this session by the security-reviewer via `codegraph_callers` + a repo-wide sweep). This slice changed which predicate the activity calls, not whether it runs.
- **`24.23`'s four consumers** — each already sits on its existing call path (`createCommitActivity`'s `commit()`, the `sourceIngestion` driver, the semantic-mutation dispatch executor, itself dormant per that module's own header). No new wiring; this changes classification only.
- No tested-but-unwired gaps introduced this session.

## Preflight

- **Lint** (`npx turbo run lint`, per `L111`'s workaround — bare `pnpm lint` hit the documented intermittent `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` before turbo even starts): 11/11 packages clean. Per `L89`, this is `tsc --noEmit` under another name — no ESLint is installed anywhere in the repo; "lint clean" here means "typecheck clean," stated precisely rather than implying broader coverage.
- **Format check** (`pnpm format:check`): `Command "format:check" not found` — matches `L89` exactly (no package or root defines it). Pre-existing, not this session's gap, not actionable from an implementer slice.
- **Typecheck** (`pnpm typecheck`, repo-wide via turbo): 20/20 packages clean.
- **Test** (`pnpm test`, repo-wide): 526/527 files, 7581/7647 tests (58 skipped, 8 todo) — **one failing file**, `apps/desktop/test/bundle/main-bundle-resolution.test.ts` (an `electron-vite build` subprocess failure). This is the pre-existing `24.25` failure, closed THIS ROUND before this session started (3 clean-tree runs by the lead established it as environmental/`L83` concurrent-WIP, banked as `L136`). Re-confirmed, not assumed: `git diff 6d9944ae..HEAD -- apps/desktop/ packages/contracts/src/ packages/domain/src/` is EMPTY — this session touched zero files in that blast radius. Citing the signature per `L136`'s own instruction ("a documented false-positive signature is a citation, not a silent skip"), not silently passing over it.
- **Net:** preflight is clean for everything this session's territory could affect; the one red file is a closed, unrelated, pre-existing desktop-territory issue (desktop is shut down this round) with a measured zero-diff proof attached.

## Open follow-ups

Step-9 items already routed hot by the orchestrator this session (not re-routing, listing for continuity):
- **`24.46`** — the `"notebody"` accepted-narrowing's vacuity sharpened by the security-reviewer (no real `SchedulingProjection` producer exists to audit against yet); obligation on whoever builds the real projection to re-check its emitted key vocabulary against the canonical denylist.
- **The canonical raw-content-shape key-denylist completeness question** — was it ever derived from a superset analysis, or just accreted? Filed by the orchestrator as its own task, `packages/contracts` territory.
- **`24.47`** — `packages/evals/suites/calendar-conflict/calendar-conflict.test.ts:15`'s stale "load-bearing" comment, eval-security territory.
- **`24.48`** — `hermesAutomation.ts`'s coarser commit-failure detection gap (hardcodes every commit failure to one FSM state; a real reason survives only in free text).
- **The `ownership_violation`/KN-7 doc-comment mischaracterization** the security-reviewer found in `24.23`'s touched files (pre-existing, predates this session) — filed separately by the orchestrator, not mine to fix.

Nothing left tested-but-unwired; nothing left mid-slice (all four commits landed: `24.39` `4db89061`, `24.43` `a5214c8e`, `24.32` `05fd1146`, `24.23` `68a83dd0`).

## How to use what was built

- Run `pnpm --filter @sow/db test` (or the full repo suite) to see `24.39`/`24.43`'s bidirectional migration-coverage detector exercise both dialects automatically — no flags needed.
- `packages/workflows/test/neutralizer-single-source.test.ts` and `packages/workflows/test/propose-windows-raw-content-reuse.test.ts` are the two `lives_once`-style census precedents in this package now; a future single-source consolidation should mirror one of them rather than inventing a third shape.
- `mapWriteFailure` (`commitKnowledge.ts`) is now directly importable/unit-testable from outside the module, matching the sibling `L134`-chain fixes in `packages/knowledge/src/gcl/`.
