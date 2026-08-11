# 022 — ORCHESTRATOR STATE DUMP (round NOT sealed)

**Date:** 2026-08-11 · **Track:** single-track `main` · **Author:** `main-orchestrator` at **79% [ACTION]**
**Status:** ⚠ **PARTIALLY SUPERSEDED — the round WAS sealed after this was written.** `IMPLEMENTATION_PLAN.md`'s *"Currently in progress"* now carries the seal state. ⛔ **THE FULL `/orchestrate-end` WAS STILL NOT RUN** — at ACTION tier the orchestrator wrote the seal's LOAD-BEARING sections directly rather than load the whole command and risk stopping mid-way. ⭐ **STILL OWED, and a successor must do them: (1) the round's Log entry appended to `docs/archive/IMPLEMENTATION_LOG.md`, (2) a Carry-forward TRIAGE pass (the list is at its ~7 cap and was not triaged this round), (3) folding round 4's three partition reports into an `docs/audits/004`.** ⚠ **This file remains the fullest record of what is OWED and UNSWEPT — read it alongside the seal, not instead of it.**

> ⛔ **WHY, AND IT WAS PRE-DECIDED SO IT WOULD NOT BE JUDGED AT 80%:** the lead ruled that if `/orchestrate-end` could not be completed **with room to spare**, it must not be started — ⭐ ***"a half-written seal is worse than an honest dump: it looks complete."*** **A successor orchestrator seals from this file.**
> ⚠ **Verify EVERY literal below by command. Do not quote a hash or a count from this prose** — `git status` returns the literal string `ok` here and **so does `git commit`'s receipt** (contracts **L133**); use `git log` / `git diff` / `git ls-files`.

---

## ⭐ THE ROUND'S HEADLINE — put this before any finding list

> ***The project reliably CATCHES this defect class; what it fails at is PROPAGATING the catch.***

