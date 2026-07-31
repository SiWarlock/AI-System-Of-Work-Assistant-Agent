# 143 — desktop: delete the Copilot proposal-row mechanism (9.40)

**Date:** 2026-07-31
**Track / role:** main · desktop-implementer
**Predecessor session:** `docs/sessions/140-2026-07-31-copilot-seed-door-deletion-and-recent-activity-audit-drill.md`
**Successor session:** _(next `/session-end`)_

---

## Why this session existed

A cycled desktop-implementer respawned mid-round with no queue (9.41's three legs and 9.37 both
closed by the predecessor). Held per standing instruction rather than self-dispatching. The
orchestrator then dispatched task **9.40** — a lead ruling on the Copilot proposal-row affordance
(brief `docs/briefs/242-9.40-delete-the-proposal-row-mechanism-keep-the-goal.md`, `@5ac5ec41`,
spec-lint PASS): **delete the mechanism, keep the goal.** `UiSafeCopilotAnswer` structurally cannot
carry an approval id for any producer that could exist, so the renderer-local `proposalLabel` field,
its render branch, and its branch-only CSS were removed; the underlying product commitment (an
answer implying an action leads the owner to Approvals) is re-tracked as a separate task, which the
orchestrator opens (not this session's territory).

## What was built

**Files modified (1 commit, `d5e987d4`):**
- `apps/desktop/renderer/surfaces/copilot/Copilot.tsx` — removed `proposalLabel?: string` from
  `CopilotTurnView`, the render branch in `CopilotTurn` (the `.sow-copilot-proposal` row + the
  permanently-`disabled` "Review in Approvals" button), and dropped `CopilotTurn`'s `export` (its
  only external consumer was the deleted test; the same-file JSX use at `:359` needs no export).
  Updated the file-header docblock's load-bearing paragraph to note the deletion + rationale.
- `apps/desktop/renderer/styles.css` — removed the four branch-only rules: `.sow-copilot-proposal`,
  `.sow-copilot-proposal-label`, `.sow-copilot-proposal-go`, `.sow-copilot-proposal-go:disabled`.
  Confirmed branch-only by repo-wide grep before deleting (zero consumers outside the deleted
  render branch + the test file).
- `apps/desktop/test-dom/copilot-panel.test.tsx` — dropped the `CopilotTurn` import; deleted the one
  `it` that constructed the proposal-row branch directly (old `:115-137`); retitled and trimmed the
  adjacent surviving test ("...renders a bare answer (false branches)" → "...(false branch)"),
  removing a now-vacuous `expect(document.querySelector(".sow-copilot-proposal")).toBeNull()`
  assertion and its stale justification comment (both would have asserted the absence of something
  no longer representable — a tautology, not a regression pin); added one new type-level RED test
  (`proposalLabel no longer exists on CopilotTurnView`, contracts L87's "RED-for-an-unused-
  `@ts-expect-error`" technique, mirroring this file's existing 9.34 brand-test pattern).

## Decisions made

- **CSS branch-only → delete all four rules.** Verified by grep before touching anything (brief's
  Step-2.5 flag #1); no shared class was at risk.
- **`CopilotTurn` export → dropped.** Verified zero external importers (grep + independent
  confirmation from both Step-8 reviewers); the same-file JSX call site doesn't need the keyword.
  Not kept out of churn-aversion, per the brief's explicit warning against that.
- **The vacuous `.sow-copilot-proposal` absence assertion → deleted, not relabeled.** The brief's
  Step-2.5 orchestrator TWEAK asked for an explicit choice between deleting it or keeping it as a
  labeled stays-deleted regression pin. Chose delete: the type-level pin already makes the field
  unrepresentable on `CopilotTurnView`, so a relabeled runtime assertion that can never fail would
  be documentation wearing a test's clothes, not additional coverage.
- **Bullet-7 (no behavior change) evidence → the repo-wide typecheck, not the two runtime tests.**
  Also a Step-2.5 TWEAK. With the field removed, any surviving production or test producer of
  `proposalLabel` becomes a compile error — the exhaustive proof, not a sample. The two runtime
  tests are corroboration.

## Decisions explicitly NOT made

- **The successor task naming the corrected producer shape** (an approval id threaded from a turn
  to an Approvals entry) — orchestrator territory per the brief; not opened this session.
- **The file-header docblock's opening `material-direction.md` design-doc quote** still lists
  "proposal action row" as part of Copilot's locked composition spec (lines 1-4, pre-existing, not
  touched by this diff). Both Step-8 reviewers flagged this as a low-severity nit and judged it
  non-misleading (it describes the kept *goal*, not current behavior) and out of this slice's scope
  — `docs/design/**` is not desktop territory. Deferred, not fixed. **ADDENDUM (post-commit, from the
  orchestrator):** the successor task materialized as **task 9.42**; the docblock observation is
  routed against 9.42 (the composition claim becomes true again if the affordance is rebuilt there)
  **and** into round-2's **DOC-1** scope (a docs/design-authority review partition that did not run
  this round) — because a locked design-authority document (`material-direction.md`) asserting a
  since-removed UI element is the same shape the "Egress: local-only" hardcoded-pill defect had at
  its root, and this reviewer found an instance of that class from inside an ordinary code slice. Not
  edited here; recorded so it survives the harness task list.

