# 159 — providers-integrations: 24.15 shipped (outbox redrive), escalated the 24.50 posture-binding Finding

**Date:** 2026-08-12
**Track / role:** main · providers-integrations-implementer (`packages/providers`, `packages/policy`, `packages/integrations`)
**Predecessor session:** `docs/sessions/154-2026-08-12-24-13-boot-guard-24-29-census-widened-24-15-blocked.md`
**Successor session:** `docs/sessions/161-2026-08-13-redaction-safe-producer-enumeration-24-45.md`

---

## Why this session existed

Continuation of the same team-mode track after session 154's close-out at the prior context
hard-stop. `24.15` had been fully designed at Step 2.5 (blast radius, string-vs-boolean fallback,
Appendix-A check) but held unstarted per explicit instruction, then survived an orchestrator cycle
whose promised dispatch never arrived. A fresh orchestrator ran a bounded liveness check
("mid-slice or waiting?") rather than assuming; confirmed I was genuinely idle with nothing lost,
and dispatched `24.15` to completion. This session covers that one slice, start (Step 3) to finish
(Step 10), plus the close-out triggered by the team's next context hard-stop.

## What was built

**Files created:** none.

**Files modified:**
- `packages/integrations/src/tools/outbox.ts` — `holdWrite()` now persists the original action's
  `approvalPolicy` onto the `OutboxEntry` (the field itself was added by the prerequisite `24.35`,
  a separate worker-owned slice, not this session's work).
- `packages/integrations/src/tools/outbox-drain.ts` — `rebuildAction()` now reads
  `entry.approvalPolicy ?? REDRIVE_APPROVAL_POLICY` instead of unconditionally hardcoding the
  literal; the literal survives only as the fail-safe fallback for an entry whose producer never
  persisted a value (a pre-`24.35` legacy row, or any future producer bypassing `holdWrite`). Two
  stale doc comments corrected in the same edit — one that overclaimed the verdict "re-derives
  against current governing policy, not a frozen snapshot" (true of the workspace-posture half,
  false of the token itself, which is deliberately the frozen historical record) and one asserting
  the persisted entry "does not store the original approvalPolicy" (`24.35` had already falsified
  this).
- `packages/integrations/test/outbox.test.ts` — one new test pinning the write-path persistence.
- `packages/integrations/test/outbox-drain.test.ts` — three new tests (auto-eligible entry redrives
  clean; a genuinely-needs-approval entry still gates; a legacy entry with no persisted value still
  gates), plus a shared hand-rolled `requireApproval` fake with a docblock explicitly naming what it
  does and doesn't prove (see Decisions). Commit `5b451256`.

## Decisions made

1. **Proceeded straight to writing RED tests rather than re-opening a round-trip Step 2.5**, since
   the fresh orchestrator's liveness check confirmed the dependency (`24.35`) was satisfied and my
   design from the prior session stood unchanged. Corrected myself mid-flow: initially told the
   orchestrator "proceeding to Step 3," then recognized the actual next `/tdd` step was writing the
   tests first (Step 2) followed by a proper Step 2.5 pause — did that instead of skipping the
   checkpoint.
2. **Design choice, reconfirmed and orchestrator-approved:** `entry.approvalPolicy ?? REDRIVE_APPROVAL_POLICY` — the literal is fallback-only now, never the default. Pinned by its own
   regression test. Orchestrator's own framing: *"pinned as a `[ ] already-passing` regression
   rather than claiming a RED — the honest disposition."*
3. **Design choice: a narrow hand-rolled `requireApproval` fake in the redrive tests, not the real
   `@sow/policy` predicate.** Reasoning: the predicate's own 5-conjunct logic is already exhaustively
   covered by `packages/policy/test/approval-policy.test.ts`; this slice's job is proving
   `rebuildAction`/`holdWrite` correctly *thread* the persisted field to that predicate, not
   re-verifying the predicate. Flagged explicitly at Step 2.5 rather than silently chosen — both
   reviewers later confirmed the choice itself was right but found the *fixtures* feeding it were
   wrong (Decision 4).
4. **Two-round fixture correction, both found by review, one found on each of two different
   fields:** orchestrator's TWEAK caught that `targetSystem: "drive"` (the fixtures' default) meant
   the *real* predicate would gate regardless of `approvalPolicy` — `AUTO_ALLOW_ELIGIBLE_TARGETS`
   has exactly one member (`calendar`), so the test's asserted "drains without approval" outcome was
   an artifact of the fake, not something the real system would produce for that input. Fixed to
   `targetSystem: "calendar"`. **Applying the same reasoning myself**, found the fixture's
   `workspaceId: "employer-work"` had the identical defect on a second conjunct
   (`dataOwner === "user"` would fail for that workspace under the real predicate) — fixed to
   `"personal-life"` without waiting to be told, since it was the same class of error the TWEAK had
   just named.
5. **Declined a reviewer-suggested test rather than either shipping it red or silently expanding
   scope.** Security-reviewer suggested a test binding the real predicate with a resolved posture
   for a workspace different from the entry's own, asserting the redrive still gates. Traced what
   making that assertion true would actually require: implementing the workspace-threading fix that
   belongs to the newly-escalated Finding (see Decision 6), not this slice. Stated the reasoning
   explicitly rather than dropping the suggestion silently; the new task inherits the test.
