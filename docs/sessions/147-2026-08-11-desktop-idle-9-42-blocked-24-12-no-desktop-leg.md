# 147 — desktop: idle session — 9.42's seam established-but-blocked, 24.12 has no desktop leg

**Date:** 2026-08-11
**Track / role:** main · desktop-implementer
**Predecessor session:** `docs/sessions/143-2026-07-31-delete-copilot-proposal-row-mechanism.md`
**Successor session:** _(next `/session-end`)_

---

## Why this session existed

A fresh agent-teams session resumed the build after the 2026-07-31 full-teardown seal
(`docs/team-handoffs/021-…`). desktop-implementer was spawned and registered
(`~/.claude/scripts/team-register.sh`), ran `/session-start`, and oriented on
`IMPLEMENTATION_PLAN.md` ("Currently in progress" + "Decisions tabled"), `apps/desktop/CLAUDE.md`,
`apps/desktop/LESSONS.md`'s index, and handoff 021 Part 3's two `desktop` rows — the two residuals
carried out of 9.40 (two stale present-tense comments; `Copilot.tsx`'s header quoting
`material-direction.md`'s "proposal action row"), and the ruling that produced them (delete the
mechanism, keep the goal — the goal re-tracked as `### 9.42`).

Per the plan order at resume, `9.42` sat behind worker's `13.8i-B` and `24.6` round 2 in dispatch —
so this session stood by rather than self-assigning, per standing instruction and the team-lead's
explicit "do not self-assign."

main-orchestrator then ran its own source investigation on both candidate desktop-adjacent items and
reported back **no dispatchable work exists for this area this round**:

- **`9.42`'s seam is established, not buildable.** A producer exists
  (`copilot.propose_action`/`copilot.propose_knowledge` mint a pending `Approval` and return a
  receipt carrying `approvalRef`), gated behind `resolveCopilotAgentCapability`'s `contentTrust`
  check (structurally `"untrusted"` today — no live retrieval adapter stamps
  `provenance === "knowledge_writer"`), and — the actual blocker — **the minted `approvalRef` never
  structurally crosses back to the request/response path**: `AgentResult` has exactly four fields
  and no tool-call-receipt channel. Fork ruled **Option A** (extend the existing agent-tool path; no
  second producer — a post-hoc prose classifier would infer an action from text, violating
  REQ-F-017's no-inference rule, and would be a second minting path regardless). The missing channel
  lives on `AgentResult` in `packages/providers/src/ports/` — **providers-integrations territory**,
  which has no session this round. Desktop's leg (the `{ surface: "approvals"; approvalId? }` route
  mirroring `projects`, plus the affordance) is real and correct but blocked until the producer
  lands.
- **`24.12` has no desktop leg.** The lead asked main-orchestrator to assess `24.12`'s leg 1
  (`worker-host/index.ts:178`) against desktop territory. It is a launch-time static config literal
  with no runtime state to derive "is the brain single-workspace-clean" from — it can only pass
  through a value someone else derives. Deleting the hardcoded `assign` would regress to `deny`, an
  owner-chosen-posture regression, not a fix. The remedy is knowledge-side and was dispatched as
  their slice, not desktop's.

main-orchestrator directed a clean `/session-end` this round (explicitly **not** a context-driven
cycle — nothing dispatchable, tree otherwise clean of desktop work) so the record is accurate for
whichever desktop session `9.42` re-spawns to.

## What was built

**Files created:** none.
**Files modified:** none.

No code, test, or doc changes landed in this session. The only artifact produced is this session
doc.

⚠ **Note on `git status` during this session:** the shared single-checkout working tree carries
unrelated, in-flight **uncommitted worker-implementer changes** (`apps/worker/src/boot.ts`,
`apps/worker/src/composition/buildActivities.ts`, `apps/worker/src/composition/living-vault.ts`,
`apps/worker/src/temporal/workflows.ts`, `packages/workflows/src/ports/sourceIngestion.ts`,
`packages/workflows/src/workflows/meetingCloseout.ts`,
`packages/workflows/src/workflows/sourceIngestion.ts`, plus modified/new test files under
`apps/worker/test/` and `packages/workflows/test/`, and an untracked brief
`docs/briefs/244-24.12-enforce-or-detect-unprefixed-foreign-workspace-notes.md`). None of this is
desktop's or this session's — it belongs to the concurrently-running worker-implementer's in-flight
slice (consistent with 24.12's remedy being dispatched to knowledge/worker territory above; slice
atomicity means it is not this session's to touch, inspect further, or wait on).

## Decisions made

- **Stand by rather than self-assign** when the spawn message named `9.42` as queued but the plan
  order placed worker `13.8i-B` and `24.6` round 2 ahead of it. Rationale: explicit team-lead
  instruction + the project's standing "no inventing work to fill an idle pane" discipline (021
  records that failure mode as a classification error, not diligence).
