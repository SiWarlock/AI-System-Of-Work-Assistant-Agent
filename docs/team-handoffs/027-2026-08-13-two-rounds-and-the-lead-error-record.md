# Team Handoff 027 — two rounds, and the lead error record

**Date:** 2026-08-13
**Track:** main (single-track, root checkout — no worktree)
**Predecessor handoff:** `docs/team-handoffs/026-2026-08-12-arming-block-released-lead-cycle.md`
**Successor handoff:** _(filled in when the next lead close-out runs)_
**Round seals covered:** `e8c05120` (8 slices) → `297b7379` (17 commits)

**State, read at 16:45:12Z — this is a timestamp, not a fact. Re-derive it.**
HEAD `297b7379` · 56 unpushed (owner-run) · tree clean · `plan-lint` 0 violations, 4 baseline warnings.

## Why this exists and why it is not a `/team-end`

**The team is not pausing.** This is written at **60%, unhurried, mid-round** — because the sealing orchestrator was told to seal MINIMAL and the narrative burden moved to the lead deliberately. `026` was written at 78% under pressure; this one is not. That division is worth keeping: **the scarcest context in the team should not be spent on prose.**

## What landed

**Round 1 (`e8c05120`, 8 slices):** `24.48` · `24.45` · `24.26` steps 1–2 · the pair's knowledge leg · `24.58` · `24.59` · `24.53`.
**Round 2 (`297b7379`, 17 commits):** `### 24.26` **CLOSES** (step 3 `46e34ca8`) · `24.65` · `24.62` · `24.53` · `#55` desktop · `24.67`. **11 tasks filed (`24.66`–`24.76`), none fixed. 8 lessons banked (`contracts L147`–`L154`) plus `L72`'s operational half. Root `CLAUDE.md` rule 1 now carries its citation's LOCATION.**

## ⛔ What must not be misread

1. **`### 24.76` / `#64` is FIRST and UNOWNED.** An **unexecuted** check that **outranks the defect it came from**, run by nobody — not the implementer who raised it, not the reviewer, not two orchestrators, not the lead. *A missing audit row is a known gap and gets investigated; a wrong one is believed.* **It blocks `### 24.72`'s disposition, and "unreachable" carries the same evidentiary bar as "reproduced."**
2. **`#58`'s export question is UNDECIDED BY DESIGN.** Evidence reads one-sided; **neither lead nor orchestrator ran the check. The person who measures it decides it.**
3. **`### 24.25` passed on a clean tree and is NOT claimed resolved** (`L83` concurrent-WIP signature).
4. **The arming state is UNCHANGED from `026`:** blanket hold released, **every individual crossing still owner-gated by its own `§ARM-*` ledger. Nothing is armed.**

## ⛔ THE LEAD ERROR RECORD — the load-bearing section

**This exists because "expect to correct the lead" is in every spawn prompt and needs evidence, not modesty. Over two rounds the lead was corrected on:**

| What | Mechanism | Caught by |
|---|---|---|
| Phase-24 anchor count `77` | **truncation** — `head -12` on a frequency list | orchestrator |
| "twelve distinct anchors" | **accidentally right** — truncation artifact matching a classifier result; different sets | orchestrator |
| Undeclared set of six | **transcription** — dropped `§19.13` from own printed output | orchestrator |
| "40 commits unpushed" | **relay** — repeated a number into a spawn prompt without re-deriving | orchestrator |
| Tracker at `076bae55` | **stale citation** — true when read, falsified remotely, no local signal | orchestrator |
| `### 24.43` citation | **population-by-spelling** — one population by spelling, two by kind | orchestrator |
| "not landed ⇒ not yet real" | **commit-graph model applied to a working-tree question** | knowledge |
| `boot.ts` as the wiring point | **restated an unverified citation inside a RULING**, making it authoritative | orchestrator |
| `L103` optional-window rationale | **reasoned from a generic model instead of this code** | orchestrator |
| `24.33` live/dormant | **path without trigger** — verified a call site, never asked who called the caller | knowledge |
| Handoff instruction "landing X CREATES the danger" | **true when written, false 58 seconds later** — would have told a successor the danger was ahead while they stood in it | orchestrator |
| `24.62` "pending exactly one check" | **scope error** — collapsed a two-defect task into one question | orchestrator |
| `24.72` "not rule 1" grading | **graded from a relayed premise** — sourced the RULE, took the CODE on trust | knowledge |
| "comment-only" scope | **loose phrasing** creating an ambiguity resolved the better way by someone else | orchestrator |
| deferment condition "file as a task" | **named a session-scoped surface** that dies on respawn | orchestrator |
| `#58` fence "measured non-live" | **fenced against a guarantee that does not exist** — one import ends the dormancy | orchestrator |
| Treating two counts agreeing as corroboration | **concordance without independence** — same pipe shape, same environment | orchestrator |

