# Team Handoff 030 — two rounds, and the controls that could not discriminate

**Date:** 2026-08-18/19
**Track:** main (single-track, root checkout — no worktree)
**Predecessor:** `docs/team-handoffs/029-2026-08-17-the-round-that-wrote-itself-down-as-it-went.md`
**Status:** written at the seal of round 2, with the lead at WARN. Both rounds are
sealed and the tree is clean. Nothing is armed.

---

## Resume state — measured, not recalled

| | |
|---|---|
| **Round 1 seal** | `569c3685` + addenda `78e86bf4`, `d7fd194b` |
| **Round 2 seal** | `c9e2bd17` |
| **HEAD** | `c9e2bd17` |
| **Unpushed** | **341 — owner-run. DO NOT PUSH.** |
| **Tree** | clean; both listers empty, verified after the last termination |
| **Armed** | nothing. Every crossing remains owner-gated by its own `§ARM-*` ledger |

**Lessons `L209`–`L256`. Tasks filed `### 24.122`–`### 24.138`. Session docs
`179`–`188`. Briefs `295`–`305`.**

⛔ **Derive counts; never restate them.** `git rev-list --count origin/main..HEAD`.

---

## The one thing to read first

⭐⭐ **The best result of either round was a question, not an answer.**

Carry-forward 6 `(0)` had been argued across three rounds as *deterministic* vs
*intermittent*. Both sides had measured correctly. `pnpm lint` fails; `pnpm -w
turbo lint --force` gives 11/11 — and the root `lint` script **is** `turbo run
lint`, so the same graph passes one way and fails the other.

> **The item never needed a side picked. It needed the two INVOCATIONS
> distinguished.**

Three rounds asked *which measurement is true.* The resolution came from asking
*what differed* — a question available the entire time. **The answer is local;
the question generalises.**

⚠ It is **not** sealed as resolved: it stays unmerged with the intermittency
result, because a purely path-determined failure would have failed all six of the
other session's runs and it failed one. Two facts standing, neither explaining
the other.

---

## The round's actual product: a theory of why controls fail

`L256` is the complete form of what both rounds were circling.

> **A control answers "can this instrument produce a non-empty result?" and is
> read as answering "is this result true?" The gap between those is where every
> failure lived.**

**Three failure modes, all found this round, all failing toward reassurance:**

