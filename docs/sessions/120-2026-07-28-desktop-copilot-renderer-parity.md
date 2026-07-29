# 120 — desktop: Copilot renderer parity (9.26 re-validation + 9.28 disclosure travels with the answer)

**Date:** 2026-07-28
**Track / role:** main · desktop-implementer
**Predecessor session:** `docs/sessions/119-2026-07-26-desktop-egress-surface-chrome-claim-copilot-omission.md`
**Successor session:** `docs/sessions/129-2026-07-29-desktop-copilot-reply-brand-and-egress-posture-render.md`

---

## Why this session existed

Both tasks came out of **my own 9.24 trace last session** (doc 119), as latent routes rather than live defects:

- **9.26** — `copilot-ask.ts` was the only renderer read path with **no** client-side re-validation. Its four siblings in `live.ts` re-gate worker output as candidate data; this one checked `res.value != null` and rendered a server-derived string straight into the DOM.
- **9.28** — `copilotBriefing` / `copilotConcept` already return notice-bearing answers and have **no renderer consumer**. The first surface to render one by re-mapping fields would drop the rule-5 egress disclosure by forgetting a line.

Bundled by lead instruction: same surface, same reasoning, neither live.

## What was built

**Commit `f0cc804c`** — 4 files, +289/−66.

**Files created**
- `apps/desktop/test/renderer/copilot-ask.test.ts` — node-tier tests for the re-gate. ⚠ This module had **no unit test at all**, while its siblings (`approval-decision`, `triage-disposition`, `connector-config`) each have one — a second asymmetry on the same path 9.26 was about.

**Files modified**
- `renderer/lib/copilot-ask.ts` — added a `UiSafeCopilotAnswerSchema.safeParse` re-gate folding to the existing `{ok:false}` → `ASK_FAILED` path.
- `renderer/surfaces/copilot/Copilot.tsx` — `CopilotTurnView` now holds `reply: UiSafeCopilotAnswer` verbatim instead of flattened fields; new exported `CopilotAnswerView` renders body + notice + citations together; `finish` reduced to `reply: admitReply(result.answer)`; `admitReply` added and applied at **both doors** into turn state.
- `test-dom/copilot-panel.test.tsx` — 5 fixtures reshaped; 3 new tests for the shared view.

## Decisions made

