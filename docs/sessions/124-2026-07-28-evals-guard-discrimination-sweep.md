# 124 — evals: guard discrimination — corpus re-point, blind-guard fixes, and the 24.6 sweep

**Track:** main · **Area:** `packages/evals` (evalsec-implementer) · **Date:** 2026-07-28
**Predecessor:** `docs/sessions/122-2026-07-28-policy-zero-egress-predicates-processorofroute-totality.md` (adjacent area; no direct evals predecessor this round)
**Successor session:** _(none yet)_

---

## Why this session exists

Opened to repair one red package (`@sow/evals`). It became a four-commit arc on a single theme, banked as **L80**:

> **These suites assert that a gate SAID NO, not that the gate DECIDES.**
> A guard with no allow-side control and no reason-code pin cannot distinguish a working gate from a brick wall.

---

## What landed (4 commits, all `packages/evals`)

| Commit | What |
|---|---|
| `3fd7dd2a` | #19 — re-point the synthesis corpus to 13.8j namespaced stub paths + re-stamp the integrity hash |
| `a32dab33` | #27 + #28(partial) — make the redaction and workspace-leakage guards discriminate |
| `963420c9` | #28 full — pin the protective REASON so a broken gate cannot score as protection |
| `bdc558cb` | #29 — make a dangling DoD suite pointer a RED test, and resolve what can be proven |

**End state: `@sow/evals` 613 pass / 0 fail / 14 skipped** (skips = the API-gated real-Claude eval only). Repo `turbo typecheck` 20/20. No production code changed in any commit except one registry path correction.

---

## ⛔ THE MOST IMPORTANT THING IN THIS DOC — iteration 3 WAS RUN, and its findings are HERE

The cycle instruction said "the 3 lenses (E/F/G) unexplored." **That is not accurate and would lose real work.** Lenses **E and F were run to completion**; only **G** was never started. Iteration 3 produced **~10 findings**, one of them verified with a live safety edge. Recorded here because nothing else holds them.

### ⭐ E1 — VERIFIED, HIGH, and NOT merely eval-integrity

The approval CAS **fake** is missing the real repository's terminal-state guard.

- **Fake** `packages/evals/src/worker-api-auth/exactly-once-suite.ts:81-104` — TWO branches: `status === next.status` → noop · `status === expectedFrom` → **APPLY**.
- **Real** `packages/db/src/invariants/operational-truth.ts:254-267` — THREE branches: `current === next` → noop · **`isTerminalApprovalStatus(current)` → `stale_conflict`** · `current === expectedFrom` → apply · else `stale_conflict`.

Verified by reading both, side by side. The fake's own docblock claims "This is the CAS contract the real repository guarantees" — it is not.

**Consequence:** in the fake an already-`approved` approval accepts a `reject`, applies, and **re-dispatches**. Production returns `stale_conflict`.

⚠ **Why this exceeds a divergent fake:** `decideApprovalCommand` (`apps/worker/src/api/procedures/approvalCommands.ts:204-215`) has **no terminal guard of its own** — it reads `expectedFrom = current.status` unconditionally. The repository branch is the **sole** defense against re-deciding a tombstoned approval, and the §12 suite that is the phase-exit-8 DoD for approval exactly-once runs entirely against a CAS that lacks it. **Drop that branch in production and the eval stays green.** Safety rules 3 (external-write envelope) + 1 (one-writer) — a resurrected terminal approval drives `dispatchApproval` twice.

**Fix shape (not applied):** add the terminal branch to the fake, plus a case driving `approved → reject` asserting `err` + `dispatchCount === 0`.

#### ⚠ PROOF STATUS — read this before quoting E1

Two claims here have **different evidence strengths**. Do not collapse them:

| Claim | Status |
|---|---|
| The fake omits the terminal branch the real CAS has | ✅ **VERIFIED BY READING** — both sides read side by side, `file:line` above. Independently confirmed by the orchestrator. |
| In the fake, `approved` + `next: rejected` takes the apply branch and re-dispatches | ✅ **VERIFIED BY READING** — follows directly from the two branches present. |
| `decideApprovalCommand` has no terminal guard of its own | ✅ **VERIFIED BY READING** — `approvalCommands.ts:204-215`. |
| **"Delete the branch in production and the eval stays green"** | ⚠ **NOT SIMULATION-PROVEN.** Highly likely from the above, but never executed. It needs a `packages/db` mutation window (remove the branch → run the §12 suite → observe green), which was not opened: the announce-first protocol makes cross-package windows visible to teammates mid-slice, and per that protocol an unproven finding is reported as unproven rather than taking a silent window. |