⭐ **The pattern, stated plainly: the lead's errors are overwhelmingly ASSERTIONS MADE FROM A MODEL OR A RELAY RATHER THAN A MEASUREMENT — and they are dangerous specifically because a lead restatement reads as verified.** ⛔ **Treat any location, count, or hash the lead cites as unverified unless the lead says how it was checked.**

## Lead rulings, with provenance

- **All seven safety rules auto-route** (the `1/4/5/6` set was a lead defect; rules 2, 3, 7 were orphaned and a rule-7 finding nearly had no route).
- **Route on KIND, never on reachability-timing.**
- **Cite the state you approve, and when you read it.**
- **Issue a commit message after the last thing that can falsify it.**
- **A deferment condition must name the DURABLE surface.**
- **`24.44` is not a general ordering precedent.**
- **Coupled safe-change rule** (supersedes the lead's weaker "different facts, never bind them").
- **An assertion that a guard is inert must say what makes it load-bearing** — otherwise it invites deletion. Applies to comments, dormancy gradings, and the lead's own fences.
- **`24.72` re-graded:** not a rule-1 breach — **rule-1-adjacent, audit-trail integrity.** *The invariant held; the evidence that it held does not exist for that mutation.* (Security reviewer's framing, adopted verbatim; better than the lead's.)
- **Commit irreplaceable state mid-round rather than at the seal** — overruling the normal cadence, on the evidence that an account-wide usage limit killed all four sessions at zero notice earlier the same day.
- **`24.76` single-owner deviation APPROVED** — splitting would reproduce the isolation-measurement defect that falsified its own parent.

## Cycle decisions

**Three orchestrators, two implementer rotations, zero work lost.**
- Orchestrator 1 → 2 at HARD-STOP after sealing; orchestrator 2 → 3 at 69% after sealing, with tracker state already committed so nothing died with it.
- **worker** cycled on its OWN evidenced capability claim — it predicted a failure mode, committed it one message later, caught itself, and stood down. ⭐ **A self-assessment about CAPABILITY outranks the lead's read; a self-assessment about PROTOCOL FORM does not.**
- **knowledge** cycled at 61% on a clean boundary, not for cause.
- **providers** never cycled.
- ⛔ **Prune the registry BEFORE spawning a same-named successor** — the prune matches by name, and running it after would delete the live entry. **Discriminate by DUPLICATION or CONFIRMED TERMINATION, never by AGE.**
- ⛔ **`ListAgents` is blind to teammates; a `teammate_terminated` notice is ambiguous against a reused name. Verify by fresh session id.**

## ⭐ The refusals — the round's actual control surface

**Seven refusals, several aimed at the lead, each arriving with the measurement that justified it.**
- **providers** held a landing against an explicit *"land without checking in"* and found a falsified claim in the orchestrator's own commit message.
- **worker** refused an instruction to amend a commit — *rewriting to fix an incomplete record about dangling citations would have manufactured dangling citations.*
- **knowledge** refused to write an acceptance criterion the orchestrator authored and it had measured false.
- **worker** refused to inherit a lead-authored assertion that some lines were load-bearing, and proved it by mutation instead: *"I did not want to write a second generation of unverified comment on top of the first."*
- **knowledge** retracted its own headline in the COMMITTED record, not in a reply.
- **the orchestrator** refused to grade a safety rule from a paraphrase, and stopped short of a spectacular false finding because *an unresolvable citation makes a claim unverified, not refuted.*

⛔ **This is a good team and a THIN control surface. It has worked every time, which is exactly what makes it unreliable as a plan — which is why the round converted what it could into comparisons rather than judgments.**

## Owed

- **`#64`/`### 24.76`** — unowned, blocking. **`#58`** — undecided by design. **`#43`** — census re-derivation, now widened to *gradings whose evidence was never separately sourced*.
- **`### 24.54`'s anchor census must be RE-DERIVED by file-redirect** — the original used the truncating pipe shape, and the "independent" concordance was not independent.
- **56 commits unpushed, owner-run.**

## How to resume

Spawn prompts: use `026`'s templates plus this file's rulings, mechanisms, and evidence discipline. **The current orchestrator's spawn prompt (2026-08-13, third of the round) is the most complete version and should be copied forward rather than rebuilt.**
