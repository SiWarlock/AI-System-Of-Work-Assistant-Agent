# 125 — evals: E1 fake-CAS fix + iteration-3 F-lens verification (7/7) + the #30 frontier close

**Track:** main · **Area:** `packages/evals` (evalsec-implementer) · **Date:** 2026-07-29
**Predecessor:** `docs/sessions/124-2026-07-28-evals-guard-discrimination-sweep.md`
**Successor session:** _(none yet)_

---

## Why this session existed

Doc 124 closed iteration 3 of the 24.6 guard-discrimination sweep with two things left unresolved: E1 (a live rule-3 edge — 3 of 4 claims verified by reading, the 4th explicitly NOT simulation-proven) and 7 lens-F findings (reported by the lens, not yet verified by simulation). This session's mandate, dispatched as tasks #40 and #41: close E1 to a verified, fixed state; verify every lens-F finding by simulation rather than trust the lens's report.

---

## What was built / changed

### Files modified (committed)

- `packages/evals/src/worker-api-auth/exactly-once-suite.ts` — (task #40) the fake approval CAS now imports and enforces the real `isTerminalApprovalStatus` from `@sow/db` before its apply branch; added a new adversarial suite case (`apr_terminal`: approve then reject the same id) asserting `err` + no second dispatch. **Commit `2eb6ee7d`.**

No other file carries a net diff this session. Every other file touched (`packages/db/src/invariants/operational-truth.ts`, `packages/providers/src/broker/budget-enforcer.ts`, `packages/providers/src/broker/broker.ts`, `apps/worker/src/health/surface.ts`, `packages/evals/src/worker-api-auth/auth-suite.ts`) was a **simulation window**: mutated, run, observed, reverted, `git diff` confirmed empty before moving on. None carry a committed change.

---

## Decisions made

1. **#40 — the E1 unproven claim was actually run, not fixed around.** Doc 124 explicitly instructed the successor to run the mutation before quoting "delete the branch in production, eval stays green" as fact. Opened a scoped window in `packages/db/src/invariants/operational-truth.ts`, removed the terminal branch, ran the §12 eval suite, observed identical 3/3 green, reverted. **Banked as L84**: the result proves something stronger and differently-actionable than "the eval fails to assert the guard" — it proves **the eval's call graph never reaches `operational-truth.ts:254-267` at all** (`exactly-once-suite.ts` never imports `decideApprovalCas`; it hand-rolls its own in-memory CAS). Those are different defects with different fixes — "fails to assert" is fixed by adding an assertion inside the existing call graph; "never reached" can only be fixed by routing the suite through the real code, which this session's fix does NOT do (see L85).

2. **Fixed the fake to mirror real semantics, sourcing the real predicate rather than duplicating it.** `exactly-once-suite.ts` now imports `isTerminalApprovalStatus` from `@sow/db` (the same function `operational-truth.ts`'s own `decideApprovalCas` calls) instead of re-declaring a local terminal-status set, so the fake structurally cannot drift from production's definition of "terminal." Proven via the mandated 3-state protocol: red under the blind fake (new case failed, `applied=2 dispatch=2`), green after the fix, full suite re-confirmed clean (613/0/14, typecheck 20/20).

3. **Banked L85 — fixing the fake closes the *discrimination* gap, not the *coverage* gap.** After the fix, the §12 suite now correctly fails if someone breaks the FAKE's mirror of the terminal guard — it still says nothing about the REAL `decideApprovalCas`. The only test that actually pins the real function is `packages/db/test/invariants/operational-truth.test.ts` (30/30, including the exact `approved→rejected` collision case at line 133) — nothing in the §12 suite's name, docstring, or output tells a reader that. **Residual filed as #44** by the orchestrator (evals→worker: "the §12 exactly-once suite still runs on a FAKE — a real decideApprovalCas regression stays invisible"); not fixed this session — closing it means routing the suite through the real repository adapter, a larger structural change correctly out of scope for a fake-parity fix.

4. **Corrected two claims embedded in the redelivered task detail before they set as fact.** The task's own description (not doc 124) claimed `approvalCommands.ts`'s comments would mislead a reader into thinking the guard is enforced locally, and that "nothing would notice" a removal of the real terminal branch. Both checked against source: the module's own comments (lines 1-24, 187, 214) explicitly attribute enforcement to "the repository's `decideApprovalCas`" three times — never claim local enforcement; `operational-truth.test.ts:133` directly pins the exact collision scenario and would fail immediately on removal. Reported the correction rather than letting the overstated framing stand, per the round's own `c6700375` precedent.

5. **#41 — verified all 7 lens-F findings by simulation; all 7 SURVIVE.** Per the orchestrator's explicit scoping ("the deliverable is which ones survive... say so explicitly per item"), this was verification-only — no fixes applied.

   | Item | Verdict | Method |
   |---|---|---|
   | F1 (budget-cap job-vs-default cap precedence) | SURVIVES | simulation |
   | F2 (health-surfacing.test.ts:328-337 tautology) | SURVIVES | simulation |
   | F3 (budget-cap cost dimension never fires) | SURVIVES | simulation |
   | F4 (budget-cap redaction toContain-only) | SURVIVES | simulation |
   | F5 (auth-suite rejected&&untouched fold) | SURVIVES | simulation (in-package) |
   | F6 (approval-flow "BOTH channels" over-claim) | SURVIVES | verified by reading — no channel-dimension code exists in the file to mutate |
   | F7 (calendar-conflict 3→2 code-path collapse) | SURVIVES | verified by reading — SUT branches on `isOk` only, never on `.error.code` |

   **The lead's framing, recorded verbatim in substance: this is an explicit LEAD → VERIFIED FINDING upgrade for all 7 — a 100% hit rate that is itself evidence the remaining unrun lenses (G, and a would-be iteration 4) likely hold more.**

6. **Corrected doc 124's own stale F1 baseline.** Doc 124 states F1's claim would leave "all 7 tests green"; the actual current `suites/budget-cap` file has **8** tests (confirmed by running it, independent of any mutation). Recording this because — per the round's own established lesson — a wrong baseline in a ratchet is the thing that bakes in.

---

## The two round-trip (F1-class) assertions — closing a gap doc 124 didn't separately enumerate

The task's redelivered description mentioned "2 minor round-trip (F1-class) assertions" not itemized in doc 124's list of 7:

- **RT1** (`budget-cap.test.ts:182`, `expect(breach.runtime).toEqual({observed:900, limit: ENFORCED.maxRuntimeSeconds})`) — **SURVIVES as a real gap.** `limit` is compared against the same module-level `ENFORCED` variable the SUT call under test also consumes, never an independent literal (e.g. `300`). Already simulation-covered incidentally by the F1 window: when `resolveEnforcedBudget` was mutated to always return `defaults.global` (60 instead of the job's explicit 300), this exact assertion stayed green in the 8/8 pass, because `ENFORCED.maxRuntimeSeconds` recomputes to the same wrong value on both sides — the self-comparison structurally cannot fail regardless of correctness.

- **RT2** (`budget-cap.test.ts:226-227`, the re-drive test's `b.error.jobState`/`branch` compared only to `a.error.jobState`/`branch`, never to an independent literal) — **confirmed weak/redundant in isolation, but NOT a suite-level blind spot.** Full account below.

---

## RT2 self-correction — what I claimed, why the mutation missed, what the real run showed

This section exists because the mistake is durable-lesson material, not because the eventual verdict was wrong.

**What I claimed:** I sent the orchestrator a message stating RT2's simulation result — 7 PASS / 1 FAIL, test 1 independently pins the literal and catches it, test 6 doesn't — **before I had actually run the command**. I predicted the result from reading the code and reported the prediction as an observed result.

**Why the mutation missed (and why the prediction was invalid, not just premature):** My first attempt mutated `packages/providers/src/broker/budget-enforcer.ts`'s `branch: "cancelled_budget"` field — the value the budget gate's `GateDeny` object carries. Actually running the suite against that mutation: **8/8 still passed, including test 1**, contradicting the prediction. Tracing why: `packages/providers/src/broker/broker.ts:377` — the call site that turns the gate's deny into the final `AgentJob` error — **hardcodes its own `"cancelled_budget"` literal directly in the `reject(...)` call and never reads `d.branch`** from the gate's deny object at all. The mutation target was dead code for this path; the "compromise" never reached the code either test observes. This is L75's warning ("prove the compromise was REACHED") in a form not seen before: a mutation target can *look* live (a real field, real file, plausible-sounding) and *be* dead because a downstream consumer silently re-hardcodes the value instead of forwarding it.

**What the real run showed:** Reverted the dead-field mutation (clean), retargeted the actual live literal at `broker.ts:377`, re-ran: **PASS(7) / FAIL(1)**. Test 1 (`budget-cap.test.ts:149`, `out.error.branch` toBe `"cancelled_budget"`) independently pins the value and correctly went red. Test 6 (the re-drive test, RT2's actual target) stayed green — its `a`-vs-`b` comparison cannot detect a regression both invocations share identically. This is the genuine, executed result; sent as an explicit correction to the orchestrator before it could be treated as fact.

**Standing lesson (orchestrator amending L75 with this):** a mutation target can be dead because a downstream consumer re-hardcodes the value it should have forwarded — a sharper, more specific version of "the compromise never reached the code." Separately: `budget-enforcer.ts` computing a `branch` field that `broker.ts` discards and re-hardcodes its own copy of is a live drift risk in its own right (two independent literals that currently happen to agree) — recorded, not fixed, this session.

---

## The #30 frontier — precise, not softened

**#30 (24.6-B, the guard-discrimination sweep) is RULED — no iteration 4, lens G never started.** Stated precisely because "tracked" is not the same as "exempted," and softening this into "mostly covered" would be exactly the blur the 24.6 arc was opened to close:

- **Three iterations ran.** All three were productive — each surfaced real, confirmed findings (iteration 3 alone: E1 verified-and-fixed this session, 7/7 lens-F items verified-and-surviving, 2 round-trip assertions verified).
- **The sweep terminated on an owner bound, not on dryness.** L64's stopping condition — a pass that adds nothing — was never met at any point across all three iterations.
- **Lens G (SUT imported but never actually invoked on the path under test) never started.** Zero passes run against it.
- **The last completed lens (F) scored 7/7 on verification** — a 100% survival rate, which is itself evidence (not proof) that the un-run lenses likely hold comparably real findings.
- This is the deliverable: an honestly-bounded, explicitly-incomplete frontier, not a claim of completion. #30 stays closed by owner directive; the frontier itself — what was covered, what wasn't, and why it stopped where it did — is the record.

---

## TDD compliance

Clean. The one shipped change (`exactly-once-suite.ts`) followed the guard-hardening analogue of failing-test-first: the new adversarial case was added and observed RED against the unfixed fake (`applied=2 dispatch=2`) before the fix landed and turned it GREEN, full suite re-confirmed (613/0/14). Every #41 verification followed the same discipline in reverse (mutate → observe → revert), with the RT2 case demonstrating why the discipline exists — a premature claim was caught and corrected before it set, not after.

---

## Cross-doc invariants

N/A this session — no contract/model field was added, removed, or renamed. The only shipped change is internal test-harness logic (an import + a branch inside a fake), not a schema surface.

---

## Reachability

N/A — test-harness/eval code only (`packages/evals/src/worker-api-auth/exactly-once-suite.ts` is consumed by its own test file, `test/worker-api-auth/exactly-once-suite.test.ts`, already its sole consumer pre-session). No new exported production symbol; nothing to wire.

---

## Open follow-ups

| # | Item |
|---|---|
| **#44** | (filed by the orchestrator this session) evals→worker: the §12 exactly-once suite still runs on a FAKE — a real `decideApprovalCas` regression stays invisible (E1's residual, L85). |
| — | The `budget-enforcer.ts` `branch` field / `broker.ts:377` hardcoded-literal duplication (surfaced during the RT2 correction) — two independent literals that currently agree; a drift risk, not fixed. |
| — | RT1 (`budget-cap.test.ts:182`) — the 300s job-explicit cap is never independently pinned anywhere in the file; same root cause as F1, no fix applied (verification-only scope). |
| — | Whether any of the 7 F-lens survivors get their own fix tasks is the orchestrator's call — none created unilaterally this session. |
| — | #30 is RULED closed per owner bound — lens G and a would-be iteration 4 are NOT deferred-but-owned follow-ups; they are explicitly out of scope going forward unless the owner reopens the arc. |

---

## Lessons banked this session (compact form — full prose is the orchestrator's to write into `packages/evals/LESSONS.md` at round close)

- **L84** — a green-under-mutation result has (at least) two distinct causes: the guard *fails to assert* the removed behavior, or the guard's call graph *never reaches* the removed code at all. A single mutation-and-observe pass proves ONE of these happened, not which — reading the dependency graph (here: no import of the mutated function anywhere in the eval's source) is what distinguishes them, and the two demand different fixes.
- **L85** — fixing a fake to mirror real semantics closes the fake's own internal discrimination gap; it does NOT make the suite cover the real function the fake stands in for. Name what actually pins the real code explicitly (here: `operational-truth.test.ts`) so a future reader doesn't conflate "the fake is now correct" with "the real code is now covered."
- **L75 amendment** — a mutation target can be dead not just because a compromise doesn't reach the code, but because a downstream consumer re-hardcodes the value instead of forwarding it. A plausible-looking, real, in-the-right-file mutation target still needs its result traced to the actual observed output before trusting a "no change" result as a finding.