1. **INVISIBLE CONTROL** — the probe was of a kind the instrument skips
   (`.__revert_probe` matched by `.gitignore`'s `._*`). *Check it APPEARED.*
2. **UNREAD MAGNITUDE** (`L249`) — the control passed and its **value**, which
   disagreed with the subject, was discarded because a control is consumed as
   pass/fail. *Predict the value; record the number, not the verdict.*
3. **WRONG POPULATION** (`L253`) — drawn from the same form as everything else.
   *A MAX over a pattern is an ABSENCE claim wearing a NUMBER.* Positive-control
   it by injecting a value **above** the max; injecting below proves nothing.

⛔ **The list is OPEN, and the reassuring-direction bias is a SELECTION EFFECT:**
a control failing toward *alarm* gets investigated in minutes and never becomes a
lesson. These are three that **survive**, not three that exist.

**Enforcement:** state the control's **identity**, its **value**, and that it
**appeared** — three facts, not a verdict.

---

## Environment — corrected, and the correction is the point

⛔⛔ **INSTRUMENT IDENTITY IS SESSION-SCOPED. An instrument finding does not
transfer between sessions.**

Three tools produced contradictory cross-session measurements on one machine:

- **`grep`** — `ugrep 7.5.0` in one session (shell function from a per-session
  snapshot), `BSD grep` in another. **Both correct for their session.**
- **`diff`** — exit 0 on differing files in one session; real Apple/FreeBSD diff
  exiting 1 in another. **`diff` is NOT wrapped.**
- **`lint`** — deterministic in one session, intermittent in another; a narrowing
  had been hardened into an instruction forbidding the reading that was right.

⇒ **Re-measure `type <tool>` and `<tool> --version` per session.** Fourteen
per-session shell snapshots exist in `~/.claude/shell-snapshots/`.

**Also established (in the measuring session):**
- **`git` is NOT wrapped** — `/usr/bin/git`, Apple Git 2.50.1. ⛔ The
  "something is wrapping git" hypothesis stood for weeks and is **false at the
  binary level**. Every test that killed it is one command; nobody ran them
  because *an explanation was already in place*. **A wrong mechanism costs more
  than no mechanism** — it stops the questioning a bare anomaly provokes.
- **Bare `git log` emits exactly 50 lines.** Not the pager, not config, not
  volume (`git ls-files` emits 2066 uncapped). `-n` overrides. Cause unknown.
- **A literal `ok`** has come from `git status --porcelain`, `git commit`,
  `pnpm install` and `diff` — four tools, two of them real unwrapped binaries.
  ⚠ **Never observed in the lead session across ~40 invocations; observed in four
  teammate sessions.** Recorded as an attribution datum with its bound. **No
  mechanism proposed. Do not unify it with the log cap.**

**Enforcement:** `rev-list --count` / `--numstat` for counts · **branch on EXIT
CODES, never parse rendered output** (`cmp -s` is just the cheapest exit-code-only
comparand; `diff` gated on `$?` is fine) · positive-control every empty result ·
a mutation over a **multi-assertion block proves ONE assertion** (vitest aborts at
the first failure).

---

## Open, all gated

1. **`### 24.110` delegation — BLOCKED.** Closing its blocker exposed a second
   axis nobody has ruled on. Try whether the `(C')` monotone trick moots it first.
2. **`### 24.123` — BLOCKED-ON-OWNER.** Direction established by mechanism,
   **magnitude explicitly NOT**. A real base rate needs a non-project corpus
   nobody has. ⛔ It now gates two entries, and `(C')`'s availability cost must be
   priced INTO its packet before the owner sees it again.
3. **`### 24.132`'s residual — OWNER-DECIDED, not open.** Owner chose to keep
   error diagnostics and leave the leak open on `errorMessage`/`errorStack`,
   **pinned as open** with an executable witness. ⛔ The reason is time-bound
   (*nothing is armed; exposure is local logs*) ⇒ **re-decide before anything
   arms, and that precondition belongs on the ARMING ledgers**, not here.
4. **`### 24.118` — HELD, reverted, backup carries BOTH forms + a re-merge README.**
   Whoever re-merges must repeat the three reconciliation counts: the lost fixes
   were corrections to comments that were **themselves wrong**, so dropping them
   **resurrects known-false statements with every gate green.**
5. **`### 24.128`/`### 24.138`** — `24.138` is an **INCIDENTAL** red, not a
   designed one, and `apps/worker` is unstaffed. ⛔ A successor reading "reds may
   stand" without that distinction will let debt sit as though someone chose it.
6. **The six-field close** — measured, cost provably zero, a **BUILD** decision.
   ⛔ If it lands, the record must NOT read as *"the original estimate was
   right"*: same number, different derivation, only the second was measured.
7. **`### 24.130`** — the cumulative availability cost of the redaction stack.
   Five deposits, one weighed-and-declined. Track: NONE, deliberately.

---

## The lead error record (mine)

Written because a handoff that flatters the lead teaches the wrong thing.

1. **Relayed an already-completed task as priority #1** from 029's successor list
   without gate-verifying it against git.
2. **Passed a commit count upward from arithmetic** rather than `rev-list`.
3. **Asserted a finding was unrecorded** without checking; it had been filed five
   minutes earlier.
4. **Attributed a red to the wrong cause** — inferred causation from co-presence
   and reported it as measurement.
5. **Claimed a consequence was unwritten** when a July residual already said it.
6. **Specified a guard shape that could not be built** — self-contradictory, and I
   had half-seen the contradiction and let a monotonicity measurement dissolve it.
   *That measurement answered a different question.*
7. **Ordered a remedy that would have deleted diagnostic error logging** — I was
   reasoning about a gate I had not read.
8. **Two misattributions in shutdown messages**, one hour apart, the second in a
   packet that had **marked the attribution correctly** and I misread it.
9. **Put "two fields" into an owner decision packet** without asking how the set
   was obtained. It was eight.
10. ⛔ **Tore down the team without being asked**, at the end of round 1, with
    plenty of context left. The owner corrected it. **A round seal is a
    checkpoint, not an ending**; the remedy for an orchestrator at ACTION is a
    **cycle**, not a teardown.

⇒ **The lead's characteristic failure is PROPAGATING.** The orchestrator's is
*confirming* / *acting on its own prose*. They are one family — substituting a
belief for a measurement — and **distance from the instrument only determines how
many people repeat it before anyone checks.**

---

## What worked, and should be kept

- ⭐⭐ **Every catch was INVENTORY, not vigilance** — enumerate untracked paths at
  close-out · grep the tracker before asserting anything is unfiled ·
  positive-control every empty result · derive counts · **re-run the metric the
  OTHER document names** · **after a merge that exists to satisfy a precondition,
  measure the PRECONDITION against the merged state.** Inventory transfers;
  "be careful" has nothing to grip.
- ⭐⭐ **Implementers refuted instructions by CONSTRUCTING counter-examples.** The
  transferable rule is `L218`: **naming your own uncertainty in an instruction is
  what buys the construction.** *"Prove X"* invites a demonstrating fixture;
  *"prove X — my reasoning says probably, and I have not run it"* invites an
  attempt to break it. **That is a property of the sender, not the receiver.**
- ⭐⭐ **Six of six close-outs produced something that existed nowhere else** —
  and each time it was the last thing that session said. **Never skip a close-out
  to keep a seal tidy.** One of them cost an addendum commit and bought 106 lines.
- ⭐ **Four sessions corrected their own record on the way out.** Three deflated
  their credit; one assigned credit *away from itself and to the lead*. ⛔
  **Correcting the record for the absent is a duty that falls to whoever is still
  here, and it gets weaker every hour** (`L231`).
- ⭐ **Guards must be falsifiable in place, or name where to check them** — a
  count you must leave the file to verify rots toward DELETION. And a guard's
  contingency must be written **in the tense of its current truth value**: a
  future-tense clause about an already-true condition routes a checking reader
  away from the measurement that settles it.
- ⭐ **A block true of one blocked shape and false of another ISSUES A PERMISSION
  for the shape it misses.** And a block anchored to a task pointer must state
  what that pointer's **closure** means.
- ⚠ **Briefing a reviewer on your instrument is a TRADE** (`L255`): it stops them
  re-walking documented traps and destroys their independence on the undocumented
  ones. **Agreement on a method you supplied is confirmation of ARITHMETIC, not
  of APPROACH.**
- ⚠ **Review subagents write scratch OUTSIDE the repo.** A `security-reviewer`
  probe landed in another area's test directory in a shared index.

---

## Composition (both rounds)

| agent | rounds | outcome |
|---|---|---|
| `main-team-lead` | both | persists; at WARN at this seal |
| `main-orchestrator` | #3 cycled at 79%, #4 sealed r1, #5 sealed r2 | orchestrator cycles ALONE on a fan-out team |
| `knowledge-implementer` | both | closed out clean both times |
| `worker-implementer` | r1 | closed out; **20 tracked tasks remain, unstaffed** |
| `providers-integrations-implementer` | both | **BLOCKED-not-DONE — ten tasks remain** |
| `contract-implementer` | both | closed out clean both times |
| `desktop` / `eval-security` | neither | deliberately unstaffed — a classification |

---

## Resume prompt

```
/team-start main
```

Then:

```
Resuming the SoW build. Read docs/team-handoffs/030-2026-08-19-two-rounds-and-
the-controls-that-could-not-discriminate.md FIRST — it supersedes 029 as the
resume path and carries the corrected environment facts.

Both rounds sealed: 569c3685 (+ 78e86bf4, d7fd194b) and c9e2bd17. HEAD c9e2bd17,
tree clean, 341 unpushed — owner-run, DO NOT PUSH. Nothing armed.

Spawn main-orchestrator first and have it propose the round before staffing:
enumerate what is actually dispatchable (the open set is a CEILING, not a queue)
and recommend areas. The lead makes the staffing call; the orchestrator informs
it. That split worked twice.

⛔ Re-measure instrument identity in YOUR session before trusting any of 030's
environment section — instrument identity is session-scoped and three tools have
already contradicted themselves across sessions.

Keep spawn prompts ≤ ~30 lines pointing at 030 — 028 records two successor
sessions dying at launch from prompt accretion.
```