**Successor: run that mutation before quoting the last line as fact.** It is the L75 STATE-1 step (reproduce the blindness) and it has not been done for E1. Everything above it stands without it.

### Lens F — 7 findings, REPORTED BUT NOT VERIFIED

⚠ Lens F's output arrived compressed. These are recorded as **claims with reproductions**, not as facts — relaying unverified subagent output as verified is a failure already committed once this round (see "What I got wrong"). Verify before acting.

**⛔ PROOF STATUS FOR ALL SEVEN: NONE ARE SIMULATION-PROVEN.** Not one had its mutation executed. Each entry below gives *what is claimed blind* + *the substitution that allegedly stays green* + *`file:line`* — which is enough to run L75 STATE 1 (apply the substitution, confirm the suite stays green) and no more. **Treat every one as a lead, not a finding.** Several are plausible enough that I'd expect them to hold; that expectation is not evidence, and this round has already produced two cases where a confident-looking claim was wrong (a stacked defect where the first fix left the suite green, and a root-cause hypothesis that reached durable docs before retraction).

1. `suites/budget-cap/` — job-explicit-vs-default cap precedence never discriminated: the only fixtures (900s, 10s) breach/pass **both** the 300s job cap and the 60s global floor. Claim: `resolveEnforcedBudget = (_job, defaults) => defaults.global` — ignoring every per-job operator cap — leaves all 7 tests green. A 100s fixture would discriminate. (COST-1)
2. `suites/system-health/health-surfacing.test.ts:328-337` — claimed **pure tautology**: compares two test-local literals, touches no SUT symbol; allegedly survives deleting the entire health module. (secrets/redaction)
3. budget-cap cost dimension: every run passes `costUsd: 0`, so the cost branch never fires — deleting it leaves the suite green.
4. budget-cap audit-redaction test uses only `toContain`, never an exclusion assertion, so it cannot fail on extra leaked content.
5. `auth-suite` folds `rejected && untouched` into one boolean — weakening it to `rejected` alone (deleting the trip-wire the test is named for) stays green.
6. `approval-flow` describe over-claims "decided exactly ONCE across BOTH channels" with no fixture reaching the channel dimension.
7. `calendar-conflict:589-613` — 3 distinct fixtures collapse to 2 code paths.

### Lens G — NEVER RUN

**SUT imported but never actually invoked on the path under test.** Untouched. Start here.

### The L79-variant sub-lens (folded into F, not separate)

*Does this fixture still reach the condition the test's name claims?* — same question asked of the fixture rather than the fake. Cheap to fold into F; not worth its own pass.

---

## ⛔ The sweep terminated on an OWNER BOUND, not on exhaustion

**Iteration 3 was productive. Iteration 4 would likely also be productive.** L64's stopping condition — *a pass that adds nothing* — was **never met** at any point.

"We stopped looking" and "there is nothing left" must not blur. That blur is the exact defect class this round spent itself closing. **#30 remains open and NOT dry.**

---

## Decisions explicitly NOT made

- **The 6 `meeting-closeout-e2e` / `RETRIEVAL_RELEVANCE` criteria** — not re-pointed at nearby suites. "Correct the pointer" and "write the suite" mean opposite things; re-pointing a safety-classed criterion at a convenient neighbour manufactures the appearance of coverage while fixing a coverage defect. → **#37**.
- **`RETRIEVAL_RELEVANCE`** — resolved to (b) **by read, not by default**: the criterion's metric is `retrieval-usefulness`; `retrieval-recall.test.ts` computes `|gold ∩ top-K| / |gold|`, which is recall. A system retrieving *everything* scores recall 1.0 with poor relevance. Recall cannot stand in for relevance. Left escalated.
- **`DASHBOARD_WARMLOAD_P95` harness-vs-enforcer** — corrected the path only (identity-preserving). `test/benchmarks/dashboard-warmload.test.ts` also exists and is what actually *enforces* the budget; which one the criterion should cite is left open, not guessed.
- **Lens F's 7 findings** — not verified, not fixed. Volume reported before fixing, per the owner's bound.

---

## TDD compliance — clean, with a note on what "test first" means for guard work

