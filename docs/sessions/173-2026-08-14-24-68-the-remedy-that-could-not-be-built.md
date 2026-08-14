# Session 173 — `24.68`: the remedy that could not be built, and the registry I exempted from my own lesson

**Date:** 2026-08-14 · **Phase:** 24 (hardening tail) · **Area:** `packages/policy` (`providers-integrations-implementer`, single-track `main`)
**Predecessor:** this area's prior session — `168-2026-08-14-24-65-part-2-two-stated-advantages-that-died-on-measurement.md` · chronological — `172-2026-08-14-24-80-re-scoped-and-the-precedent-that-had-not-solved-it.md` (knowledge)
**Successor:** _(none — team shut down at owner instruction after this session)_

**Commit:** `7362d199` — 1 file, **comment-only** (non-comment delta mechanically verified empty).
⚠ **Written without orchestrator review or approval:** the orchestrator was gone and both successor spawns died at launch. **Lead-authorized self-close-out.** Step-9 routing was therefore unavailable; nothing in this slice required it (zero logic delta, no new findings needing escalation beyond those already filed).

---

## Why this session existed

`### 24.68` was filed as **condition 2** of the `24.65` deferment approval — *"accepting a residual without filing its actual remedy is exactly how a residual becomes permanent."* The remedy on file: give `denyDirectCrossWorkspaceRaw` a **trusted counterpart** so `24.45`'s referential validate-or-omit could apply to caller-supplied `from`/`to`.

⭐⭐ **Measuring it killed it, and the lead re-scoped the task from a FIX to a MEASUREMENT.** The lead's words: *"I named a remedy that cannot be built, and the nearest buildable thing is the trap."* ⇒ **the defect was in the deferment condition, not in the work.**

## What was measured

**Each hop read, not inherited:**
- `denyDirectCrossWorkspaceRaw` ← `guardCrossWorkspaceRawRead` ← `CrossWorkspaceLinkMap.authorizeCrossWorkspaceRawRead` ← **NOTHING.** No production caller supplies anything.
- ⛔ **The one candidate that LOOKS like an authority is not one:** `CrossWorkspaceLinkMap` holds `new Map()` and nothing else — no registry, no resolver, no injected deps (whole class read). Its keys are whatever a caller passed to `recordLink`, admitted by `endpointsValid` = non-empty + distinct — ⭐ **the same class of check as the one being strengthened.**
- ⇒ **any obtainable "trusted counterpart" is the same caller-supplied string echoed back through a `Map`** — `### 24.83`'s falsified shape verbatim, *"registry-validated" means "someone inserted it."* **Trusted by convention, not by construction.**

## What was landed

**The `#48` residual note, corrected to state the measured reality.** ⛔ **NOT "deferred" — unfixable at this layer by the referential remedy.** A residual filed as remediable when it is not is a false promise that ages into a false assurance.

## Decisions explicitly NOT made

- ⛔ **The note was NOT deleted.** Brief `286` required deletion; **I refused and the criterion was withdrawn.** It was written assuming the slice would CLOSE the residual — it does not, so deleting the note would erase the hazard's only in-code record while appearing to complete the task (`L82` inverted). **Deletion belongs on the commit that actually closes it.**
- **Options (A)/(B)/(C) not re-proposed.** ⭐ Recorded honestly: **the pull toward (C) comes from a real vacuum, not laziness** — there genuinely is no validation available at this layer today. **That is precisely why the lead's rejection had to be on principle rather than preference.**
- **No tests.** Comment-only, zero logic delta, nothing to pin. **Stated rather than manufacturing a green test to look complete.**

## ⭐⭐ The review, and why it was run at all

**A `security-reviewer` was dispatched on a diff with ZERO logic in it**, scoped to verify **claims** rather than review design.

**Reason, and it was a measured one: in this same file, review had found a false claim in my comments in each of the two preceding slices.** This slice was *entirely* claims, in a note whose whole purpose is to be believed by a reader who will not re-derive it. **The base rate said review it.**

⇒ **It returned 3 defects + 2 staleness items. Base rate held: 3/3.**

### The sharpest was mine, and it is `L72` inside one paragraph of my own reasoning

⛔ **I cited `### 24.83` to disqualify `CrossWorkspaceLinkMap` as an authority — and two lines later called `workspaceConfig` "A REAL authority," exempting a second registry from the lesson I had just invoked.**

**Verified:** `parseCreateWorkspace` **admits ANY non-empty string as the id and never runs `WorkspaceIdSchema`** (`24.62` boundary a). ⇒ `workspaceConfig` is an **EXISTENCE** authority, **not a SHAPE** authority — wrong on exactly the axis this residual is about.

⭐ **The orchestrator's note on it: *"I'd have read straight past it, because the paragraph's conclusion was correct."*** ⇒ **a correct conclusion is not evidence the reasoning is sound, and it is the condition under which a bad premise survives review.**