## TDD compliance

**Clean.** This was a deletion slice, so RED/GREEN inverted per the brief's own framing: the "failing
test first" was a type-level pin (`@ts-expect-error` on a `proposalLabel` object-literal property)
that was genuinely RED before the change — `proposalLabel` still existed on `CopilotTurnView`, so
the directive was unused, and `tsc --noEmit -p tsconfig.testdom.json` reported `TS2578: Unused
'@ts-expect-error' directive`. Confirmed RED at Step 3 before touching `Copilot.tsx`. Removing the
field turned it GREEN (confirmed no-errors at Step 5). `vitest run` alone could not see this pin —
esbuild strips `@ts-expect-error` without checking it — so the RED/GREEN confirmation ran through
`tsc --noEmit`, not the test runner, and that distinction was stated explicitly at Step 2.5.

## Reachability

N/A for this slice — pure deletion, no new entry point. `<Copilot>` remains AppShell's existing live
mount; wiring is unchanged. No tested-but-unwired gap introduced.

## Reviewers (Step 8, invariant-touching — `Copilot.tsx` carries 9.24/9.28/9.34 rule-5 assertions
adjacent to the deletion)

- **security-reviewer: 0 findings.** Confirmed the 9.24 (`:159`→new `:133`, `:275`→new `:249`), 9.28
  (`:408`→new `:407`), and 9.34 (`:474`→new `:448`) describe blocks are **byte-identical**
  HEAD-to-working-tree via direct line-range diff, not just hunk inspection. Confirmed
  `CopilotAnswerView`/`admitReply`/`AdmittedCopilotAnswer` disclosure machinery completely untouched
  by the diff's three hunks.
- **code-quality-reviewer: 1 low finding, deferred** (the docblock quote, above). Confirmed the
  `@ts-expect-error` placement is idiomatic (TS's excess-property-check reports at the specific
  offending property inside a multi-line literal, so the directive sits directly above
  `proposalLabel: "should not compile",` rather than above the whole statement) and that it pins
  what it claims. Confirmed no L93/L94 citation-rot and no L103 violation — the deletion *is* the
  unrepresentable-state fix, stronger than the disabled-button belt-and-suspenders it replaces.

Both reviewers independently re-verified byte-unchanged / zero-external-importers before the Step-10
commit, and I re-verified both again immediately before committing (hunk-level `git diff` inspection
showing only 3 hunks — import removal, the transcript-describe splice, and the appended new
describe — none inside a rule-5 block).

## Open follow-ups

- **Successor task for the goal** (an answer implying an action → Approvals, via a producer shape
  carrying a turn→approval id) — orchestrator opens this per the ruling; not tracked here beyond
  this pointer.
- **Docblock quote nit** (deferred, low severity, both reviewers concur) — see "Decisions explicitly
  NOT made" above. No task opened; noted here per L51 so it isn't lost only in reviewer output.
- **Cross-doc invariant audit: N/A.** `proposalLabel` was renderer-local (not a contract model);
  zero `ARCHITECTURE.md` diff exists or is owed. Confirmed via `git diff -- ARCHITECTURE.md`
  (empty) before writing this doc.
- **Step-9 items:** already routed hot to the orchestrator during the session (commit message,
  judgement calls, reviewer findings) — nothing additional to route here.

## How to use what was built

Nothing new to wire or invoke — this is a subtractive change. A future slice building the successor
task's producer shape should read this doc's "Decisions made" for why the old shape (`proposalLabel?:
string`) was rejected, so the new shape doesn't repeat the same defect (no approval id to navigate
to).
