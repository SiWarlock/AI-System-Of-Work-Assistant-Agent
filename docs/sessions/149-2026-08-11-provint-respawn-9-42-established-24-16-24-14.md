# 149 — providers-integrations: track respawn — 9.42 established-not-buildable, 24.16 fixed, 24.14 derived

**Date:** 2026-08-11
**Track / role:** main · providers-integrations-implementer (`packages/providers`, `packages/policy`, `packages/integrations`)
**Predecessor session:** `docs/sessions/126-2026-07-29-assertredactionsafe-verdict-auditsignal-persistence-gap.md`
**Successor session:** `docs/sessions/154-2026-08-12-24-13-boot-guard-24-29-census-widened-24-15-blocked.md`

---

## Why this session existed

The track respawned after the 2026-07-31 full-teardown seal (`docs/team-handoffs/021-…`). This
area had **no session in the round handoff 021 covers at all** — not a deliberate closure, an
omission: 021's Part-2 spawn table lists five areas and the string `providers-integrations` does
not appear anywhere in the document, despite root `CLAUDE.md` naming six code areas. The
team-lead's spawn message flagged this explicitly and framed it as "an area-level instance of the
project's own 'tracked work nobody is queued on' defect" — session 126's own dangling successor
line ("next `/session-end`, if this track respawns") was exactly the open loop this session closes.

