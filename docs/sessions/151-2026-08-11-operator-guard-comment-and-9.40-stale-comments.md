# 151 — desktop: `24.27` operator-guard comment rewrite + the two `9.40` stale comments

**Date:** 2026-08-11
**Track / role:** main · desktop-implementer
**Predecessor session:** `docs/sessions/147-2026-08-11-desktop-idle-9-42-blocked-24-12-no-desktop-leg.md`
**Successor session:** _(next `/session-end`)_

---

## Why this session existed

Session 147 closed idle: `9.42` (the only desktop-shaped work on the board) was blocked on an
upstream producer channel, and `24.12` had no desktop leg. `24.12` landed this round
(`c86030f9`, knowledge) and its own recorded residual named two desktop obligations verbatim:
(1) the operator-guard comment at `worker-host/index.ts:178`, which still claimed operator
discipline was what kept the Copilot `{assign}` bridge sound now that a real structural guard
existed, and (2) the two stale `9.40` comments in `copilot-panel.test.tsx` riding along at the
next desktop touch. The team lead re-activated desktop for exactly this, main-orchestrator filed
it as `24.27` and dispatched it via brief `docs/briefs/250-…` (spec-lint PASS `@946fafad`).

## What was built

**Files created:** `docs/sessions/151-2026-08-11-operator-guard-comment-and-9.40-stale-comments.md` (this doc).

