# Session 167 — the guard not added, and the finding I had to retract

**Date:** 2026-08-13 · **Phase:** 24 (hardening tail) · **Area:** `packages/knowledge` (knowledge-implementer, single-track `main`)
**Predecessor:** `164-2026-08-13-24-26-closes-and-the-comment-that-instructed-the-forbidden-binding.md` (this area's prior session) · same-day siblings: `165` (providers), `166` (worker)
**Successor:** _(filled in by the next `/session-end`)_

**Commits:** `7412e0f0` (`### 24.67`, task `#57`)

---

## Why this session existed

`### 24.26` closed at `46e34ca8` and left one question its own slice correctly refused to answer: with `KnowledgeWriterDeps.workspacePathCheck` now **required**, omission is unrepresentable in well-typed code, so the only route to a non-function value is an explicit `as`-cast. **Should `applyPlan` return a fail-closed typed `err` for that?**

It was filed rather than folded because **the orchestrator's stated reason for declining a guard was false** — *"a guard would be the deleted fallback wearing a different hat."* The deleted fallback **admitted** writes under a hardcoded exempt id; a fail-closed `err` **admits nothing**. Opposites, not variants. My predecessor did not act on it, recorded in-code that the equivalence does not hold, and routed the question (`contracts L120`).

## What was built

**Files created** — none.

**Files modified**

- `packages/knowledge/src/knowledge-writer/writer.ts` — `applyPlan`'s docblock replaced with the `24.67` decision record: the §16 throw enumeration, four reasons, three invalidating conditions, and a falsification recipe. **Comment-only; no production behaviour changed.**
- `packages/knowledge/test/workspace-path-guard.test.ts` — new describe `24.67 — the guard runs BEFORE any vault write`, one pin (`workspace_path_check_is_invoked_before_any_byte_is_committed`); one assertion added to the pre-existing omission test; the stale routing note replaced with a pointer.

## Decisions made

1. **NO GUARD**, decided on measured merits — not by deferring to the withdrawn analogy, and not by over-correcting because it was withdrawn. Four reasons, in the order they actually carry weight:
   - **Ordering.** `workspacePathCheck` is the **safest** of the required deps, not the most exposed. Omitted via cast, `vault` / `revisions` / `workspacePathCheck` throw with the vault **empty**; `now` and `audit` throw with the vault **already committed**. A guard here hardens a member already fail-closed and leaves the two that already wrote — partial coverage reading as *"§16 is robust at `applyPlan`"* (`contracts L137`).
   - **No existing `WriteFailure` member is truthful.** `workspace_path_violation` is the **only** member of the downstream `KnowledgeCommitFailureCode` union that is an isolation breach and maps to `FailureClass "isolation_breach"`; `commitKnowledge.ts` also propagates `cause: result.error`, so a synthesized violation would inject a **fabricated `.path`** into the sinks `WorkspacePathViolation` documents as unsafe for exactly that. `commit_failed` would not poison rule 4 but asserts a commit was attempted that never was.
   - **A `commit_failed`-shaped guard is redundant** — `createCommitActivity` already catches the throw and folds it to exactly that at the port boundary. *(Found in review; stronger than the reason it replaced.)*
   - **Cost of a truthful variant** — a new `WriteFailure` member is a deliberate compile error in **three** `assertNever`-guarded sites across `packages/workflows` and `apps/worker`.
2. **The pin defends the DECISION, not the code.** Reason 1 is an ordering claim, so a reorder would silently falsify the recorded decision with nothing reporting it. Framing taken from the orchestrator, whose version was better than mine.
3. **The reasoning lives once, in `writer.ts`.** The test file points at it rather than summarising it — duplicating the *framing* of a fact is how the exempt id drifted in the first place.

## Decisions explicitly NOT made

- **No guard in any form, and no substitution.** The only admissible remedy was a rejection; a default check or exempt id re-opens `### 24.26`.
- **Did not fix `workspace-path-guard.test.ts:372`'s `#49`** — a pre-existing session-scoped task id in a permanent comment, the same defect class the orchestrator corrected me on. Flagged, not widened into (the `L127` shape).
- **Did not shorten the docblock.** Raised as a real concern by review; the orchestrator ruled leave it, on my own counter-argument — three of my claims rotted within one session, so a long block carrying a re-run recipe beats a short one that must be trusted.
- **Did not claim the retry-aggravator on `### 24.72`.** Reviewer-raised, PLAUSIBLE, not executed by either of us.

## TDD compliance

**One honest deviation, declared in-test rather than smoothed over.**

The new pin is a **characterization test on already-correct behaviour** — the property held before the test existed, so it **could not red first**. Established by **mutation verification** instead: the step-4.5 guard loop moved past the step-7 commit ⇒ **4 of 25 red**, restored byte-identical, verified `git diff HEAD` empty before proceeding.

⭐ **I checked my own pin was among the four reds rather than accepting the count.** Three neighbours also depend on that ordering, so *"4 failed"* would have been satisfied without my test reding at all — a count that can only be matched, never compared.

⚠ Two mutation windows were opened on a **shared checkout** (`contracts L139`); both were single-command, restored from a `/tmp` backup, and confirmed byte-identical against `HEAD` before the next step.

## Cross-doc invariant audit

**No action required.** `KnowledgeWriterDeps`'s shape is unchanged — the slice is comment-only in `src` plus one test. No model field added, removed, or renamed; no Appendix-A model touched; no `ARCHITECTURE.md` row owed. Confirmed with the orchestrator at Step 9.

## Reachability

**No wiring added or removed.** The guard is reached from `applyPlan` step 4.5 via `createCommitActivity` → `deps.applyPlan`, from three production call sites (`buildActivities.ts` — both the meeting `commit` and `sourceCommit` paths — and `semanticApprovalDispatch.ts`). The new pin exercises that live path through the **real** guard (the recording wrapper delegates to it), so nothing tested-but-unwired was introduced.

⭐ **A reachability fact discovered this session and now load-bearing for the decision:** `createCommitActivity` wraps `applyPlan` in a §16 try/catch. Reasons 1 and 3 are **system-level** claims resting on it — recorded as invalidating condition (iii), because that catch lives in another package and nothing linked its pin to this decision.

## Open follow-ups

1. ⛔ **`### 24.72` must be re-derived from the corrected characterization, not from what I first reported.** The orchestrator confirmed it is correcting the lead. Corrected version: on a **post-commit** store fault the Markdown mutation **is durable**, the caller is told **`commit_failed`**, and **no AuditRecord lands** — a **report inversion**, not an uncaught escape.
2. **Grading input changed, grading probably not.** The lead ruled *not rule 1, §16 + observability*. On corrected facts the §16 half is **weaker** (the boundary catches it) and the audit-trail half is the whole defect. The security reviewer's independent framing is sharper than either the lead's or the orchestrator's had been: **the audit trail is how one-writer is *evidenced*, and an unaudited durable mutation is indistinguishable at the sink from a write by something that isn't KnowledgeWriter.**
3. **PLAUSIBLE, unexecuted** — on the two live-head-resolver compositions a retry may re-enter with `getByIdempotencyKey` still empty, pass compare-revision against the *new* head, diff to zero changes, and record an AuditRecord whose `afterSummary` says 0 changes against a post-mutation base. Belongs to `### 24.72`.
4. **`workspace-path-guard.test.ts:372`** — pre-existing `#49` session-scoped citation in a permanent comment. Orchestrator filing it.
5. **`### 24.61`** still armed for whoever moves the exempt id to config; this slice introduced no runtime path to that argument.

## What this session is worth remembering for

⭐⭐ **My measurement was correct; my conclusion about what it meant was not.** I measured three throwing shapes in `applyPlan` and reported a **system-level** consequence — *"nothing catches the fault"* — without checking the callers. `createCommitActivity` catches it, folds it to `commit_failed`, says so in its own comment, and is test-pinned. **The claim reached the orchestrator, then the lead, then a grading. I stopped it at the fourth artifact.** It is a call-path question, and I answered it from one file — **while quoting `L145` at other people in the same message.**

⭐ **I had the disconfirming evidence in hand and asserted past it.** I claimed `KnowledgeCommitFailureCode` lives in `packages/contracts`. **My own earlier grep of that file returned empty** — a null result that contradicted the belief — and I wrote the claim anyway. `contracts L147` at its purest: I answered *where would this live?* instead of *where does it live?* A null result is evidence; treating it as a failed search rather than an answer is how it gets discarded.

⭐ **Two reviewers disagreed, and taking either on authority would have shipped a false claim.** code-quality said the fan-out was three areas; security said two. Measuring resolved it — **code-quality was right about the fan-out, security was right about the catch, and each was wrong about the other's finding.** Reviewer output is evidence, not verdict.

⚠ **A correction owes a replacement, and my rewrite nearly ate a true sentence.** Removing the false *"NEVER throws for well-typed deps"* also removed *"that is **pinned**"* — which was true and still is. My predecessor's session recorded exactly this failure one day earlier; **reading their lesson did not stop me repeating it, a reviewer did.** (`L94`'s ceiling, re-measured.)

⚠ **Tooling, hard-won:** piping `git diff` into `awk`/`sed` produced **false empties** twice, and I nearly concluded my own edit had not landed. Same interception family as the `grep` trap, but it lands on **verification** commands, where a false empty reads as *"clean"* — the reassuring direction. `git diff --stat` and a python read were correct. **Pair verification commands with a non-vacuity control too, not just searches.**