### The second would have defeated the note's own purpose

My warning against wiring the registry was justified **purely on entitlement grounds** — but the residual is a **SHAPE** exposure (`contracts L147`). ⇒ **a reader who correctly spots the mismatch dismisses the objection as off-point and wires the registry — the precise outcome the paragraph exists to prevent.** Both halves now given: a lookup proves **neither** shape (`24.83`) **nor** entitlement (`24.62`-b).

### And one of my own severity arguments had gone stale

`### 24.78` Part 1 landed, so *"both hops are exported from the public barrel — one import away from ending the dormancy"* is **false**; the barrel no longer re-exports either module. ⚠ **Stale in the ALARMING direction and corrected anyway** — a severity argument resting on a false premise is a defect whichever way it leans.

**Also fixed:** a direction error (*"the same class as the one BELOW"* — the check is **ABOVE**; below lands on `linkValid`, which merely resembles it, the `24.66` shape) · two halves of one residual contradicting each other across sites, one still promising a remedy `24.68` had just disproved. **Both errata quote the old text rather than overwriting it.**

## What propagated outward

- ⛔ **My wiring disclosure falsified the ORCHESTRATOR'S tracker text.** They had fenced the counterpart behind the `24.81` GCL port binding; **`apps/worker` already depends on `@sow/policy`, so a worker caller could supply one without it.** ⇒ *"cannot reach here"* is a **wiring fact, not a structural impossibility.* They corrected it as an overstated fence (`L161`).
- ⛔ **A shape remedy is NOT foreclosed:** `### 24.84` exists to give `WorkspaceIdSchema` a defensible shape — needs no counterpart, symmetric across `from`/`to`. **Option (B)'s rejection EXPIRES when 24.84 lands**, and the note says so, so it does not outlive its own premise.

## ⚠ Tooling — three instruments failed toward PLAUSIBLE in one session

1. **`codegraph_callers`** — confident *"No callers found"* for a symbol with production call sites (standing).
2. **`graphify`** — emitted a **FALSE EDGE** (`endpointsValid --calls--> revokeLink`) between functions that do not call each other. ⇒ ⭐ ***the graph is not a census.***
3. **`grep`/`awk`/zsh word-splitting** — vacuous censuses returning the TRUE answer (prior slices; `contracts L160`).

⇒ **Every one failed in the direction that looks like an answer.** The only defence that worked in each case was a **positive + negative control**.

## Cross-doc invariant audit

**NONE owed.** `CrossWorkspaceRawRequest` is **policy-local** — zero hits in `packages/contracts`, not in the cross-doc invariants table, not a frozen Appendix-A model. No field changed; comment-only.

## Reachability

Unchanged by this slice — **nothing new becomes reachable by a comment.** `denyDirectCrossWorkspaceRaw` remains **not production-reachable**: the chain terminates at nothing and `CrossWorkspaceLinkMap` is constructed only in tests. ⚠ **Narrower than before but not guaranteed:** `24.78` Part 1 removed the barrel re-export, so arming now requires a deliberate deep import through the surviving `"./*"` wildcard — **whose fence is `24.78`'s own Done-when and is still open.**

## Open follow-ups

**Referenced, not re-filed:** `### 24.84` (the shape remedy that expires option (B)'s rejection) · `### 24.81` (`#70`, descriptor-vs-`[[Get]]` channel divergence, fenced on the GCL port binding) · `### 24.82` (`#71`, non-enumerable own props + `contracts L76` staleness) · `### 24.78`'s wildcard fence · `#53` (four false-liveness comments in `packages/workflows`).

⛔ **The residual itself remains LIVE and its in-code note is its only record.** Do not delete that note except on the commit that closes it.

## Lessons raised

1. ⭐⭐ **A correct conclusion is not evidence of sound reasoning** — and it is the condition under which a bad premise survives review. The registry self-exemption sat inside a paragraph whose conclusion was right.
2. ⭐ **Review a comment-only change when the base rate says to.** Zero logic, three defects. **Match the instrument to the failure mode: verify CLAIMS, don't review design.**
3. ⭐ **A remedy filed as a deferment condition can be unbuildable** — and *"the nearest buildable thing is the trap"* is the outcome to watch for. **Measure the remedy before promising it.**
4. **Correct a stale severity claim even when it errs toward alarm** — a false premise is a defect in either direction.
5. **The graph is not a census** — three instruments, one session, all failing toward plausible; controls were the only defence.

## Verification at close

`@sow/policy` **515/515** · tsc **0** · non-comment delta **EMPTY** · commit verified **per-path**, 1 file, **no peer path swept** · territory clean by **both** `git diff HEAD` and `git ls-files --others --exclude-standard`.
