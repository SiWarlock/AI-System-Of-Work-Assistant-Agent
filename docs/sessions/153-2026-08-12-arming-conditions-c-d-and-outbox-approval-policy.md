# 153 — worker: arming-block conditions (c) + (d), plus the OutboxEntry.approvalPolicy prerequisite

**Date:** 2026-08-11 / 2026-08-12 (session spanned midnight)
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/150-2026-08-11-propose-approval-binding-and-cross-workspace-ceiling-gate.md`
**Successor session:** `docs/sessions/157-2026-08-12-l134-chain-closes-migration-detector-and-raw-content-fork-deleted.md`

---

## Why this session existed

Resumed as `worker-implementer` on a fresh spawn after the prior team's full teardown. Dispatched three slices in sequence, each closing (or unblocking) an item on the 24.6 pre-go-live safety-assertion audit's arming-block release-condition chain — the single gate standing between this project and go-live:

1. **24.5 + 24.20** — the turn-on runbook was 12-phase/7-crossing and silently omitted crossing 8 (the RES-1 research-provider arc), discharging **condition (c)**.
2. **24.7** — two live interactive-Copilot policy-denial paths built redaction-safe audit signals and every caller discarded them, discharging **condition (d)** (the sole remaining condition after (a)/(b)/(c) were separately closed this same round).
3. **24.35** — a small, no-design-decision `packages/db` schema addition (`OutboxEntry.approvalPolicy`), dispatched as a direct prerequisite for `24.15` (providers-integrations track) once conditions (c) and (d) were both closed.

---

## What was built

### Files created

- `apps/worker/test/api/procedures/copilotDenialAudit.test.ts` — end-to-end denial-audit tests for 24.7; every assertion triggers a real denial through the real call chain and queries a real (in-memory, behaviorally-real) `AuditRepository`, per the owner's explicit anti-discharge clause for this task.
- `packages/db/migrations/sqlite/0012_outbox_approval_policy.sql` + `packages/db/migrations/pg/0012_outbox_approval_policy.sql` — the additive-nullable-column migration for 24.35, one statement each.
- `packages/db/migrations/{sqlite,pg}/meta/0012_snapshot.json` — drizzle-kit-generated schema snapshots paired with the above.

### Files modified

**24.5 + 24.20 (commit `aac45cf0`):**
- `docs/runbooks/turn-on-and-smoke-test-runbook.md` — full restructure: Part II renumbered to real `ARCHITECTURE.md` phase numbers (14–26, eliminating a second, colliding local-numbering scheme that was F18's own finding); new Phase 26/crossing-8 (RES-1) section built from `§ARM-RESEARCH`; all 8 hard-line crossings tagged "crossing K of 8" in dependency order across both Part I and Part II; a Phase-numbering map + an order-inversion callout added at the Part I/II boundary (Part I walks "Phase 4" before "Phase 5" despite the real dependency running the other way — flagged, not silently reordered, tracked separately as `24.28`); Part I's "Definition of 100%-done" checklist gained the missing crossing-8 bullet; closing counts corrected to 13 phases / 8 crossings throughout.
- `docs/runbooks/copilot-propose-go-live.md` — added a back-reference to the corrected master runbook structure (this file had none before).
- `IMPLEMENTATION_PLAN.md` — I made two small corrections here (24.5's own title/Depends: line; a stale "crossing 1 of 7" in Phase 17's posture text) but per the territory rule the orchestrator absorbed both as its own hot-write, commit `30252eec` — not in my commit.

**24.7 (commit `0c8de4b2`):**
- `apps/worker/src/api/procedures/copilot.ts` — new `AuditPersistPort` interface; `evaluateCopilotEgress` extracted as the audit-preserving core of `guardCopilotEgress`; new `decideCopilotEgressWithAudit` (returns `{result, audit}`, `decideCopilotEgress` becomes a one-line wrapper); `GovernedCopilotSynthesisDeps` gained an optional `auditPersist`; `runGovernedCopilotSynthesis` persists on the egress-veto deny branch.
- `apps/worker/src/api/procedures/copilotAgentSynthesis.ts` — new exported `admitCopilotAgentJobWithAudit` (audit-preserving core of `admitCopilotAgentJob`); `AgentSynthesisOpts` gained a required `auditPersist`; `synthesize` persists on the ING-7 admission-deny branch.
- `apps/worker/src/api/procedures/copilotClaudeSynthesis.ts` — `CopilotDepsOptions.auditPersist` (required — the composition root for this dependency); `buildCopilotDeps` threads it through.
- `apps/worker/src/boot.ts` — new exported `createAuditPersistPort` (the real implementation: `toAuditRecordInput` → `AuditRepository.append`, gated on `isRedactionSafe`, never surfaces a persistence failure to the caller); wired at both the completion-path `buildCopilotDeps` call and the agentic-path `agentSynthesisFactory`; **also fixed a real production gap found while verifying deps-threading completeness** — the hand-built `briefing` (`CopilotBriefingDeps`) object was reusing several `copilot`-object fields individually but not the newly-added `auditPersist`, which would have shipped `copilotBriefing`'s denials silently unpersisted.
- `apps/worker/test/api/procedures/copilotClaudeSynthesis.test.ts` + `copilotAgentSynthesis.test.ts` — ~26 existing `buildCopilotDeps`/`createAgentRuntimeCopilotSynthesis` call sites updated with a shared no-op `auditNoop` fake (mechanical, zero assertion changes) to satisfy the newly-required field.

**24.35 (commit `3cc87f6f`):**
- `packages/db/src/repositories/interfaces.ts` — `OutboxEntry.approvalPolicy?: string`.
- `packages/db/src/schema/outboxes.ts` + `packages/db/src/schema/pg/outboxes.ts` — matching nullable `text()` column, both dialects.
- `packages/db/src/adapters/sqlite/index.ts` + `packages/db/src/adapters/postgres/index.ts` — `toOutbox()` mapper + `update()`'s explicit `.set({...})` block, both dialects (`enqueue()` needed no edit — it spreads the entry).
- `packages/db/src/schema/__snapshots__/operational-schema.snap` — `outbox`'s frozen dual-dialect column list gained `approvalPolicy`.
- `packages/db/test/contract/repository-contract.test.ts` — three new tests (round-trip, absence-defaults-to-undefined, and a dedicated `update()`-sets-it-for-the-first-time test, per the orchestrator's Step-2.5 ADD).
- `packages/db/test/migrate/lifecycle.test.ts` — hardcoded applied-migration count bumped 12→13.

---

## Decisions made

- **24.5/24.20: renumber Part II to real `ARCHITECTURE.md` phase numbers rather than annotate the existing local 0–11 scheme.** Kills the F18 vocabulary collision at the root instead of adding a third translation layer; the ~20 in-prose cross-references this touched were mechanically bounded (confirmed via `awk`-scoped sweep of the Part II region before and after).
- **24.5/24.20: do NOT renumber Part I.** Its own Phase-N labels are cross-referenced from within its own prose at 15+ sites (confirmed by grep); a full renumber was a materially larger, riskier lift than this brief's stated scope. Flagged the one place this leaves a real landmine (Phase 4 walked before Phase 5 despite the dependency running the other way) as its own callout + task (`24.28`) rather than silently reordering 1300 lines of detailed content.
- **24.7: extract `WithAudit` sibling functions rather than change any public `Result`-returning signature.** `FailureVariant.cause` is a frozen `.strict({code})` schema — the `AuditSignal` structurally cannot be smuggled through it — and `guardCopilotEgress`/`decideCopilotEgress`/`admitCopilotAgentJob` are all directly unit-tested elsewhere on their existing shape. The extraction is byte-behavior-preserving; every existing test against those three functions is untouched.
- **24.7: `GovernedCopilotSynthesisDeps.auditPersist` optional; `CopilotDepsOptions`/`AgentSynthesisOpts.auditPersist` required.** Required at the two actual composition roots (`buildCopilotDeps`, `createAgentRuntimeCopilotSynthesis`'s call site) closes the real production gap with a compile-time guarantee; optional at the inner type avoids ~16 unrelated unit-test call sites that construct the type by hand to unit-test the synthesis core in isolation. Verified this split is actually safe by tracing every production caller of `runGovernedCopilotSynthesis` (three: `copilotAsk`, `copilotBriefing`, `copilotConcept`) — which is how the `briefing`-object gap above was found and fixed in the same slice.
- **24.7: a redaction-safe `console.error` for a persist failure, not a `HealthItem`.** No existing mechanism reaches a `HealthItem` sink from this synchronous API-procedures call path (the only wired minting is inside Temporal activities); building one would be a real scope expansion beyond this brief's file list. Named explicitly as "not a HealthItem, don't read it as one" per the orchestrator's framing.
- **24.7 (security-reviewer's catch): gate `createAuditPersistPort` on `isRedactionSafe` before persisting.** `packages/policy/audit-signal.ts`'s own doc comment named this exact consumer in advance and prescribed fail-closed refusal (9.33's house rule) — added the gate + a pinning test.
- **24.35: split the drizzle-kit-generated migration rather than ship it as generated.** `drizzle-kit generate` bundled an unrelated `CREATE TABLE task` statement into the diff — task 13.15's `task` table has never had a migration generated for it, in either dialect, since it shipped. Temporarily disabled the `task` barrel export in both schema index files, regenerated so migration `0012` contains only the `outbox.approvalPolicy` column, restored the exports (confirmed byte-identical to `HEAD` afterward, independently reconfirmed by the code-quality reviewer). The underlying gap was NOT fixed here — filed separately (`24.39`) rather than silently bundled into a slice titled "add one column."
- **24.35: verify dual-dialect test execution via `--reporter=json`, not the default/verbose text reporters.** Both plain-text reporters lost lines to terminal-overwrite under output capture — the default reporter showed only `postgres-pglite` results for my tests on one run, the verbose reporter showed only `sqlite` on another. Neither was lying about pass/fail, just losing lines to the live-animation-under-capture interaction; the JSON reporter isn't subject to that and gave a reliable 3-and-3 count across both dialects. **New tooling gotcha for this project, adjacent to the `git status`/`git commit` bare-`ok` family — worth banking.**

## Decisions explicitly NOT made

- **24.5/24.20: whether to fold `copilot-propose-go-live.md` into the main runbook.** Took the brief's own default (stay separate, fix only the cross-reference) — merging would be a larger structural change than the brief's Done-when asked for.
- **24.7: building a minimal `HealthItem` path for audit-persist-failure observability**, considered and explicitly declined (see Decisions made above) — the orchestrator noted they'd consider a follow-up task for this, not mine to solve now.
- **24.35: fixing the `task` table's missing migration in this slice.** Real, significant, and adjacent — but out of a "add one column" slice's proportionate scope. Filed as `24.39` instead.
- **24.35: whether any existing dev/prod database has silently been running without the `task` table.** Flagged as an open question in `24.39`'s filing, not investigated here — outside this session's territory (no live database to check against).

## TDD compliance

**24.5/24.20: N/A — documentation rewrite, no code.** Verification was the brief's own 4-point RED-test-outline (grep/re-derivation checks), all re-run and pasted at Step 9, not a unit-test RED/GREEN cycle.

**24.7: clean, genuine red-first.** Wrote `copilotDenialAudit.test.ts` referencing not-yet-existing exports (`decideCopilotEgressWithAudit`, `createAuditPersistPort`, the `auditPersist` fields) — confirmed RED via `tsc --noEmit` (6 real compile errors naming the missing symbols), then implemented to GREEN. The redaction-safety-gate test (added after the security-reviewer's catch) was also written before the gate existed in `createAuditPersistPort` and confirmed failing first.

**24.35: mostly clean, one disclosed exception.** The original two tests (round-trip, absence-defaults-to-undefined) were written before `OutboxEntry.approvalPolicy` existed — confirmed RED via `tsc --noEmit` (6 real compile errors) before implementing the field/schema/adapters. **The third test** (`update()` sets it for the first time — added post-GREEN in response to the orchestrator's Step-2.5 ADD) **was written and passed immediately** against already-correct implementation; it was never RED for that specific test, though the capability it pins was itself built via the original genuine red-first cycle. Not safety-critical (an additive nullable DB column), disclosed rather than characterized as uniformly clean.

## Cross-doc invariant audit

Checked `packages/contracts/CLAUDE.md`'s Cross-doc invariants table against all three slices. **None touched.** `OutboxEntry` is explicitly confirmed NOT an Appendix-A frozen model (`packages/db/src/repositories/interfaces.ts`'s own section header, and `column-parity.test.ts`'s parity set excludes it) — a plain additive operational-DTO field, no schema-snapshot/Appendix-A obligation. `AuditPersistPort`/`AuditSignal`/`AuditRecord` — the first is a new worker-internal port (no contract-seam status); the latter two were consumed, not modified. `git diff -- ARCHITECTURE.md` confirms no uncommitted hot doc edit is owed or pending. No violation.

## Reachability

- **24.5/24.20:** the runbook itself is the artifact — no code entry point (Step 7.5 stated this explicitly in the brief). Verified by re-reading the closing summary against the body enumeration, not by a test.
- **24.7 — egress-veto path:** `runGovernedCopilotSynthesis` reachable from all three live tRPC query procedures (`copilotAsk`, `copilotBriefing`, `copilotConcept` — confirmed by tracing every production caller, not assumed). **ING-7 admission path:** `createAgentRuntimeCopilotSynthesis`'s `synthesize`, reachable via `agentSynthesisFactory` in `boot.ts` when `copilotRealModel && copilotAgentMode` are both true. **Disclosed gap, not silently glossed over:** the ING-7 admission-DENY branch specifically is unreachable through `synthesize`'s own legitimate job construction today — `resolveCopilotAgentCapability` always builds a read-only (non-mutating) job for any non-trusted content, regardless of `proposeEnabled`, so the `admitJob` deny condition can never trip via that path. It's a genuine defense-in-depth backstop (confirmed dormant-by-construction, matching the module's own "C4's admitCopilotAgentJob is the backstop" framing); the corresponding test exercises the real gate + real persist port directly rather than forcing an unrealistic path through `synthesize`.
- **24.35:** the producer side (`OutboxEntry.approvalPolicy`, both dialects) is fully wired and tested. The consumer (24.15's redrive logic re-deriving `requiresApproval()` from the persisted original policy) is **intentionally not yet built** — this task exists specifically to unblock that consumer on a separate track. Not a gap; the correct producer-first ordering per the standing no-cross-track-verticals rule.

## Open follow-ups

1. **`24.28`** (filed by the orchestrator during 24.5/24.20) — the Part I Phase-4-before-Phase-5 section-order-vs-dependency-order inversion; decide whether to reorder Part I or add a stronger structural guard, still open as of this session's end.
2. **`24.37`** (filed by the orchestrator during 24.7) — audit every hand-built deps object in `boot.ts` that selectively reuses some but not all fields of a factory output, for fields the factory added after the literal was written; the `briefing` instance is fixed, the class-level sweep is not done.
3. **Stale comment, `packages/policy/src/audit-signal.ts:137-143`** — its doc comment still asserts the audit-persistence consumer "does not exist yet," which 24.7 makes false. Not mine to touch (brief's own instruction — `packages/policy` isn't worker territory); routed to providers-integrations directly by the orchestrator, confirmed picked up, not yet landed as of this session's end.
4. **`24.39`** (filed by the orchestrator during 24.35, escalated to the lead as a category-2 Finding) — task 13.15's `task` table has never had a migration generated, in either dialect; needs its own migration, a check for whether any real database has silently run without the table, and the lesson candidate *"DONE + a green repo-contract suite does not prove a migration exists"* (endorsed, to be banked at close-out).
5. **Tooling note, not yet banked as a lesson:** vitest's default and `--reporter=verbose` text reporters both lose individual test-result lines to terminal-overwrite-under-capture when a large parameterized suite runs; `--reporter=json --outputFile=<path>` is the reliable read. Surfaced here per the orchestrator's request so the next worker session doesn't have to re-derive it.
6. **All three slices' commits already landed individually** (`aac45cf0`, `0c8de4b2`, `3cc87f6f`) — nothing left uncommitted from this session except this doc.

## Preflight (session-end gate)

`pnpm lint` reproduced the pre-existing documented flaky root-script failure (`ESLint output (JSON parse failed…)` / `Command "eslint" not found`, exiting before turbo even starts — contracts L111); confirmed clean via the documented workaround, `npx turbo run lint` → 11/11. `pnpm format:check` — the script doesn't exist anywhere in the repo (a pre-existing, already-documented gap, not new). `pnpm typecheck` — 20/20 clean. `pnpm test` (full repo-wide) — **523 files / 7551 tests passed, 1 file failed**: `apps/desktop/test/bundle/main-bundle-resolution.test.ts` (`electron-vite build` subprocess failure). This is the already-tracked `24.25` — desktop territory, desktop is shut down, not this session's to fix. **Confirmed unrelated to this session's changes**: none of the three slices touch `apps/desktop/`, `packages/contracts/src/`, or `packages/domain/src/` (the specific bundle-input trees `24.25` already measured against the round's diff). This run adds one more data point consistent with `24.25`'s own leading hypothesis (L83, concurrent-WIP false-positive) — there IS genuine concurrent WIP in the shared tree right now (another implementer's `packages/knowledge/` changes, visible in `git status` throughout this close-out) — but per `24.25`'s own text, a second observation reaching for a known signature is not the same as the clean-tree reproduction that would actually close it. Not attempting that here; annotating instead of chasing.

**Preflight status: clean except for the pre-existing, already-tracked, confirmed-unrelated `24.25`.** Not `incomplete` in the sense of a NEW gap this session leaves — everything this session actually touched is green.