**Files modified (commit `5bcb6b06`):**
- `apps/desktop/worker-host/index.ts` — rewrote operator-guard bullet (1) (lines ~166-168) to name
  `packages/knowledge/src/knowledge-writer/workspace-path-guard.ts` (24.12, `c86030f9`) as the real
  structural enforcement at `KnowledgeWriter.applyPlan`, and to cross-reference `24.26` (open,
  tracks the `LEGACY_UNPREFIXED_WORKSPACE_ID`/`toWorkspaceId` duplication this comment doesn't fix).
  Bullet (2) (the F2/A1 owner-acceptance note) is untouched — out of this slice's scope.
- `apps/desktop/test-dom/copilot-panel.test.tsx` — rewrote the two `9.40` stale comments
  (lines 478-479, 486-487) from present-tense "`proposalLabel` still exists" phrasing to
  past-tense "removed (`d5e987d4`)" phrasing. The other five `proposalLabel`/proposal-row mentions
  in the same file were already correctly phrased and were left alone.

Comment-only in both files — zero behavior/logic/config-value bytes changed (confirmed by both
reviewers independently, see below).

## Decisions made

- **Treated the brief's "Things to flag at Step 2.5" section as the mandatory pre-edit checkpoint**
  even though Step 2's RED/GREEN cycle was explicitly skipped (comment-only, no testable behavior).
  Sent `main-orchestrator` the exact proposed diffs for both files before touching either — this
  round's own standing rule ("read as much as you need, then STOP AND SEND before the first
  production edit," `docs/team-handoffs/022-…`) applies regardless of whether a RED test exists to
  review.
- **Cited `24.26` by task number** in the new comment. The brief posed this as an open design
  question with a default vote; `24.27`'s own Done-when text (`IMPLEMENTATION_PLAN.md:3139`)
  already mandated it, so no real ambiguity remained — confirmed at the checkpoint rather than
  silently overridden.
- **Corrected a path typo inherited from the brief and the plan doc**: both cited
  `apps/desktop/test/copilot-panel.test.tsx`; the real (only) file by that name is
  `apps/desktop/test-dom/copilot-panel.test.tsx`. Edited the real path, flagged the typo at Step 9;
  main-orchestrator hot-routed the correction to `docs/briefs/250-…` and
  `IMPLEMENTATION_PLAN.md:3137` (commit `f05c713f`, not this session's).
- **Ran a scoped `pnpm --filter '@sow/desktop...'` preflight during the slice** (10/11 workspace
  packages — everything in desktop's real dependency graph — all green, including
  `test/bundle/main-bundle-resolution.test.ts` 4/4) per the documented "keep the gate fast while
  iterating" allowance, then the full monorepo gate at `/session-end` (see below) per the stricter
  final-gate requirement.
- **Dispatched both `code-quality-reviewer` and `security-reviewer` at Step 8** rather than relying
  on the lighter every-slice-only default, because the diff's content concerns safety-rule-4
  documentation accuracy (not just prose quality) — both returned clean, no findings.
- **Answered main-orchestrator's direct "do you have any dispatchable work" question by checking,
  not asserting**: `TaskList` (nothing for desktop), a grep of `IMPLEMENTATION_PLAN.md` for any
  `24.*` task naming an `apps/desktop` file (zero hits), and a re-read of `9.42`'s tracker text
  (still explicitly blocked on the `AgentResult` receipt-channel leg, providers-integrations/worker
  territory, unchanged from session 147's finding). `9.42`'s own item (g) — the two `copilot-panel.test.tsx`
  stale comments — is the same pair fixed in this slice, so that residual is now closed too.

## Decisions explicitly NOT made

- **Did not build any part of `9.42`.** Still blocked upstream; unchanged from session 147's
  ruling. Nothing in this session's findings moves that needle.
- **Did not re-run the `main-bundle-resolution.test.ts` discriminator a fourth time.** Task `24.25`
  was already closed 2026-08-11 on exactly that discriminating evidence (three clean-tree runs, all
  pass) and banked as contracts `LESSONS.md#136`. This session's full-preflight run reproduced the
  identical signature under known concurrent WIP (see below) — citing the established finding
  rather than re-chasing it, per L111's "two runs disagreeing means flaky, never passing" and per
  the closed task's own instruction that the fix is "say so when you [recognize it], not stop
  recognizing it."

## TDD compliance

**Clean, by explicit exemption.** The brief classified this slice as "comment-only, no testable
behavior" and instructed skipping Step 2's RED/GREEN cycle outright — this matches the `/tdd`
skill's own "when TDD doesn't fit" carve-out (logging/instrumentation-style changes with no
behavior change). No implementation logic changed in either file, so there was nothing a
failing test could have pinned. No violation to record.

## Cross-doc invariant audit

No model field changed this session (comment-only). Checked `packages/contracts/CLAUDE.md`'s
Cross-doc invariants table and confirmed the brief's own "Cross-doc invariant impact" section
(none) — nothing owed. `git diff --stat -- ARCHITECTURE.md packages/contracts/CLAUDE.md` at
session-end shows no hot uncommitted edit either, consistent with nothing being owed.

## Reachability

Not applicable — comment-only, no behavior change, nothing to wire (brief's own Step 7.5
disposition, confirmed unchanged).

## Preflight (full monorepo gate, run at session-end per the stricter final-gate requirement)

- **Lint:** `pnpm lint` hit the documented pre-existing flaky bare-invocation signature
  (Carry-forward item 6(a) — an eslint invocation attempted in a repo with eslint in zero
  manifests; not new, not this session's). Used the documented workaround, `npx turbo run lint`:
  **11/11 packages green.**
- **Format check:** `pnpm format:check` — script does not exist repo-wide (documented pre-existing
  debt, Carry-forward item 6; not re-flagging).
- **Typecheck:** `pnpm typecheck` — **20/20 tasks green** (11 packages' typecheck + 9 build tasks).
- **Test:** `pnpm test` — **7524 passed, 58 skipped, 8 todo (7590 total), 1 failed suite.**
  ⚠ **The one failure is the documented `L83` concurrent-WIP false positive, recurring — cited per
  the established convention, not re-filed.** `test/bundle/main-bundle-resolution.test.ts` failed
  with the identical signature already diagnosed and closed under task `24.25`
  (`Error: Command failed: npx electron-vite build`, an `execFileSync` subprocess in the test's own
  setup). This full run was taken while three other implementers (`#16` worker, `#17`
  providers-integrations, `#18` knowledge — all `in_progress`, all holding uncommitted WIP in this
  shared single checkout) were mid-slice — exactly the condition `24.25`/contracts `LESSONS.md#136`
  established as the false-positive cause via three clean-tree runs, all passing. Corroborating:
  this session's own **scoped** run of the identical test, taken earlier and closer to this
  session's own commit, passed clean (4/4, 1312ms) — see "Decisions made" above. Not treated as a
  regression, not re-filed, not blocking this slice's close-out.

**Disposition: preflight clean** (lint 11/11, typecheck 20/20, test 7524/7524 non-skipped passing)
**modulo the cited, previously-established, non-regressive `L83` instance.**

## Open follow-ups

1. **`9.42` (desktop leg) — still blocked**, unchanged from session 147. Needs the `AgentResult`
   tool-call-receipt channel (providers-integrations/worker territory) before desktop's
   `{surface:"approvals";approvalId?}` route + affordance can be built without reproducing the
   consumer-with-no-producer shape `9.40` was deleted for.
2. **`24.26`** (open) — `LEGACY_UNPREFIXED_WORKSPACE_ID` / `worker-host/index.ts:178`'s
   `toWorkspaceId` duplication. This session's new comment cross-references it but deliberately
   does not fix it (tracked as a worker composition-root wiring leg, not a desktop edit).
3. **`L83` recurrence, recorded per the "say so" convention** (see Preflight section) — no action
   owed beyond this citation; `24.25` is already closed on its own discriminating evidence.

## How to use what was built

The `worker-host/index.ts:178` operator-guard comment now correctly documents that
`workspace-path-guard.ts` (not this comment) is what keeps the Copilot `{assign}` bridge's
soundness precondition true — a future reader auditing that config no longer has to independently
discover that the discipline-only framing is stale. The two corrected `copilot-panel.test.tsx`
comments no longer contradict the code they sit next to.
