# 135 — desktop: dead CSS deletion (9.37a) + Copilot rehydrate-disclosure precondition closure (9.25, branch B)

**Date:** 2026-07-29
**Track / role:** main · desktop-implementer
**Predecessor session:** `docs/sessions/131-2026-07-29-desktop-errorboundary-and-partial-scaffold-repair.md`
**Successor session:** `docs/sessions/140-2026-07-31-copilot-seed-door-deletion-and-recent-activity-audit-drill.md`

---

## Why this session existed

Two small, deliberately-unbundled slices dispatched in sequence: task **#37(a)** (delete a dead pre-staged CSS class, taken first as deck-clearing so a slice that might legitimately halt — #25 — never carries work that depends on shipping), then task **9.25** (a recorded precondition — not a feature — that a rehydrated Copilot turn must carry derived disclosure state; establish which of its two Done-when branches is live and close on evidence).

## What was built

### Slice 1 — Commit `82ea0ebf` (1 file, +1/−2)

Deleted the orphaned `.sow-pill--zero-egress` CSS rule. Brief 205 pre-staged it for a follow-up that shipped under a different class (`sow-pill--egress-scoped`, `cda4d2f4`), meeting its own author's disposal condition. No test added — a test asserting a CSS class doesn't exist would be a decorative pin on a negative claim, exactly what task 9.25's stop-condition-1 forbids one brief over; shipped on the reference search plus the unchanged suite instead.

**Files:** modified `apps/desktop/renderer/styles.css`.

### Slice 2 — Commit `b7f39544` (2 files, +264/−0)

Established branch (B) of 9.25's Done-when from source: no production Copilot restore/rehydrate path exists today (sole production `<Copilot>` render is `AppShell.tsx:493`, unaliased, passes no `turns`; `dev/seed.ts` seeds zero Copilot turns; zero `localStorage`/`sessionStorage`/`indexedDB` anywhere in `renderer/`; the seed door's only consumer anywhere in `apps/desktop` is a test file). Built a mechanically non-vacuous tripwire pinning that absence — see "Decisions made" for why this took three rounds and where it stopped.

**Files:** new `apps/desktop/test/renderer/copilot-rehydrate-seam.test.ts`; a one-comment cross-reference addition (no assertion change) to `apps/desktop/test-dom/copilot-panel.test.tsx`.

## Decisions made