- **Do not build 9.42's route/affordance half ahead of the producer.** main-orchestrator's ruling,
  accepted as standing: a consumer built with nothing upstream is the exact shape 9.40 was deleted
  for — rebuilding it inside the task created to correct 9.40 would be self-defeating. If any future
  instruction asks for the route half in isolation, treat this session's record as the standing
  ruling and return to main-orchestrator rather than building it.
- **Do not run a full `/preflight` this session.** No desktop change exists to validate, and the
  shared tree currently holds another implementer's mid-slice uncommitted work (see note above);
  running the full gate would report on worker-implementer's in-flight state, not on anything this
  session did, and risks noise attributable to nobody. Verified instead with the two targeted
  commands main-orchestrator asked for (`git diff --stat`, `git ls-files --others --exclude-standard`
  scoped to desktop's own territory — see confirmation below).

## Decisions explicitly NOT made

- **Whether/when to fix the two stale comments** in `copilot-panel.test.tsx:478` and `:487` (both
  confirmed false as committed by main-orchestrator's re-check). Not treated as a standalone `/tdd`
  slice — no failing test can pin a stale comment — so it rides along to whichever desktop touch
  lands first, most likely `9.42` itself per main-orchestrator's instruction.
- **Whether/how `9.42` ultimately ships as a row** (satisfying `material-direction.md:57`'s
  "proposal action row" description) versus some other affordance shape. main-orchestrator
  established the seam and the blocker; the concrete UI shape is deferred to whenever the
  `AgentResult` receipt channel lands and `9.42` is actually briefed.

## TDD compliance

Clean — vacuously. No code changes landed this session, so there is nothing to have skipped a
failing-test-first step on.

## Cross-doc invariant audit

No model field changed this session (no code changes at all), so no `ARCHITECTURE.md` /
`packages/contracts/CLAUDE.md` cross-doc pairing is owed from this session.

## Reachability

Not applicable — no feature code touched this session.

## Open follow-ups

1. **`9.42` (desktop leg) — blocked, re-spawns when the producer lands.** Needs a tool-call-receipt
   channel on `AgentResult` (`packages/providers/src/ports/`) carrying the minted `approvalRef` back
   out of the agent loop — providers-integrations territory, dispatched there per main-orchestrator.
   Once it exists, desktop's leg is the `{ surface: "approvals"; approvalId? }` route (mirroring the
   existing `projects` route shape) plus the Copilot affordance that navigates to that specific
   approval by id.
2. **Two stale comments, `apps/desktop/test-dom/copilot-panel.test.tsx:478` and `:487`** — both
   describe the pre-deletion `proposalLabel` state in the present tense and are false as committed
   (9.40, `d5e987d4`). Fold into `9.42`'s slice (or whichever desktop touch lands first).
3. **`material-direction.md:57`** ("proposal action row") — confirmed DISCHARGED, not reopened.
   `24.10` (`59af727b`) already corrected the sibling line 92 (the egress pill, whose goal was
   retired) and deliberately left line 57 alone, because the proposal-action-row's goal is live —
   it is `9.42` — and the description becomes true again if `9.42` ships as a row. No action owed
   here unless a future session decides `9.42` will *not* ship as a row, in which case the doc edit
   becomes owed at that point.
4. **`24.12`** — confirmed no desktop leg exists (static launch-time config literal at
   `worker-host/index.ts:178`, no derivable runtime state). Remedy is knowledge-side and already
   dispatched as that area's slice; nothing further for desktop.

## How to use what was built

Not applicable — nothing was built this session.