6. **Escalated a Finding rather than absorbing it or expanding scope to fix it.** Both dispatched
   reviewers independently traced the same structural gap: `rebuildAction` never carries
   `entry.workspaceId`, and the `ResolvedWorkspacePolicy` supplying the remaining auto-eligibility
   conjuncts (`dataOwner`, `defaultVisibility`) is bound once per composition, not re-resolved
   per-entry. Before this slice, the hardcoded `"queued"` literal made the real predicate's
   auto-allow branch structurally unreachable on every redrive — an untested but real guarantee this
   slice's fix removes. Security-reviewer's framing, quoted verbatim into the tracker: *"the
   hardcoded literal was also, incidentally, the reason a latent posture-binding defect one layer
   out was unreachable — removing it un-masks that."* Confirmed dormant by both reviewers (single-
   member target allow-list; no production caller constructs `DrainDeps` today) — filed as `24.50`,
   a **wiring precondition** (not ordinary tracked work) blocking whatever would first make the
   drain path constructible, per the lead's explicit ruling that "dormant, therefore safe" is
   exactly the class of claim this round has been wrong about before.

## Decisions explicitly NOT made

- **`24.50`'s actual fix** (thread per-entry workspace-scoped policy resolution through
  `DrainDeps`/`rebuildAction`) — deliberately out of this slice; filed as its own wiring-precondition
  task, carrying the reviewer-suggested cross-workspace test.
- **`24.51`** (`packages/db`'s outbox `update()` allows `approvalPolicy` mutation post-enqueue, no
  freeze unlike its `pendingKnowledgeMutations` sibling) — worker territory, correctly not touched;
  filed by the orchestrator.
- **The two producers that bypass `holdWrite` entirely** (`gbrain-sync-trigger.ts`,
  `buildActivities.ts:497`) — recorded as a stated scope bound on this fix ("partial across
  producers by construction"), not chased into other files.
- **Test-naming convention alignment** — my new tests use this session's `snake_case — prose` style
  (carried from packages/knowledge's convention in the prior slice) rather than this package's own
  `CAPS-PREFIX: prose` convention. Code-quality flagged it, tagged `defer`; not renamed in a
  safety-adjacent slice per the orchestrator's explicit call.
- **`24.45`** — next in queue, not started this session. Orchestrator held it back explicitly at
  close-out (its own Done-when needs re-deriving a producer enumeration from scratch, and it grew
  mid-session: `24.44` leg 2 made its gap reachable from a second, read-side path — whatever remedy
  is chosen must cover both). Stays mine, first thing next round.

## TDD compliance

Clean. Full RED → GREEN cycle on the two behavior-changing tests (persist-on-write;
auto-eligible-redrives-clean), confirmed RED for the right reason before any production edit. The
two regression-pin tests (still-gates-normal-case; gates-legacy-absent-case) correctly passed both
before and after the fix — pinning behavior that must NOT change, not vacuous (both reference a
shared fake that genuinely discriminates on its input, unlike the vacuous-assertion trap caught in
the prior session's `24.29`). No mutation-verify window opened separately — the real RED-then-GREEN
cycle over the actual production diff already constitutes the strongest form of that evidence, and
the team had flagged keeping such windows short/rare this round.

## Cross-doc invariant audit

No `packages/contracts` Appendix-A model's field list changed. `OutboxEntry` — confirmed
non-Appendix-A at Step 2.5 (a plain `@sow/db` operational DTO, explicitly documented "deliberately
NOT frozen seam contracts") — gained its field via the separate `24.35` slice, not this one.
`git diff -- ARCHITECTURE.md` is clean. No discipline violation to flag.

## Reachability

- **`24.15`** — `outbox-drain.ts`'s redrive path is already live (per the brief's own Step 7.5
  answer): this slice changes what value it reconstructs, not whether/when it runs. Confirmed via
  the full package suite (544/544) and repo-wide typecheck (20/20).
- **The newly-escalated `24.50` gap** — explicitly **NOT reachable** today: confirmed by both
  reviewers that no production file constructs `DrainDeps`/binds the outbox drain to a real
  composition root. This is the dormancy claim the lead asked be stated with its method: security-
  reviewer traced it directly from source (grep + read every candidate composition-root file,
  not inferred) — not re-verified independently by me this session, carried forward as reported.

## Open follow-ups

- **`24.45`** — mine, first thing next round. Blocks Phase 25.2/25.4 wiring. Grew mid-session (24.44
  leg 2 made its gap reachable from a second, read-side path) — re-read the tracker's current state
  before starting, don't assume the scope from before this session.
- **`24.50`** (wiring precondition, escalated to the lead as a rule-4 Finding) — not mine to build
  unless dispatched; carries the reviewer-suggested cross-workspace test.
- **`24.51`** (`packages/db` mutability gap) — worker territory, filed, not mine.
- Everything else from the prior session (154) that was still open — `packages/policy/src/audit-signal.ts`'s doc-comment staleness — status not re-checked this session; carry forward.

## How to use what was built

- `OutboxEntry.approvalPolicy` now round-trips faithfully through `holdWrite` → persistence →
  `rebuildAction` at redrive. Any future producer that enqueues an `OutboxEntry` directly (bypassing
  `holdWrite`) will permanently hit the fail-safe fallback unless it's updated to set the field too
  — by design, not an oversight, but worth knowing before adding a new producer.
- The `makeApprovalPolicyGatedDeps` fake in `outbox-drain.test.ts` is scoped and documented as
  proving *threading*, not predicate correctness — a future test needing the real 5-conjunct
  predicate should wire `@sow/policy`'s `requiresApproval` directly rather than extend this fake.
