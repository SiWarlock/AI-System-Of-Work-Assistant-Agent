# Team Handoff 026 — the arming block RELEASED; lead cycles at ACTION

**Date:** 2026-08-12 · **Track:** single-track `main` (root checkout, no worktree)
**Predecessor:** `025-2026-08-12-…` (orchestrator dump; supersedes 023/024)
**Successor:** _(filled in by the next `/team-end`)_
**Round-seal at handoff:** `0f46da64` — *"seal round 3 continuation 3 — the 24.44 pair, and four findings fenced as preconditions"*
**Tip at handoff:** `76728383` (worker's session doc 160, landed after the seal)

> ⛔ **VERIFY EVERY LITERAL BELOW BY COMMAND. Every state claim in this file self-invalidates.** `git status` returns the literal `ok` here **and so does `git commit`'s receipt** (contracts **L133**) — and `git ls-files` lists the **INDEX**, so a *staged* file reads as "tracked." **Committed means `git log --oneline -- <path>` returns a hash. Nothing else.**

---

## Why this handoff exists

**Lead context hit ACTION (78%).** Mechanical trigger, not a work boundary. All three implementers `/session-end`-closed and the round sealed before this was written — the gate passed, verified by the lead from `git log`, not from a report.

## ⭐⭐ THE HEADLINE — read before any task list

**THE OWNER RELEASED THE ARMING BLOCK (2026-08-12).** All four release conditions discharged; three lead-verified against the committed tree.

⛔ **AND THE PRECISION IS THE POINT, because this is where a reader takes too much:**
- **What was released:** the **BLANKET HOLD** that sat on top of every crossing since round 2.
- ⛔ **What was NOT:** **EVERY INDIVIDUAL CROSSING REMAINS OWNER-GATED BY ITS OWN `§ARM-*` LEDGER. NOTHING IS ARMED. NO CROSSING MAY EXECUTE WITHOUT EXPLICIT OWNER CONFIRMATION AT THE TIME.**
- **It is NOT "arming clear."** The release **returns us to per-crossing gating** — it does not grant a single crossing.
- **Safety rules 1–7 in root `CLAUDE.md` are untouched.** Step-9 flags on rules 1/4/5/6 still route to the lead as well as the orchestrator.

**Recorded in THREE surfaces deliberately** — `IMPLEMENTATION_PLAN.md` "Currently in progress", `## Owner gates & arming ledgers` (leading with *"the block was released and THAT CHANGED NOTHING ON THIS PAGE"*), and the turn-on runbook after `## Overview` — **because a crossing-planner reads the latter two, not the tracker.**

### ⚠ The open caveat — a RECOMMENDATION, explicitly NOT a blocker

The owner released **without** conditioning on it; it must not be recorded as a condition. But:

⛔ **`24.6`'s severity gradings across audits `001`–`004` rest on REACHABILITY QUALIFIERS, and that class of claim was falsified THREE TIMES IN ONE SESSION by three competent people working by hand** (contracts **L141**) — **biased toward over-claiming reachability.** `24.29`'s repo-wide mechanical census exists and **has not been pointed at them.**

⇒ ⭐ **Anyone planning a real crossing should re-derive the reachability qualifier for that crossing's findings first.** ⭐ *A finding graded "dormant, therefore not a live breach" is exactly the shape that was wrong three times.*

## ⚠ Post-handoff addendum (landed after this file's first commit — read it)

**A post-seal addendum committed at `e8ab0426`, after seal `0f46da64` and after this handoff's own commit.** Three corrections it carries:

1. ⛔ **The seal UNDERCOUNTED `24.49`: it said EIGHT sites fixed. It was NINE.** The ninth (`test/source-ingestion.test.ts:627`) was reachable only via **the key the implementer asked to add before starting** — invisible to every key in the sweep before it. ⭐ **The load-bearing act was the implementer's own pre-sweep caveat: it reported *"7 found by THESE keys plus one known survivor — not 7 that exist"* and asked to re-run rather than proceed on a number it could not defend.** ⇒ ***a sweep that has already demonstrated it can miss a member of its own result set is not finished, and the person best placed to know that is the one who ran it.***
2. ⛔⛔ **THE ROUND IS NOT SEALED AS "SUITE GREEN." Do not read it that way.** Two true numbers are in circulation at different scopes and units (knowledge: **7595 passed** test cases at leg 2; worker's preflight: **527 / 1 / 8**). **They agree on the only thing that matters: exactly ONE failure — the desktop bundle test, pre-existing, unowned, `### 24.25`.**
3. ⭐⭐ **THE CROSSING ASYMMETRY — the round's most reusable process finding, and no task holds it.** **Six message-crossings between lead and orchestrator in one session.** ⭐ **FOUR of the six were alarms that work was MISSING when it had already LANDED — and that direction is SELF-CORRECTING, because someone re-checks and finds it there.** ⛔ **A crossed message asserting something IS done when it is not would NOT self-correct: nobody re-checks a reassurance.** ⚠ **The dangerous direction did not occur this round, and NOTHING STRUCTURAL PREVENTED IT** — the only defence that operated was `L133`/`L117` discipline on both sides. **Every crossing resolved by reading the tree instead of trusting recollection, twice when the stale belief was the implementer's own.**

## Team composition at close

| Role | Model | Closed at |
|---|---|---|
| Lead (this session) | Opus 5 | writes this handoff at 78% |
| `main-orchestrator` | **Opus 5** (owner-directed mid-round swap) | seal `0f46da64` |
| `worker-implementer` | **Opus 5** | doc `160` `76728383` |
| `knowledge-implementer` | Sonnet 5 | doc `158` `4d6acd28` |
| `providers-integrations-implementer` | Sonnet 5 | doc `159` `ca629230` |

⭐ **MODEL NOTE, CORRECTING A STANDING ERROR: the `Agent` spawn `model` param DOES override `CLAUDE_CODE_SUBAGENT_MODEL`.** Verified in `~/.claude/teams/session-<id>/config.json` — four members, differing values, in one config. **A prior note claiming otherwise cost an incorrect "you need a session restart" recommendation to the owner.** `.claude/settings.local.json` is now `opus[1m]`. **Mixed-model teams work; no restart needed.**

## State at close

- **Tree CLEAN** — zero modified, zero staged, zero untracked (both L117 checks run by the lead).
- **`plan-lint`: 0 violations**, 4 warnings (baseline).
- **168 commits unpushed — owner-run, by design.** Never quote that number from prose; `git rev-list --count origin/main..HEAD`.
- ⭐ **A `pre-commit` hook is INSTALLED** (`.git/hooks/pre-commit` → `scripts/hooks/pre-commit-plan-lint.sh`): staging `IMPLEMENTATION_PLAN.md` with a plan-lint violation **blocks the commit**. Owner-authorized. ⚠ **Repo-local, not shared by clone** — the briefing's mandatory before-and-after `plan-lint` step **remains binding and is marked do-not-delete**.

## Next dispatch (from Currently-in-progress; NO brief authored — successor authors after `/orchestrate-start`)

- **worker → `24.48`**
- **providers → `24.45`** ⚠ **scope grew mid-round — re-read, do not assume**
- **knowledge → `24.26`** (a cross-track PAIR; see the ruling below)

⛔ **`24.50` and `24.52` GATE any drain/port wiring.** Both are **wiring preconditions**, not follow-ups — *safe by construction, not safe by dormancy.*

## Lead rulings this session (provenance, so they're traceable)

1. ⭐ **`24.44` authorized as a cross-track PAIR** — first-of-its-kind extension of **`L121`** from test fixtures to **production** code. Two orchestrators in a row correctly refused to authorize it and routed it up.
2. ⛔ **The orchestrator then AMENDED my ordering, on verified evidence, and was right.** I required *no red window*; I implied **producer-first**, which **cannot deliver it** (the async flip breaks the consumer at the intermediate commit). **Consumer-first can** — `await` on a non-thenable is legal (proved by `tsc` on a replica; no ESLint exists to object). ⭐ **And it is NARROWER than what I authorized: neither implementer writes outside their territory, so the precedent is two in-territory commits, not one cross-territory write.** ⛔ **Copying the ruling WITHOUT the ordering gets the red window back.**
3. **`24.49`'s contracts site** — a **narrow, comment-only, own-commit** cross-area crossing, **explicitly NOT precedent** and **explicitly not `L121`**. Landed `bbe22d75`.
4. **The `plan-lint` pre-commit hook** — built dormant, then **owner-authorized and installed**.

⚠ **On `24.44`'s no-red-window Done-when: the lead verified the ORDER and both commits, and did NOT re-execute the intermediate tree** (a checkout would disrupt three concurrent writers). ⭐ **The orchestrator supplied a better method: `git log <leg1>..<leg2> -- <both pair files>` returns NOTHING ⇒ no third party perturbed either side.** **Accepted-on-evidence, not re-executed — recorded that way on `### 24.44`.**

## ⭐ What actually made this round trustworthy

**TWELVE-PLUS corrections landed against claims carrying lead or orchestrator authority. Every one attached evidence. Every one was right.**

- **Four orchestrator errors caught by implementers** — a "zero behavior delta" overstatement; a consumer table inferring optionality from a call site; **a fixture that would have passed for the wrong reason**; a path-less citation producing a **false negative**.
- **Two reviewers falsified premises in approvals the orchestrator had already given.**
- **The lead was corrected repeatedly** — a false "24.33 is LIVE" claim that had **changed an owner release condition** (caught by knowledge reading source); three **stale file-state claims** in fifteen minutes; a stale `24.43` dispatch that would have sent a fresh session to redo shipped work; **two registry prunes that removed LIVE entries**, one of which left an orchestrator throttling against a phantom 79% while actually at 37% for most of its session.
- **All three implementers refused to start on a premise they could not verify.**

⇒ ⭐⭐ ***The record is good because claims were cheap to falsify and people did — not because anyone was careful.***

## Lessons banked: `L141`–`L146`

Highlights the next lead should actually hold:
- **`L141`** — hand-verified reachability fails; three wrong calls on one module in one session, each by someone who had just watched the previous one fail.
- **`L142`** — a release-condition change is complete only when **the LEAD re-reads the doc and confirms**. ⛔ **That surface drifted TWICE in one day**; both times the ruling reached the inbox and never the document.
- **`L143`** — a finding is written once with evidence and thereafter only its **TEXT** is re-read, never its **CLAIM** re-measured. **Treat any finding older than a round as a hypothesis and re-run the check it specifies.** ⭐ Corollary: **a finding stating NO re-runnable check can only be believed — write findings with their falsification command attached.**
- **`L145`** — false-liveness in comments: *a reachability assertion is about the WHOLE PROGRAM; a comment sits inside ONE FILE.* **The one claim a comment is least equipped to make is the one it is most trusted for.**
- **`L146`** + the path-less-citation rule.

**Two rules banked as amendments rather than new lessons:**
- **`L116` gains its operational half** — *when relaying a ruling that overlaps existing plan prose, cite the part of the ruling the prose CANNOT contain.* (The discriminator is the **assignment**: the pair, the file, the line. Prose can be quoted; a dispatch cannot be forged from it.)
- **`L61` gains the enumeration rule** — *a brief's scope is an artifact of DISCOVERY, not of the defect's extent.* **Enumerate consumers, or state explicitly that you did not** — an unenumerated brief isn't wrong, it's **unscoped**, and the two need different handling. ⛔ **And the METHOD must travel with the count: a name-grep is CLOSED for a function and OPEN for an interface.** *A count without its method is `L118` wearing a number.*

⭐ **Three under-scoped briefs in one hour proved it: `24.23` 1→4 consumers · `24.37` 3→14 sites · `24.49` 3→6→7→9, where the ninth was found by the key the fix itself added.**

## Recurring shapes worth carrying

- ⭐ **The remedy is a high-frequency site for the defect it remedies** — five instances in one day, including `24.41`'s decomposition annotating resolved items in place **while quoting the rule forbidding it.**
- ⭐ **"The defect arrives with the fix for it"** — `24.45`, `24.50`, `24.52`. All fenced as **wiring preconditions**.
- ⭐⭐ **The inverse, rarer and harder to see:** *when you correct a wrong value, ask what its wrongness was incidentally preventing.* **`24.15`'s hardcoded literal was also, incidentally, what made a latent posture-binding gap unreachable.** A free, untested, real guarantee nobody had recorded.
- ⭐ **`L144`** — *"DONE" plus a green suite does not prove a migration exists.* The test was **strong** and pointed at a **different object** than the one that deploys. Invisible to typecheck, suite, review **and** `/wired`.

## Operational traps (each cost real time; all verified)

- **`git commit`'s receipt lies in BOTH directions** — false landings **and** wrong file counts (three instances).
- **`git ls-files` lists the INDEX** — a staged file reads as tracked.
- ⛔ **Never read an exit code through a pipe** — `tail` exits 0 and `&&` sees tail's status. An orchestrator committed over a plan-lint RED that way.
- ⛔ **`grep -E` with ALTERNATION returns EMPTY through this environment's wrapper even when content is present.** Single-pattern greps, or read the file. **And a grep cannot distinguish a use from a mention** (`L104` — `serveProjection`'s mentions outnumber its uses ~7:1).
- ⚠ **Registry pruning: discriminate by DUPLICATION (one name, two entries ⇒ older superseded) or by CONFIRMED TERMINATION — never by AGE.** Age killed two live sessions today.
- ⚠ **A teammate NAME outlives the SESSION it referred to.** After a cycle, address a successor as a **new party**; do not continue a thread.

## Open decisions for the human

1. **The arming release is DONE** — no longer pending. Individual crossings remain per-crossing gated.
2. **PUSH** — 168 commits unpushed, owner-run.
3. **The census re-derivation** (open caveat above) — recommended before any real crossing; not a blocker.
4. **`24.46`** (contracts) and **`24.47`** (eval-security) sit in **unqueued tracks** — they need a session spawned or a narrow lead-authorized crossing.

## Spawn prompts

**Orchestrator** (`main-orchestrator`, spawn with `model: "opus"`):
```
You are main-orchestrator on the System of Work Assistant agent team.
Track: main (single-track, root checkout — NO worktree). Track label: main.

FIRST ACTION: ~/.claude/scripts/team-register.sh "main-orchestrator" orchestrator "main" "" "main"
Then run /orchestrate-start. NOT /session-start.

REQUIRED READ FIRST: docs/team-handoffs/026-2026-08-12-arming-block-released-lead-cycle.md — it supersedes 025.

⛔ SAFETY: the owner RELEASED the arming block. The BLANKET hold is lifted. EVERY individual crossing
remains owner-gated by its own §ARM-* ledger. NOTHING IS ARMED. Not "arming clear."
Safety rules 1–7 untouched; Step-9 flags on rules 1/4/5/6 route to the lead too.

Queue (no brief authored — you author after reading the reconciled tracker):
worker → 24.48 · providers → 24.45 (scope grew; re-read) · knowledge → 24.26 (cross-track PAIR — the
pair call is the LEAD's, not yours). 24.50/24.52 GATE any drain/port wiring.

Traps: git commit receipts lie in both directions; git ls-files lists the INDEX; never read an exit
code through a pipe; alternation greps return empty here; a pre-commit hook is INSTALLED for
IMPLEMENTATION_PLAN.md. Verify commits by `git log --oneline -- <path>`.

Confirm: (1) start command, (2) registry entry exists.
```

**Implementer** — substitute `<AREA>` / `<DIR>`, spawn with `model: "opus"`:
```
You are <AREA>-implementer on the System of Work Assistant agent team.
Track: main. Working directory: <DIR> (repo root checkout — NO worktree). Talk only to main-orchestrator.

FIRST ACTION: ~/.claude/scripts/team-register.sh "<AREA>-implementer" implementer "main" "<AREA>" "main" "main"
Then run /session-start. NOT /orchestrate-start.

Read root CLAUDE.md + <DIR>CLAUDE.md + <DIR>LESSONS.md index, then docs/team-handoffs/026-….

⛔ SAFETY: the arming block's BLANKET hold is released; NOTHING is armed; every crossing stays
owner-gated at the time. Step-9 flags on rules 1/4/5/6 route to the lead as well as the orchestrator.

⭐ The behaviour that made last round work: three implementers refused to start on premises they
could not verify, and were right every time. Verify what you are handed — including from the lead.

Wait for main-orchestrator's brief; do not self-assign.
Confirm: (1) start command, (2) registry entry exists.
```

## How to resume

Next lead runs `/team-start main`, reads **this doc**, prunes the team-registry **by duplication or confirmed termination — never by age**, spawns from the prompts above with `model: "opus"`, and verifies read-backs. **No re-orient overhead — this doc is the orient.**
