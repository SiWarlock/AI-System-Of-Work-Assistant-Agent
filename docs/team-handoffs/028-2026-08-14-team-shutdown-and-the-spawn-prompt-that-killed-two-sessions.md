# Team Handoff 028 — shutdown, and the spawn prompt that killed two sessions

**Date:** 2026-08-14
**Track:** main (single-track, root checkout)
**Predecessor:** `docs/team-handoffs/027-2026-08-13-two-rounds-and-the-lead-error-record.md`
**Round seal:** `f8a88557` · prior seal `1de290d9` (NOT `614bcbdc`, unreachable — `ad9c6815` explains)
**State at write:** tree clean, zero untracked, **124 unpushed (owner-run)**, `plan-lint` 0 violations.

## Why this exists

**Owner-instructed shutdown.** The team is being stood down deliberately, not paused mid-work. The round was already sealed before the shutdown began.

## ⛔ THE FAILURE THAT ENDED THE TEAM, AND IT IS THE LEAD'S

**Two successor sessions — `knowledge-implementer-2` and `main-orchestrator` — DIED AT LAUNCH. Neither ever registered**, and `team-register.sh` was the first action in both prompts.

⛔ **Cause: the lead's spawn prompts were too large.** Across the session they grew from ~40 lines to ~90, accumulating five instrument warnings, the condition-writing failure modes, the full queue with rulings, and the lesson index. A fresh teammate loads that **plus** root `CLAUDE.md` **plus** the area `CLAUDE.md` **plus** tool schemas on turn one.

⭐ **The mechanism worth carrying: a spawn prompt is not a place to preserve knowledge — it is the minimum needed to START.** The durable record is the tracker, the lessons ledgers, and the handoffs. **Every line added to a spawn prompt trades against the successor existing at all**, and that trade is invisible until it isn't.

⚠ **Second-order: the knowledge successor had ALREADY taken a `-2` suffix** because its predecessor died at 97% (`Prompt is too long`) without terminating, so it still held the base name. **A dead-but-unterminated session holds its name against a successor.**

⭐ **Prescription for the next lead: spawn prompts ≤ ~30 lines. Point at `027`/`028` and the ledgers; do not inline them.** If a successor needs the method, it can read it — it cannot read anything if it never boots.

## What was lost

**Nothing.** Sealed at `f8a88557` before any of this. Tree clean, verified by `git diff HEAD --stat` + `git ls-files --others --exclude-standard`, not by `git status --porcelain` (which returns the literal `ok` here).

## The round

**35 commits from `ad9c6815`.** `### 24.72` recorded as **NOT CLOSING** with seven named discharges. Lessons `L168`–`L179`. Tracker entries `### 24.85`–`### 24.87`.

## ⛔ The state that matters

1. **`### 24.72` does NOT close. Seven discharges: `#79` `#80` `#82` `#83` `#84` `#85` `#86`.**
2. ⭐ **`#85` IS THE PRIORITY AND IT IS ONE EXECUTION.** Two reviewers reached OPPOSITE conclusions about what a retry does; **NEITHER RAN IT.** Lead-ruled RUN IT — a split is not adjudicable by argument, and that exact shape (`#64`) sat unexecuted past two orchestrators and a lead, then reproduced the moment someone ran it. **It decides the mapping's COST, not the mapping.**
3. ⛔ **`#83` has an unmeasured question that could re-grade it from rule-1-ADJACENT to rule-1 PROPER: does a re-drive produce a SECOND MARKDOWN MUTATION or a no-op? NOBODY HAS SAID. DO NOT INFER IT.**
4. **`#86`** — class fix; `#69`/`#80`/`#82`/`#84` are four symptoms of one seam (eight shapes re-declare one field). Likely cheaper than the symptoms.
5. **`#70`** FENCED on the GCL port binding. **`#73`** DEFERRED by lead — the cheaper path needs an unqueued `contract` track, and that is a STAFFING constraint, not a design conclusion.
6. **`### 24.25`** unresolved ⇒ **the tree is NOT green and no brief may claim it.**
7. **Arming unchanged:** blanket hold released, **every crossing still owner-gated by its own `§ARM-*` ledger. Nothing is armed.**

## ⭐ The round's central finding

**THE APPLICABILITY CONTROL.** A non-vacuity control asks *did the instrument RUN?* An applicability control asks *is this instrument VALID FOR THIS INPUT?* **A non-vacuity control passes happily on an inapplicable instrument.**