- **Stop flattening, don't just add a component.** The brief voted for a shared answer component; a component taking *destructured* props would have left the actual vector — the field-by-field re-map in `finish` — untouched. Holding the contract object whole removes the mapping rather than relocating it. Orchestrator ratified this over the brief's own default.
- **Admission at BOTH doors.** `seedTurns` reaches `useState` directly and bypasses `finish`, so a `finish`-only guard was structurally blind to it. Independent of, and identical in shape to, knowledge's 13.8k the same round.
- **Reuse the contract schema, never a hand-rolled predicate** (forbidden-pattern #6). My first guard was `Array.isArray(reply.answer) && Array.isArray(reply.citations)` — both reviewers independently showed it admitted `{answer: []}` (a **blank answer bubble rendering as a completed turn**), `egressProcessor: {}` and `citations: [null]` (both throw at render), and `egressProcessor: ["x","y"]` — **a fabricated disclosure label**.
- **The over-rejection fixture is parsed through the contract schema, not hand-built**, at the cap boundaries (40 blocks / 20 citations / 1024-char label). An over-strict re-gate silently converts working answers into `ASK_FAILED`, which reads as a worker fault and is *harder* to diagnose than no re-gate.
- **Pathspec-limited commit** — see the finding below.

## Decisions explicitly NOT made

- **Branding the reply (→ task 9.34).** Closing the residual properly needs a reply mintable only from a validated wire payload. Not taken in-slice: it changes the renderer's Copilot API shape and a future briefing consumer's ergonomics, on an already-reviewed slice.
- **An ErrorBoundary (→ task 9.35).** Desktop-wide, out of scope here.
- **Nothing about what the notice MEANS.** Case 2 (non-Employer-Work cloud egress renders nothing) is owner-chosen; `notice_is_scope_blind_at_the_renderer` still pins that the renderer cannot see workspace type.

## ⚠ Corrections to my own claims (both caught at review, both material)

1. **"The drop vector is eliminated" was FALSE.** `egressProcessor` is optional on the contract, so a hand-built partial literal still compiles with no missing- and no excess-property error:
   `reply: { answer: r.answer.answer, citations: r.answer.citations }` — disclosure dropped. The vector **moved one level up**; it did not disappear. My "honest bound" even named the wrong residual (hand-rolled JSX — unlikely) and missed the likely one (a two-line literal). Both durable comments now say *biased against, not eliminated* and name the real residual. **Same overclaim class as the chrome badge I removed last session, this time in my own work.**
2. **`notice_is_scope_blind_at_the_renderer` was never reshaped.** I reported it as one of the three reshaped pins; it isn't in the diff (it drives the live `onAsk` path, which always carried the nested shape). The mutation evidence stands; the framing was wrong.

## TDD compliance

**Clean.** RED confirmed for the right reason (the malformed-payload case failed with no re-gate present; the other four passed because they pin pre-existing behaviour). All post-review hardening was re-verified green.

**The mandatory post-reshape mutation ADD caught a real regression, not a stale fixture.** Deleting the re-map also deleted the **throw** that had been landing contract-violating payloads on `ASK_FAILED`. With the answer carried verbatim, a malformed reply would instead throw inside `CopilotAnswerView` during **render** — and there is no ErrorBoundary anywhere in `apps/desktop`, so React 18 unmounts the **entire root**, not just the panel. A reshaped 9.24 pin went RED and surfaced it.

**Per-pin mutation table (run AFTER the reshape, by breaking behaviour — not by inspection):**

| Mutation | exact-equality | leak-shape | scope-blind |
|---|---|---|---|
| suppress the notice | **RED** | **RED** | **RED** |
| change banner copy | **RED** | green | green |
| sanitize the label | green | **RED** | green |

Each discriminates something *different*. Every mutation was restored and the tree verified clean before proceeding.

**Two pin names were renamed for asserting more than their bodies observe (L67):** `notice_bearing_briefing_and_concept_are_covered` exercises no briefing or concept code — it renders a briefing-*shaped* literal through the shared view. Renamed to what it actually checks, so a later audit can't count it as briefing coverage.

## Cross-doc invariant audit

**Clean.** `f0cc804c` touches no `packages/contracts` or `packages/domain` file. `UiSafeCopilotAnswer` is untouched, so 9.27's territory stays clear. Nothing was owed at Step 9.

## Reachability

Live path confirmed: `live.ts:150 createAskCopilot` → `App.tsx:149 askCopilot` → `AppShell` → `Copilot onAsk`. The seed `turns` prop is test-only (the live app never passes it) and now also admitted. No tested-but-unwired code.

---

## ⛔ FINDING — stage-then-commit is unsafe in a shared tree

At Step 10, three `packages/evals/*` files were already **staged in the shared index** by the evals implementer (12.25, in flight). A plain `git commit` would have swept another track's in-flight work into a rule-5 commit — **the `225c10ca` mixed-commit failure class, which nearly recurred**.

Used a **pathspec-limited commit** (`git commit -- <my 4 paths>`); `git show --stat` confirms exactly 4 desktop files, zero evals content.

**Side effect, relayed immediately:** the pathspec commit reset the index for non-committed paths, so those three files went staged → unstaged. **No content was lost** (verified still differing from HEAD: +14/−3, +53/−8, +78/−0); evals only needs to `git add` again.

**Rule worth adopting while several impls share one tree:** an implementer can inherit another's staged files between `add` and `commit`. `git commit -- <paths>` (or `add` immediately before a pathspec commit) makes capturing someone else's work **structurally impossible** rather than a matter of noticing.

## Open follow-ups

**Desktop queue:**
- **#8** — deliver 9.10-C acceptance bullet 1 (zero-egress posture). **Blocked**: needs 9.22 / the #21 producer predicates. ⚠ The honest copy has narrowed twice — `zeroEgressOnly` measures **model-provider routes only** (connector reads and Tool-Gateway writes never consult `egressPolicy`), now also requires a non-empty model config, and per 9.32 is currently **unsatisfiable in production**, so `false` is the only reachable value and means **UNKNOWN**, never "cloud egress is possible."
- **#34** — brand the Copilot reply so `reply:` is uninhabitable by a hand-built literal (closes 9.28's relocated residual; would make the acceptance wording literally true).
- **#35** — no `ErrorBoundary` anywhere in `apps/desktop`: any render-time throw unmounts the whole root.
- **#13** — precondition on any future Copilot history/restore: rehydrating a stored employer cloud answer without its notice IS live case 3.
- **`/phase-exit 9` — still held.** Blocked by 9.21 plus the outstanding `[~]` legs, and needs owner-approved deferrals. The Phase-9 "Acceptance criteria (9)" line is **stale** (still lists 9.9/9.12 as absent and 9.11 first-run as incomplete, all landed) and must be reconciled first or the gate audits against a false blocker list.

**Deferred (low, from review):** the `.strict()` re-gate is a forward-compat hazard only if an additive contract field ships worker-first against a stale renderer bundle (non-issue while they ship as one artifact); the cap-boundary pin proves schema↔schema identity in-process, not transport fidelity.