All four commits are test-only (plus one registry path correction). The analogue of *failing test first* for guard-hardening is **prove the guard blind first**, and every fix followed a required three-state protocol:

1. compromise applied, guard **PASSES** → blindness reproduced
2. guard fixed, compromise still applied, guard **FAILS** → it now discriminates
3. compromise reverted, guard **PASSES** → no false positive

**State 2 is load-bearing** and is what a fix-without-simulation skips. It caught an incomplete fix of my own (see below). No violations.

---

## Reachability

N/A for the guard changes (test-only). `src/harness/criteria-registry.ts` is a value change consumed by `test/coverage-matrix.test.ts` and the runner; no new exported symbol.

---

## What I got wrong (recorded because the successor inherits the habit, not just the code)

1. **An invalid simulation that looked like evidence.** For #27 I patched `@sow/providers` when the test imports `redactString` from `@sow/domain`. It "passed 24/24" and I nearly reported it. Caught only because a companion assertion *should* have fired and didn't. → banked into **L75**: *prove the compromise was REACHED — by seeing the guard FAIL before you trust it passing.* Import path is one way to fail that; a second, unrelated way appeared the same day (right function, no test feeding the triggering input).
2. **A wrong root-cause hypothesis, stated confidently, that reached durable docs.** I claimed the predecessor "never ran the suite." The truth: they measured their own dirty tree, reverted, and the clean `git status`/`git log` checks that followed were true of a *different* tree-state. Retracted before it set. → **L71**.
3. **Nearly shipped a half-fix that looked complete.** #27 was two stacked defects — a blind oracle *and* nothing feeding it a PEM. Fixing the reported half left the suite still 24/24 green under compromise. *An oracle only protects what the corpus actually drives through it.*
4. **A known-bad baseline list was my first instinct for #29** — which IS the emptiable-label defect (L74) I had spent two slices hunting. Caught it and redesigned as a ratchet.

---

## Open follow-ups

| # | Item |
|---|---|
| **#30** | 24.6-B — sweep **NOT dry**. Lens G unrun; lens F's 7 findings unverified; **E1 verified and unfixed**. |
| **#37** | Write the meeting-closeout real-integration spine suite. ⚠ **CONSTRAINED, NOT DEFERRED** — `requiresRealIntegration: true`, needs live Temporal + vault + gbrain, so no unit suite can satisfy it. Unblocks `MEETING_CLOSEOUT_REPLAY`, `WORKSPACE_ROUTING` (rule 4), `KNOWLEDGE_WRITE` (rule 1). On completion, delete the three entries from `KNOWN_DANGLING_SUITES` and lower the ceiling — the ratchet mechanically enforces this. |
| — | `RETRIEVAL_RELEVANCE` disposition still escalated (recall ≠ relevance). |
| — | `WORKSPACE_LEAKAGE` is `requiresRealIntegration: false`, so a seam run scores DoD-passing. Noted by the lead; not addressed here. |

---

## Protocols adopted this session (carry these forward)

**Mutation-window protocol.** Simulation mutations in a shared working tree are **indistinguishable from a real regression to every other implementer**. My `validateProjectionVisibility` mutation showed provint 4 phantom failures mid-slice; I hit the mirror image myself when a worker/desktop mid-write surfaced as a phantom `17/20` typecheck.

- Announce **file + expected duration** before opening any window outside `packages/evals`.
- Keep each window to a single **mutate → run → revert → verify-clean** pass; never leave a compromise applied while thinking.
- ⭐ **If a finding needs a window that can't be cheaply announced, report it UNPROVEN rather than skip the proof or take the window silently.** An honestly-labelled unproven finding beats a phantom-red blocking a teammate.

**The ratchet pattern** (`test/coverage-matrix.test.ts`) — for when a known-bad set must be recorded without becoming a suppression list. Three simulation-proven failure modes: a new bad entry fails; **appending to the baseline to silence a failure fails** (the count is asserted against a hardcoded ceiling that must be visibly *lowered*); and fixing an entry while leaving it listed fails. The list can only shrink. It fired **for real** on first contact, forcing 6→4. ⚠ The ceiling counts **CRITERIA, not paths** — stated explicitly in the assertion message, because a ratchet that can only be lowered bakes in a wrong unit permanently.

**Counts in prose go stale within minutes on a live tree.** Three of us produced three different dangling-pointer counts; the difference was staleness, not units. **Cite the file, not the number.**