**Teaching case:** a whitespace-normalising comparison is invalid for code whose DATA includes whitespace — and the file needing it held a deliberate three-space fixture. ⛔ **Both runs would have produced fabricated findings against shipped work, from the audit commissioned to catch fabricated findings.** What caught it was reading, which does not scale.

⭐ **`L177`: "is it wired?" is the WRONG QUESTION and returns YES.** A reachability trace, `/wired`, and an `L106` audit all pass on a signal that reaches a real consumer synchronously and then vanishes. Ask **does the RECORD outlast the FAULT?** — lifetime is not a property of the call graph.

⇒ ⭐⭐ **Three instances in one session (`L177`, the whitespace comparison, the compiler's two blind spots). INSTRUMENT FAILURE IS THE NOISY PROBLEM; QUESTION SELECTION IS THE REAL ONE.** Every one of those tools worked correctly and answered something narrower than what was asked.

## Five unreliable instruments — the compiler is a peer, not the remedy

- **`grep`** INTERCEPTED — fabricates rows; returned *"508 matches in 84 files"* for a single-file query. **Two agents, independently, same session.**
- **`codegraph_callers`** misses CALLBACK-POSITION refs. A HIT is evidence; an EMPTY is a question.
- **`graphify`** emits FALSE EDGES. *The graph is not a census.*
- ⛔ **`git diff` is a SUMMARIZING SHIM that omits whole blocks — and it is the surface we verify COMMITS against.** Verify against a second surface (`git show <rev>:<path>`), and give that surface its own applicability argument.
- ⛔ **`tsc` exhaustiveness enumerates TYPE-DEPENDENT sites only** — a CONSUMER THAT HARDCODES or a value behind a CAST is invisible. Recommended as the remedy, then corrected twice in one day.

**Redirect to a file, then measure the file** — pipes truncate silently and UNDER-report. Never `head` a list you will total. **A reported count gets RE-DERIVED, not ADJUSTED.**

## Conditions and triggers — three failed the same way in one day

⭐ **A condition tends to name the most OBSERVABLE PROXY for its event, not the event** — observability is what makes it feel checkable, and the proxy is right most of the time, which is why it survives review. ⇒ **the test is not "is this checkable" but *can this be checked and be wrong at the same time?***

**Instances:** a TEXTUAL trigger for a SEMANTIC condition · a SESSION-SCOPED home for a DURABLE need · a NUMBER for an AUTHORSHIP event.
⭐ **A trigger can FIRE AND LOOK SILENT, or LOOK FIRED AND BE SILENT.** Both invisible from its own wording.
⭐ **A `#NN` is a POINTER and cannot carry a CONDITION.** Author briefs from the `###` entry.
⭐ **A deferment condition can name a remedy that DOES NOT EXIST** — ask whether it is BUILDABLE, not just whether it is filed.

## Git, in this shared checkout

`git status --porcelain` can return the literal `ok`. ⛔ **`--amend` operates on whatever HEAD points at, NOT your commit — it destroyed a seal this round** (recovered by erratum, never by rewrite: `ad9c6815`). **WRITE THE COMMIT MESSAGE LAST** — pre-issuing caught two orchestrators, and a *revised* final message created the amend pressure that destroyed the seal. **A HOLD defers the COMMIT, not the EFFECT.**

## Owner state

- **124 unpushed, owner-run.**
- **Owner ruling in force:** SoW is single-owner local-first; **there is no principal and that is CORRECT BY DESIGN.** Rule 4 protects **CONTENT SCOPE**, not one principal from another. **Do not re-open.**
- ⭐ **CONNECTOR ARMING IS NOT BLOCKED ON BUILD.** Phase 16 (connector engine) is DONE; **Phase 23 is gated only on Phases 16+17**, and **Phase 17 is built, boot-wired, inert — waiting on one owner crossing (`§ARM-17`, the first real Keychain touch).** ~1 owner-confirmed round per vendor. Granola is cheapest (one key, read-only). ⚠ Several open findings are fenced ON that binding — scope which actually bind a single-vendor arming before crossing.

## How to resume

`/team-start main` → read **this file and `027`** → spawn from `027`'s templates, **≤ ~30 lines each, pointing at the ledgers rather than inlining them.** Verify read-backs. ⚠ **Addresses diverge from registry names:** the lead registers `main-team-lead` and answers to `team-lead`.