⭐ **Reached INDEPENDENTLY by two partitions from opposite ends:** `PRE-1` from the arming ledgers (which are *saturated* with self-caught instances — `13.8j`, `13.8k`, `13.8m`, `9.40`/`9.42`, `§ARM-18`'s `✅ RETIRED` chain — **every one already resolved or honestly labelled**), and `LES-1` from `L101` (**corrected in the plan 2026-07-30, never propagated to the lessons ledger or the forbidden-patterns block, and cited as justification by a brief one day later**).
⇒ ⛔ **THE FIX IS NOT BETTER DETECTION. IT IS PROPAGATION DISCIPLINE.**

**Three of the round's instances are the orchestrator's own, and they belong here as EVIDENCE, not apology:**
1. **`13.8i-B` sat `State: OPEN` while `fdbc2c85` was merged** — Step 9 routed, commit message written, tick never applied. Caught by `PRE-1`. ⚠ `§ARM-RESEARCH` precondition (1) cites that arc, so a stale `OPEN` would have made a **satisfied** arming precondition read as unmet.
2. **A literal `HEAD fa46c104` written into the round-open early write**, found by `PRE-1` citing a HEAD ~31 commits behind live — **after a round spent telling everyone else to verify by command.**
3. ⛔ **The per-slice `/context-check --snapshot` step NEVER RAN.** The protocol puts that ping on the orchestrator; **the lead found the WARN tier by looking.** ⭐ **L89's shape: a step that reports nothing reads as a step that passed** — and the omission removed the only scheduled signal, from the most-constrained session.

---

## What landed (verify with `git log`)

**Round opened at `fa46c104`. ~40 commits. Push is OWNER-RUN; nothing pushed.**

| Slice | Commit | Note |
|---|---|---|
| `13.8i-B` bind ProposeKnowledgeApprovalPort | `fdbc2c85` | ⛔ zero-cards basis MOVED to upstream dormancy alone — **one gate where lead decision 12 implied two**; made executable via a per-path test + an in-code *"there is no second propose-side gate"* line. **That line is load-bearing.** |
| `13.23` leg A WithheldReason channel | `206279c5` | sparse map; `security-reviewer` low **fixed in-slice** → **L128** |
| `24.16` health-signal rename | `0de758d1` | caught citation rot **its own rename created** |
| `24.12` workspace-path guard | `c86030f9` | ⛔ **condition (a)'s remedy.** The fix for a rule-4 finding **contained a rule-4 hole** (traversal through the exemption) → **L135** |
| `24.14` derive coding-session trust | `f10a49f5` | rule 6; severity lowered by its own investigation → `24.22` |
| `24.17` GCL gate on the cross-workspace read | `004ad65c` | ⛔ **condition (b)'s remedy.** Two independent gates; both withheld paths counted |
| `24.10` line-92 design-authority fix | `59af727b` | owner-authorized, **one edit only** |
| `24.12` test-fixture sibling | `4a2e5388` | knowledge, under contracts **L121**'s narrow form |

**Lessons banked: L124–L135.** ⚠ **L131 was AMENDED after banking** — *outcome-phrasing buys **checkability**, not **truth***.
**Audit reports:** `docs/audits/002-…-round-2.md` · `docs/audits/003-…-round-3.md`. **Round 4's three partitions are recorded in `IMPLEMENTATION_PLAN.md`, not in a separate report — a successor should fold them into an `004` or extend `003`.**

## ⛔ The three block-release conditions — NONE discharged

**All three are OUTCOME-phrased** (they were re-classified after the lead's own `(b)` and the orchestrator's own `(a)` were both found action-shaped).

- **(a)** a foreign-workspace unprefixed write is **rejected BY THE PRODUCTION PATH**, pinned by a test that reds if the pipeline step is removed. ⭐ **Remedy LANDED (`c86030f9`) WITH the wiring pin** — mutation-verified on the **pipeline loop**, not the predicate. ⚠ **Residual `### 24.23`: `workspace_path_violation` flattens to `commit_failed` at `mapWriteFailure`'s `default:`. The write is still REJECTED — fail-closed holds, only the REASON is lost.**
- **(b)** the wired cross-workspace read goes **through** the GCL gate with the ceiling **re-derived**, not frozen. ⭐ **Remedy LANDED (`004ad65c`).** ⚠ **Someone must confirm this DISCHARGES (b) — the orchestrator did not make that call.**
- **(c)** the turn-on runbook covers **all EIGHT** hard-line crossings, crossing 8 / RES-1 included, **and its stage count is DERIVED from `ARCHITECTURE.md`, not asserted in prose.** ⛔ **OPEN — gates on `### 24.5`'s CORRECTION, not a parallel task.** ⭐ **The derivation clause is load-bearing: *"7 hard-line stages"* WAS an asserted constant, so restating a corrected number re-arms the trap.**

## Open findings → tasks (all recorded, none fixed unless noted)

`24.7` (HIGH, arming-blocker) · `24.8` · `24.9` · `24.11` · `24.13` · `24.15` · **`24.17` ✅** · `24.18` · `24.19` · **`24.20` = condition (c)** · `24.21` · `24.22` · `24.23` · `24.24` · `12.24` · `13.23` legs B/C.

⭐ **`24.7`/`24.9`'s zero-caller claims WERE RE-VERIFIED (`8f87ca8d`) — DO NOT REASSIGN.** ⚠ The lead's reassignment crossed with the work. **Method recorded on the task: grep-and-classify with every hit READ, NOT `codegraph_callers`** — which round 4 found **under-reporting** call sites living in object-literal property values and factory closures, **this codebase's dominant idiom.** ⛔ **An under-reported caller would have made `24.7` a FALSE finding, blocking arming on a defect that does not exist.**

## ⛔ Owed, and stated so it cannot read as done

- **The ~200 per-task `Done-when` action-vs-outcome sweep** — owner-scoped out of round 4 deliberately. ⭐ **The lead's reason for trusting the rest is that the exclusion is STATED.**
- **`LES-1`: ~45 of 132 lessons full-texted, and ZERO pins verified by RUNNING a suite** — existence/content-match only. ⛔ **L89 established this project's `lint` gate checks nothing it claims, so *"the test exists and the name matches"* is precisely the evidence class this project has been burned by.** **Round-5 material; round 4 did NOT clear that ledger.**
- **`PRE-1`: ~195 of 203 `Depends:` lines and 23 of 25 acceptance blocks unswept**, plus 12 archived `/phase-exit CLEAR` checklists never opened. ⚠ **A `CLEAR` gate read alone implies more than the phase's own hedged acceptance block says** — Phase 7 is `[~] PARTIAL` with a previously false-ticked task, and **nobody has checked whether another `CLEAR` phase's Residuals hide an unflagged instance.**
- ⚠ **`PRE-1`'s search key (a ⛔/⚠ warning-comment on a ticked task) finds the NOTICED-BUT-UNFIXED cases and is BLIND to the never-noticed ones.** ⛔ **A clean `PRE-1` must not read as a swept surface.**
- **Desktop re-spawn**, owed at `24.12`'s commit (now landed): the `worker-host/index.ts:178` operator-guard comment **plus** its two 9.40 stale comments. **Draft text is in the tracker under `24.12`.**
- **The `LEGACY_UNPREFIXED_WORKSPACE_ID` composition-root single-sourcing** — a tracked **worker wiring leg**, not a note.
- **`/team-end`'s registry-cleanup field bug (`.track_label` → `.track`) is STILL LIVE** — desktop's entry survived shutdown as a corpse reporting 16% and the lead pruned it by hand. ⛔ **A stale entry skews the aggregate that decides when the next team cycles.**

## Team state at dump time

All three implementers **committed their slices and are running `/session-end`**. **Desktop closed earlier** (session doc `147`, `ac02483a`). **`providers-integrations` exists** — ⚠ **handoff 021 OMITTED that area from its spawn table entirely (5 rows for 6 code areas); the absence was read as a classification. Carry-forward 12.**

⭐ **Standing rule earned this round, for whoever writes the next briefs:** *read as much as you need, then **STOP AND SEND before the first production edit**.* Two Step-2.5 pauses were skipped this round, and **one of them was invited by a brief's own contradictory wording.**