Registered (`~/.claude/scripts/team-register.sh`), ran `/session-start`, oriented on
`IMPLEMENTATION_PLAN.md`, `packages/providers/CLAUDE.md` + `LESSONS.md`, `docs/audits/002-…`
(24.6 round 2), and independently re-verified (by grep, not on the lead's word) that
`providers-integrations` is absent from handoff 021. Three items were queued by the team-lead;
one (`24.12` leg 3) was retracted before dispatch as a lead error (see Decisions below). The
orchestrator then dispatched the remaining two plus a third (`24.14`) that surfaced from the same
audit round.

## What was built

**Files created:** none.

**Files modified:**
- `packages/integrations/src/health/health-signal.ts` — citation-rot fix (`24.16`): corrected a
  stale comment claiming `outbox_blocked`/`write_through_blocked` `FailureClass` members don't
  exist (they ship, task 13.15/ARC-2); renamed `WRITE_THROUGH_BLOCKED_HEALTH_CLASS` →
  `WRITE_THROUGH_FAILED_HEALTH_CLASS` (value unchanged) to resolve a name/value contradiction the
  original comment fix couldn't close alone. Commit `0de758d1`.
- `packages/integrations/test/health-signal.test.ts`, `packages/integrations/test/outbox.test.ts`
  — renamed the same symbol at its two consuming sites (one import+assertion pin, one
  wiring-comparison pin — both updated, only the former needed a value-assertion change). Same
  commit.
- `packages/integrations/src/connectors/adapters/capture-source.ts` — `24.14`: `buildCaptureSource`
  no longer self-declares `trustLevel: 'trusted'` for a `coding_session` capture from the bare
  `kind` discriminant alone (safety rule 6 / audit finding F11). `CaptureDeps` gained a required
  `verifyCodingSessionOrigin` predicate, mirroring the existing `isAllowedTelegramSender` shape;
  an unverified origin downgrades to `untrusted` rather than being rejected. Commit `f10a49f5`.
- `packages/integrations/test/capture-source.test.ts` — new forgery test (unverified origin ⇒ not
  trusted), widened `allowAll`/`denyAll` fixtures, corrected a stale module-header comment my own
  diff made false (same citation-rot class as the `24.16` fix, in my own new code this time). Same
  commit.

No files created or touched outside `packages/integrations` this session; `9.42` was
investigation-only (see below) and produced no diff.

## Decisions made

1. **`24.12` leg 3 is not this area's work — verified independently, not taken on the lead's
   retraction alone.** The team-lead's spawn message named `copilot-workspace-scope.ts` leg 3 as
   priority-1 block-release work, then retracted that as his own error (a leg of the *finding*,
   not the *remedy*, which is knowledge-side). Read `decideHitScope`'s `case "legacy":` branch
   myself before accepting the correction: it does exactly what its own comment claims (`assign`
   keeps legacy content only when `policy.toWorkspaceId === servedWorkspaceId`). Confirmed correct
   as written; reported the explicit verified-negative to main-orchestrator (contracts L126 — an
   unexamined "nothing to do" and a verified one must not look identical in a report).

2. **`9.42`'s producer-leg establishment: widening `AgentResult` is NOT an Appendix-A / frozen-
   contract change.** Investigated before any code: `AgentResult`
   (`packages/providers/src/ports/agent-result.ts`) is a plain 4-field TS interface with no Zod
   schema / generated JSON schema / `.snap` / ajv-registry entry — none of the 29 frozen contracts'
   defining machinery. Absent from both the Appendix-A table and the narrower §2.5 cross-track
   list. `ARCHITECTURE.md:123` directly answers the question for this exact arc ("the only frozen
   contract [the Copilot arc] touches is `Approval.workspaceId`"), and §7/:307 frames
   `AgentResult.candidateOutput` as converging *toward* the schema gate — i.e. structurally
   upstream of the frozen-contract surface, not inside it. Blast radius mapped (two
   `AgentRuntimePort` producers, broker pass-through, four worker consumers, conformance/fakes)
   for whoever eventually briefs the widening. **No code built** — the orchestrator's condition on
   the producer leg is discharged by the answer alone; the leg itself queues behind the arming
   block and is not dispatchable this session.

3. **`24.16`: renamed rather than deleted the reuse-alias, and the mechanism choice is recorded
   reasoning, not just an outcome.** Every sibling constant in the file follows an
   exact-value-named pattern; deleting the one mismatched constant to inline its literal would
   have fixed an identifier problem by breaking a file-level convention the other three constants
   still rely on. Caught and fixed a dangling citation my own rename created (a sibling comment
   named the old constant by name) — the orchestrator flagged this as the round's best small
   result: *"a rename that leaves such a reference manufactures fresh citation rot while fixing
   citation rot."*
   - **The severity re-scope, not just the fix:** traced `WRITE_THROUGH_BLOCKED_HEALTH_CLASS` end
     to end and found its only production path (`outboxHealth`, `outbox.ts`) has **zero**
     production callers — so re-pointing the alias would have changed no live operator-facing
     severity. The orchestrator's original Done-when ("re-point to the correct member") presumed a
     correct member existed between `outbox_blocked` (error severity) and `write_through_blocked`
     (warn severity, already used elsewhere for a narrower single-write case) — investigation
     showed neither is uniquely correct, because the conflation is one level up, in
     `buildToolWriteHealthSignal`'s generic `kind` union, not in the alias itself. The orchestrator
     amended the task's own wording from this finding rather than have it silently absorbed.

4. **`24.14`: derive, not delete — `§13.6` is a live plan with a planned caller, verified from
   source before choosing.** `IMPLEMENTATION_PLAN.md`'s `### 13.6` is `[~] PARTIAL`, names
   `capture-source.ts` as its landed artifact, and names the git-hook/session-end triggers as
   remaining, tracked work — ruling out `9.40`'s "delete mechanism, keep goal as successor task"
   precedent (there the goal had no possible producer; here the goal *and* a planned caller are
   both alive in the tracker). A caller-path-invariant mechanism was rejected on inspection:
   `buildCaptureSource` is an exported pure function with no privilege boundary between callers, so
   only an injected verifier (mirroring the Telegram leg's `isAllowedTelegramSender`) can supply
   ground truth the caller doesn't control. Downgrade-not-reject was chosen to match the module's
   emit-only posture and the brief's own acceptance wording ("not trusted", not "rejected").
   - **A finding that changed the fix's framing, not its shape:** traced whether the trust grant
     actually reaches anything today. It doesn't — `source-extraction.ts:173` hardcodes
     `trustLevel: "untrusted"` for every source-derived `AgentJob`, and there are zero repo-wide
     reads of `routingHints.trustLevel`. This lowers today's actual risk (nothing forgeable is
     armed) without changing the fix (the identifier still asserted a trust decision from an
     unverified discriminant) — recorded explicitly so the fix doesn't read as "safe because
     nobody reads it" instead of "safe because nothing forgeable grants it." Orchestrator tracked
     this separately as task `24.22`.
   - **The Step-2.5 ADD:** the binding seam (`CaptureDeps.verifyCodingSessionOrigin`) is REQUIRED
     (no default, mirroring the existing sibling field) and its doc comment names explicitly that
     no mechanical backstop exists yet against a future binding supplying a permissive `() =>
     true` — the lesson `24.13`'s `defaultVerifyKwSig` (same audit round) taught: naming a hazard
     in a comment is not enough on its own, but an explicit "accepted: none exists" is still an
     honest, load-bearing statement for the next reader.

## Decisions explicitly NOT made

- **`9.42`'s producer-leg widening itself** — established as buildable-in-principle (not an
  Appendix-A change) but not built. Queues behind the arming block per the orchestrator; needs its
  own brief once dispatched.
- **`24.14`'s three deferred flags, all belonging to the future `§13.6` binding slice, none built
  here (explicitly out of this slice's scope per the brief):**
  1. Downgrade-not-reject has no rate-limit/choke-point analog to Telegram's outright reject —
     worth the binding slice deciding whether an unverified-forever stream needs one.
  2. `CaptureDeps` bundles both predicates as one REQUIRED shared interface — a future
     Telegram-only or coding-session-only binding must supply a predicate it may never exercise,
     purely to satisfy the type (flagged by security-reviewer as `24.13`'s failure mode predicted
     forward). Worth the binding slice considering a split/discriminated deps shape.
  3. (Low, advisory only) `verifyCodingSessionOrigin` receives the whole capture rather than a
     narrow provenance signal — a future real implementation should prefer a provenance check over
     a content-sniffing heuristic on `sessionSummary`.
- **`source-extraction.ts`'s hardcoded `trustLevel: "untrusted"`** (the `24.14` U4 finding) — out
  of `packages/integrations` territory (`apps/worker`), correctly not touched; tracked by the
  orchestrator as `24.22`.

## TDD compliance

Clean — no violations.
- `24.16`: comment-only fix; the constant's *value* never changed, so no behavioral test could
  pin it — correctly non-TDD, and said so rather than manufacturing a test to satisfy the form.
  The rename's mechanical fallout (two import/usage sites) was verified by the full package suite
  staying green, not by new tests.
- `24.14`: full RED → GREEN → **mutation-verify** cycle. RED was a genuine type error (excess
  property on the not-yet-widened `CaptureDeps`) before any implementation; after implementing,
  temporarily reverted the derived check to the old unconditional literal and confirmed exactly
  the new forgery test failed (539/540, all else green) — proving the test is not vacuous — then
  restored.
- `9.42`: no code; investigation-only, no TDD applicable.

## Cross-doc invariant audit

No `packages/contracts` Appendix-A model's field list changed this session. `AgentResult`
(investigated, not built) and `CaptureDeps`/`CodingSessionCapture` (widened) are confirmed
providers/integrations-local types outside the 29 frozen-contract set — established as part of
`9.42`'s own investigation, not asserted. `git diff -- ARCHITECTURE.md` is clean (no uncommitted
doc edit pending). No discipline violation to flag.

## Reachability

- **`24.16`** — `WRITE_THROUGH_FAILED_HEALTH_CLASS` is reachable via
  `buildToolWriteHealthSignal` ← `outboxHealth` (`packages/integrations/src/tools/outbox.ts`).
  `outboxHealth` itself has **zero production callers** — a pre-existing gap, tracked separately
  as task `24.8` ("`outboxHealth` has ZERO callers"), not introduced or affected by this slice.
- **`24.14`** — explicitly declared at Step 7.5, per the brief: *"none — this path is unwired;
  `§13.6` is its consumer."* `buildCaptureSource` has zero production callers today (verified by
  both this session and, independently, the dispatched security-reviewer).