- **9.37(a) — the rule was SHARED, and a literal name search could not have told us.** `.sow-pill--egress-false, .sow-pill--zero-egress { ... }` was one CSS rule with two selectors. `.sow-pill--egress-false` is genuinely live — but it is constructed by TEMPLATE INTERPOLATION at `egress.tsx:230` (`` `sow-pill sow-pill--egress-${String(cell.status.employerRawEgressAcknowledged)}` ``), so no literal occurrence of that exact class name exists anywhere in the TSX. A grep for the class name, alone, returns "zero references" for a class with a real, live consumer — **I nearly deleted the whole rule block on the strength of that search.** Caught by reading the CSS rule itself before deleting (it was a shared selector list, not a single-class rule) and cross-checking the TSX for how the sibling class was actually built. Deleted only the dead selector; the live rule's declaration and `sow-pill--egress-scoped` are untouched. **This near-miss is worth more than the deletion itself** — the general lesson: a "zero references" claim about a CSS class needs an interpolation-aware search (grep the shared *prefix*, not just the full literal name), because a template-interpolated class can be live with no literal occurrence anywhere.
- **9.37(a) — the one comment hit was a mention, not a use, and I classified it by reading rather than by the search tool's verdict.** `test/renderer/chrome-egress-claim.test.ts:34` names `sow-pill--zero-egress` in a comment explaining why a DIFFERENT test's word-boundary regex (guarding an older, unrelated dead class) must not misfire on double-dash classes. It is a discussion of the token, not a use of it — reading the surrounding test confirmed the deletion doesn't affect that test's behavior at all.
- **9.25 — branch (B), established from source, not inherited from the brief or the prior audit.** Checked a construction route neither the 9.24 trace nor the Phase-9 reachability audit had: `localStorage`/`sessionStorage`/`indexedDB` — zero occurrences anywhere in `renderer/`, closing off a persisted-rehydration route as a possibility.
- **9.25 — three rounds of adversarial security review, each finding a REAL (demonstrated, not theoretical) gap in the evidence tripwire, and the hole MOVED rather than shrank each time:**
  1. A regex scanner for `<Copilot ... turns=` usage was defeated by two idioms already ordinary in this exact file set: a JSX spread attribute (`{...props}`, as used at this file's own `{...roving.listboxProps}`) and a bare `>` inside an earlier JS expression (`.length > 0`, idiomatic at `Copilot.tsx:196`) truncating the tag capture before a later real `turns=` was seen.
  2. Rewritten on the TypeScript compiler API (real JSX/TSX parsing, no regex) — closed both. The reviewer then found the AST version still matched a bare tag-name string `"Copilot"` with no import-binding resolution: an aliased import (`import { Copilot as X }`), a namespace tag (`<M.Copilot>`), or `React.createElement(Copilot, ...)` would all evade it silently.
  3. Resolved the tag name against the file's own `import` declarations instead of a literal string (handles `as`-aliasing and namespace imports). The reviewer, independently re-extracting and re-running the logic (not just re-reading the diff), then found a THIRD gap: barrel re-export indirection. Realistic, not contrived — `renderer/surfaces/copilot/` is the ONLY one of seven `renderer/surfaces/*` subdirectories without an `index.ts` barrel today; the other six already have one, so adding one for consistency is a mundane, foreseeable refactor, not an adversarial attack shape.
  4. Closed with one more named, blunt tripwire (matching an already-accepted precedent — see below): assert no `index.ts`/`index.tsx` barrel exists under `renderer/surfaces/copilot/` today.
  Every closure was mutation-verified myself before reporting it (mutate the real `AppShell.tsx` call site, observe RED, revert, confirm a clean `git diff`) — not trusted on the reviewer's say-so, and not merely asserted possible.
- **9.25 — WHY the round stopped at three passes rather than requesting a fourth (the lead's ruling, and the reasoning matters more than the number):** the underlying shape is that *"no production consumer exists"* is a negative claim over an **unbounded construction space** — the ways to render/construct a component are open-ended (aliasing, namespacing, re-export chains, imperative construction, and whatever comes after those), so a scanner over that space is a **detector**, not a **gate**. Three consecutive rounds each closed a real, demonstrated gap; a fourth might find a fourth. The realistic *accident* shape — someone adding restore and passing `turns=` at the one real call site, literally, via a spread, via an alias, or via a namespace tag — is fully caught. What survives requires *deliberate* indirection (a 2-hop barrel chain, or `createElement` behind a differently-named barrel), which is not how a feature gets added by accident, and the tripwire is a **backstop**, not the primary defense — 9.25 stays a live line in the tracker, read by whoever builds restore. **A future reader must not read "stopped at 3 rounds" as fatigue** — it is a deliberate stopping point once the realistic-accident space was covered and the remainder was named rather than chased.
- **9.25 — two residuals remain, explicitly NAMED in the test file's header, not silently accepted:** (a) `createElement`/`cloneElement` construction is caught file-wide (a blunt tripwire: no production renderer file may call either, at all, for any reason), not resolved to Copilot specifically; (b) a barrel is caught by its mere EXISTENCE under `renderer/surfaces/copilot/`, not by following what it re-exports, so a 2-hop re-export chain or a differently-named/located barrel would still evade it in principle. Both mirror the same honest-scoping posture: cheap, real, and will force a human look the day either stops being true, rather than silently staying green over a blind spot.
- **9.25 — no new test for the missing-disclosure-signal characterization bullet.** Found that `copilot-panel.test.tsx:114` already exercises the seed door with `egressProcessor` omitted, and the pre-existing 9.24 header comment there (`:243-250`) already documents, in these words, that a well-formed answer missing only that field is "by construction indistinguishable" from a genuine non-disclosing answer — attributed explicitly to producer/consumer closures, not the renderer. Since `admitReply` gates both the live-ask door and the `turns` seed door identically, a new test would re-exercise the same code path with the same assertion shape. Added a one-comment cross-reference instead of a duplicate pin.

## Decisions explicitly NOT made

- **9.25 — this closes the TASK, not the RISK.** Disclosure-on-rehydrate is NOT solved; it is currently unreachable because nothing rehydrates. The moment a restore path lands, rehydrating a stored Employer-Work cloud answer without carrying its disclosure forward is live case 3 from 9.24 (a real, plausible answer rendered silently, indistinguishable from a genuine non-cloud one). 9.25 stays a dormant, live precondition in the tracker for whoever builds that work — not ticked-and-forgotten.
- **9.25 — the structural alternative NOT taken this round, recorded as the shape for whenever this needs to be airtight:** delete the `turns` mount-time seed door entirely and have tests construct turn state some other way (e.g., a test-only factory function, or driving the real live-ask path with a fake `onAsk`). If there is no seed door at all, there is nothing for a scanner to police, and the entire class of "did a scanner miss a construction route" finding stops being possible by construction rather than by detection. Not done this round — the seed door is real, documented, test-legitimate infrastructure ("MOUNT-TIME seed input... tests; a future restore, task #13"), and removing it was out of this slice's scope (Q2/Q3 both said don't touch `Copilot.tsx`).
- **9.25 — no fourth adversarial review round**, per the lead's explicit ruling (recorded above under "Decisions made" since the reasoning is as important as the outcome).
- **Neither slice touches `packages/contracts` or `packages/domain`.** Cross-doc invariant audit: N/A both slices.
- **9.37(a) — did not "fix" or re-point** `test/renderer/chrome-egress-claim.test.ts:34`'s comment to name a different double-dash class as its illustrative example, even though the class it currently names is now gone from the CSS. It's still illustrative of the general double-dash hazard the comment explains; the orchestrator's call, not mine, and not for this CSS-only diff.

## TDD compliance

**9.37(a):** clean, by the brief's own explicit design — no RED test exists because a negative-existence pin on a CSS class would be decorative; shipped on the reference search + unchanged green suite instead (stated, not silently substituted).

**9.25:** an unusual shape worth naming rather than glossing: the "test" IS the evidence for a task closure, not a pin proven against a pre-existing implementation. Each of the three hardening rounds followed a real RED→GREEN cycle (write/revise the scanner, mutation-verify it fails on a real violation, confirm it passes clean) rather than writing assertions after the fact — but there was no separate "production code" being test-driven, since branch (B)'s deliverable is the evidence itself. No violation; a different, brief-anticipated shape.

## Reachability

- **9.37(a):** N/A — a removal. Verified the inverse question (no production or test consumer of the deleted selector) before deleting, per the brief's own "Step 7.5" framing.
- **9.25:** N/A under branch (B) — no new wiring; the deliverable is a tripwire over an intentionally-unwired seam. Wiring will land with whatever future slice builds Copilot history/restore.

## Open follow-ups

**Routed hot at Step 9 (orchestrator/lead territory — not mine to edit):**
- Tracker prose for 9.37(a) and 9.25 closures — the lead/orchestrator write these; my Step-9 reports supplied the branch/evidence detail needed to write them accurately (not phrasable as "solved" for 9.25, per stop-condition 2).
- Any lesson banked from the three-round hardening pattern (a negative claim over an unbounded construction space is a detector, not a gate) is the orchestrator's/lead's call on numbering and exact wording — I supplied the raw material in my Step-9 report and above.

**Desktop queue, not picked up this session:**
- **#13** — precondition on Copilot history/restore carrying derived disclosure state; this is now literally what 9.25 is a precondition FOR. Unchanged from prior session docs.
- The structural alternative named above (delete the `turns` seed door, construct turns another way in tests) — recorded as a shape for a future round if/when 9.25 needs to become airtight rather than a backstop; not a task today.
- Three deferred code-quality lows from the 9.35/9.21-B slices (doc 131) remain outstanding, unrelated to this session's slices.

**A real limit of the corrected shared-tree commit discipline, worth recording plainly so it isn't mistaken for the new procedure being broken:** `git commit -F <msgfile> -- <path>` cannot pick up a genuinely untracked/new file — it errors `did not match any file(s) known to git`. A new file still needs `git add <path>` first (explicit, per-file, never `-A`); the correction is that the **pathspec stays on the `git commit` invocation itself** as the actual filter, so even if something else were staged by another agent between the add and the commit, the commit would still be limited to the named paths — the `add` step is unavoidable plumbing for a new file, not the gate.

## `/preflight` note

`apps/desktop` (3 tsc passes, run standalone): clean, both slices. `apps/desktop` test suite: 501 (post-9.21-B) → 501 (9.37a, CSS-only, no test count change) → 503 (9.25, +2 net after 3 rounds of test-file rewrites). All green, no regressions. **"typecheck + tests clean; no lint coverage exists"** — `pnpm lint` is `tsc --noEmit`; no ESLint installed; no `format:check` anywhere. Did not chase the recorded `main-bundle-resolution.test.ts` repo-wide transient (not touched by either slice).