- **`9.42`** — not applicable; no code shipped.

## Preflight

`lint` (via `npx turbo run lint`, the documented equivalent for the known bare-`pnpm lint`
intermittent-exit-1 flake, Carry-forward item 6 / contracts L111): **11/11 clean.** `format:check`:
no such script exists anywhere in the repo (pre-existing, same Carry-forward item — not a gap this
session introduced). `typecheck` (repo-wide, `pnpm typecheck`): **20/20 clean**, confirming no
blast radius from widening `CaptureDeps`/`CodingSessionCapture`. `test` (repo-wide `pnpm test`):
7494 passed / 58 skipped / 8 todo, **one failed suite** —
`apps/desktop/test/bundle/main-bundle-resolution.test.ts` (`npx electron-vite build` command
failure).

⚠ **That desktop failure is REPORTED, NOT VERIFIED, per contracts L83** ("it applies to test runs
too" — a monorepo-wide suite run while another area is mid-slice measures that area's
uncommitted work-in-progress, not a property of committed HEAD; the lesson documents this exact
failure signature as a prior false-positive, reproducing 0/0 on a clean tree). At the moment this
run executed, `apps/worker` (`24.17`), `packages/knowledge` (`24.12`), and `packages/workflows`
had concurrent uncommitted changes from other implementers' in-flight slices — `apps/desktop` was
never touched by this session or by either of those slices, so the failure predates and is
unrelated to this diff. Per the lesson's own prescription, scoped my own verification to my
actual package instead: `@sow/integrations` alone is **540/540 tests green** (verified
independently, multiple times, across the session) and **typecheck-clean both package-local and
repo-wide**. Not re-chased further, per L83's explicit "Do" — re-running a heavyweight Electron
build against a shared, actively-mutating tree would not settle anything a clean-HEAD run
wouldn't.

## Open follow-ups

- `9.42` producer-leg widening — established buildable, not briefed; queued behind the arming
  block per main-orchestrator.
- `24.14`'s three deferred flags (above) — owned by the future `§13.6` binding slice, already
  recorded by main-orchestrator against that slice.
- `24.22` (new, orchestrator-tracked) — `source-extraction.ts`'s hardcoded
  `trustLevel: "untrusted"` means no source's `routingHints.trustLevel` reaches `AgentJob`
  anywhere today; worker-territory, not this area's.
- Task `24.8` (pre-existing, unaffected) — `outboxHealth` has zero production callers; the whole
  `WRITE_THROUGH_FAILED_HEALTH_CLASS` path this session touched is dormant for that reason, not a
  new one.

## How to use what was built

- `WRITE_THROUGH_FAILED_HEALTH_CLASS` (renamed from `WRITE_THROUGH_BLOCKED_HEALTH_CLASS`) is a
  drop-in rename — any future code that needs to reference it imports the new name; the value is
  unchanged.
- `CaptureDeps.verifyCodingSessionOrigin` is the seam the `§13.6` git-hook binding slice must
  populate with a real verifier (and, per the ADD, a mechanical guard against a permissive
  `() => true`) when it wires a production caller — see the doc comment on `CaptureDeps` in
  `capture-source.ts` for the explicit binding-status note.
