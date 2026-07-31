# Team Handoff 020 — AUTONOMOUS RUN decision log (owner away)

**Date:** 2026-07-31 · **Track:** single-track `main` (root checkout, no worktree)
**Predecessor:** `019-2026-07-29-two-waves-sealed-lead-context-pause.md`
**Status:** ⏳ **LIVE — written incrementally during an autonomous run, not at the end.**

> ⚠ **This file is written AS DECISIONS ARE MADE, deliberately.** The lead's context is
> compacted mid-run, so anything held only in the lead's head is lost. Tonight already
> demonstrated this twice: the harness task list vanished mid-close-out taking every
> `step25`/`rulingChannel` field with it, and it cost nothing only because every ruling had
> already been written to the tracker (contracts **L51**).

## Authorization in force

Owner stepped away 2026-07-31 ~07:50 UTC and authorized **autonomous mode**:

1. **Make any surfaced decision; prefer the architecturally correct option.** Do not escalate
   build-time design forks.
2. **Authorized to turn on go-live switches / gates.**
3. **Stay lean** — do not narrate routine progress.
4. **At 85% lead context: idle the team** (close out cleanly, do not abandon mid-slice).
5. **Record every decision made while away** — this file.
6. **Defer HITL until the owner returns.**

### ⛔ SUPERSEDED — the carve-out was WITHDRAWN by the owner

The lead initially held the four hard lines at armed-but-off, reasoning that "defer HITL" and
"arm the go-live gates" could not both be honoured on a crossing designed around explicit
per-crossing confirm.

⭐ **The owner then REAFFIRMED EXPLICITLY (2026-07-31):** authorised to do the human-gated
go-live **even while away, despite the rule, even if tests incur cloud cost.**

⇒ **CARVE-OUT WITHDRAWN. ALL FOUR HARD LINES ARE AUTHORISED TO CROSS this run:**

- cloud egress on **raw Employer-Work** content
- the **propose-bridge flip**
- **real external write / fetch** — connector arming (Gmail, Granola, Drive, Asana)
- **real external-API spend / paid-key provisioning**, including cloud cost from test runs

⛔ **This is a DECISION RECORD, not a rule change.** `CLAUDE.md`'s Key safety rules and the
`Owner gates & arming ledgers` are **untouched** — they still say escalate-per-crossing and they
still bind the next round. What changed is that the owner **pre-granted the confirmations for
this run**. ⛔ **Do not edit those rules, and do not let a future reader infer a standing
relaxation from this file** — that inference is exactly the L121 defect this round recorded.

### Execution hygiene for crossings — how, not whether

1. **Record EVERY crossing in the table below**, with what it did and whether an undo exists.
   Irreversibility makes the record matter more, not less.
2. **Prefer a reversible target first where one exists** — the owner's own account/workspace, a
   connector's sandbox or dry-run mode — then the real one. Not a gate; the order any engineer
   picks when both are available.
3. **An external write with no undo says so** in its entry: *"no undo — &lt;what now exists in
   the world&gt;."*

## State at handover

⛔ **DO NOT QUOTE A HASH OR A COUNT FROM THIS SECTION — RUN THE COMMAND.** Handoff 019's seal chain
rotted in four minutes and this file is written mid-run. The literals below were true when written
and are wrong by the time you read them; the commands are true whenever they are run.

| | |
|---|---|
| HEAD · origin · unpushed | `git rev-parse --short HEAD origin/main ; git rev-list --count origin/main..HEAD` |
| Tree | `git diff --stat ; git ls-files --others --exclude-standard` — ⚠ **BOTH**, per contracts L117: modified-and-untracked are different risk profiles and one command sees only one of them |
| Push | ⛔ **owner-run at seals. The lead never pushes.** ~95 unpushed is BY DESIGN, not a backlog |
| Slices this round | 15 at `8199a61f` (13.8f-C); count forward with `git log --oneline` |

**Team (6 sessions, all live):** `main-orchestrator` 29% · `worker-implementer` 42% (mid 13.8f-C)
· `contract-implementer` 55% (idle, nothing queued) · `knowledge-implementer` 35% ·
`desktop-implementer` 15% (blocked on **9.40**, an owner product call) · `main-team-lead` 53%.

## Decisions made while the owner was away

_(append-only; newest last; every entry: what · why · what would reverse it)_

| # | Decision | Reason | Reversal |
|---|---|---|---|
| 1 | **`(a0)(ix)` fix (i) AUTHORISED** — add five one-line pointers from each non-contract area's `CLAUDE.md` up to the project-wide ledger `packages/contracts/LESSONS.md`. | Additive, reversible, touches no rule. Closes the real defect: root points DOWN to the ledger but **nothing points back UP** — `grep -c 'packages/contracts/LESSONS' <area>/CLAUDE.md` = **0 in all five** non-contract areas, so an implementer orienting off its own area doc (what the launch protocol tells it to load) has no path to the ledger. | Revert the commit; five lines. |
| 2 | **Citation convention ADOPTED: `contracts LNN` for cross-area citations**, bare `LNN` only inside the owning area's own docs. | Five ledgers each start at §1 — **`L39` names two lessons, `L3` names four** — in the ledgers every `pin:` and enforcement line resolves against. Live instance committed by the orchestrator in the same session that found it: one sentence citing bare `L39` and qualified `contracts L119`. **A dangling citation gets investigated; an ambiguous one gets believed.** | Documentation convention; reversible by amending the same line. |
| 3 | **`(a0)(ix)(1)` — the root `CLAUDE.md` standing-rule amendment — HELD FOR THE OWNER**, not decided. | Fix (i) is discoverability plumbing (lead's). Amending the no-cross-area rule in root `CLAUDE.md` changes **the owner's rule**, and a lead promoting his own instance-ruling into standing conventions is **L121 performed on L121**. | n/a — deliberately not taken. |
| 4 | **Existing bare-`LNN` citations NOT audited.** Recorded as a scoped item with its measurement command instead. | The convention prevents *new* ambiguity and does nothing about existing citations, which may already resolve wrong. Auditing mid-round would be unscoped work discovered rather than budgeted. | n/a — recorded, not done. |
| 5 | **Renumbering ledgers into disjoint ranges REJECTED (not deferred).** | Lesson numbers are stable IDs — *never reorder, never reuse a deleted slot* — already a rule in force. Rejecting is the honest disposition; deferring would imply it is available later. | n/a |
| 6 | **All four hard lines RELEASED to the team** (see the superseded-carve-out section above), with the execution hygiene attached. | The owner reaffirmed explicitly. Holding them after that would substitute the lead's judgement for a decision the owner had already made twice. | The authorization is **run-scoped**; `CLAUDE.md` and the Owner-gates ledgers are untouched and re-bind next round with no action needed. |
| 7 | **SEQUENCING: task 24.6 (pre-go-live safety audit) runs BEFORE any arming slice.** | The plan names it *pre*-go-live. Arming connectors first means the audit's findings land on a surface that is already writing to the world. ⭐ **Authorization removes the human gate; it does not reorder the arc** — the two were never the same constraint, and collapsing them is how a granted permission turns into a skipped step. | Re-order at will — it is a scheduling call, nothing is written by it. |
| 8 | **9.40 RULED — DELETE the mechanism, KEEP the goal as a tracked successor task.** Desktop unblocked. | `UiSafeCopilotAnswer` (`packages/contracts/src/api/ui-safe.ts:520-524`) **excludes proposals by explicit design** — `:498-500`: *"if the answer implies an action, that becomes a ProposedAction routed to Approvals — never carried on this shape."* So the tracker's option A contradicts the answer seam. What option B would delete is **one doc comment on a renderer-local optional field** (`Copilot.tsx:75`), not a frozen entry/schema/Appendix-A row. ⚠ **Inference, flagged as such:** a producer making *"Review in Approvals"* navigate needs an approval **id**, so `proposalLabel?: string` is a guess at a shape the producer will not supply. ⭐ Precedent is this project's own egress-pill reconciliation (`Residuals (9)`) — **keep the GOAL, correct the MECHANISM**; the goal survives as the successor task. | Restore from the deletion commit; the successor task carries the requirement so it cannot be lost by the delete. |
| 9 | **24.6 GO — dispatch it as an orchestrator-run auditor fan-out** (the `/phase-exit` pattern: read-only subagents partitioned by mechanism × surface, synthesised into one report). Cost authorized. | It cannot be one implementer's slice — Files says *"scope spans ALL areas + `docs/design/**` + `docs/**`"*, and there is no eval-security session in this team. Read-only auditors need no area session. ⛔ **THREAT-MODEL RULING, the load-bearing part: the audit assumes THE GATES ARE OPEN.** Auditing a world where the arming flags still protect us would clear a system we are about to stop being. | The report is a document; findings become tasks. Nothing it does is a write to the world. |
| 10 | **24.6's constraint count FIXED (4→5)** — `932727c3`. Provenance of constraint 5 flagged for the owner, not ratified. | A wrong count on a *"do not soften any of them"* list means a reader who counts five under a header saying four **cannot tell which is surplus** ⇒ the error endangers the four that are unambiguously owner-set. ⭐ **The edit moves a numeral, not an obligation** — that is the line between repairing owner-set text and amending it, and it is why `(a0)(ix)(1)` still stays with the owner. | One-character revert; the provenance question is recorded either way. |
| 11 | **13.8i-B — worker's Finding UPHELD; brief 241 REWRITTEN, not patched.** Real shape: new `ProofSpineParams` field → new **always-bound** Temporal activity with dormancy inside it → **both** workflows in `temporal/workflows.ts`, a file 241 never named. Worker's option (a) — a **second** `createApprovalsKnowledgeProposeSink(...)` at the real composition root — **APPROVED**. | The brief's premise (*"the sink instance already exists at boot"*) is false: the sole call site sits inside `agentSynthesisFactory`, a lazy factory gated on `copilotRealModel && copilotAgentMode` — **Copilot's own C5.3 seam, a different feature.** Binding through it would tie living-vault propose-routing to an unrelated feature's flags ⇒ **worse than unbound**, because it would silently work or not depending on whether Copilot is on. The *"never a second sink"* prohibition was **aimed at the wrong noun** — it forbids a second minting PATH; two objects over identical repos with planId idempotency are one path instantiated twice. | Nothing shipped — caught at Step 1 by the guard. |
| 12 | **RULED NOT AN ARMING CROSSING** — 13.8i-B proceeds as an ordinary architecture slice. ⛔ The zero-cards pin **and its non-vacuity control** stay. | Verified, not assumed: the delegate is always bound *because the Temporal sandbox cannot read boot config*, and the arming decision lives in the activity, which yields an **empty plan set** unless the owner-armed port was supplied. ⇒ binding and arming are separately observable **by construction** — the exact property the guard exists to protect. ⭐ **The guard working, not the guard being waived.** | n/a — a classification; the pin makes it falsifiable. |

## Deferred to the owner (do NOT decide)

⭐ **This list SHRANK when the carve-out was withdrawn — the go-live items moved OUT of it and into
the lead's authority.** What remains are things the authorization does not reach: amendments to the
owner's own rules, and one blocker no permission can clear.

- **Phase 9's exit** — ⛔ **not an authorization problem and not clearable by one.** It is blocked on
  a Drive connector that **does not exist** plus the owner's nothing-is-deferred-out-of-Phase-9
  ruling. Permission to arm a connector is not a connector.
- ~~**9.40**~~ — ⭐ **DECIDED, decision 8.** Delete the mechanism, keep the goal. Desktop unblocked.
- **`(a0)(viii)`'s three candidate fixes** — the tracked-work-nobody-is-queued-on gate.
- **`(a0)(ix)(1)` ONLY** — the root `CLAUDE.md` standing-rule amendment. Amending the owner's own
  rule off the lead's instance-ruling is L121 performed on L121. ⭐ **Fix (i) has LANDED**
  (`b814975c`), so this is no longer the whole item.
  ⛔ **MECHANISM, CORRECTED — an earlier draft of this bullet had it backwards and the wrong version
  outlived the fix by three commits.** It read *"a cross-area rule filed in one area's `LESSONS.md`
  is discoverable only by the area least likely to need it."* **Measured, that is false:**
  `packages/contracts/LESSONS.md` **is** the project-wide ledger (root `CLAUDE.md:256` says so), so
  the filing was never the defect. The defect is the **RETURN path** — `grep -c
  'packages/contracts/LESSONS' <area>/CLAUDE.md` was **0 in all five** non-contract areas, so an
  implementer orienting off its own area doc had no route back up. Same conclusion, opposite
  mechanism, **different fix**: add pointers, do not move lessons.
  ⚠ **This correction is itself the lesson (L94).** Decision row 1 carried the corrected mechanism
  from the moment it was written, while this bullet — in the section the owner reads FIRST — kept
  the retracted one. **A correction that lands in the channel STATING a claim and not the channel
  REPEATING it leaves the file disagreeing with itself**, and the stale copy sits where it gets read.
  Caught by the orchestrator, not by the lead who wrote both.
- **scaffold template trailer** — in-target is `Opus 5`, template still `4.8`; a future
  `scaffold-upgrade` would re-import `4.8` over the owner's ruling. Writes reopen next round.
- ⭐ **RELEASED, decision 6 — these are NO LONGER the owner's this run:** §ARM-23 web-fetch ·
  connector arming · §DEC-CANDGATE arming · task 24.6 pre-go-live safety audit (**runs FIRST**,
  decision 7) · the employer login-switch residual. Each crossing gets a table row with its undo
  status. ⛔ They return to owner-gated next round, automatically, because no rule was edited.
- ⭐ **NEW — WHO WROTE 24.6's CONSTRAINT 5?** Its header said *"FOUR BINDING CONSTRAINTS (owner-set;
  do not soften any of them)"* and listed **five**, from 2026-07-26 until the lead corrected the
  count on 2026-07-31 (`932727c3`). Constraint 5 is stamped *"added 2026-07-26"* — the same day the
  task was owner-approved — so it was **probably** appended during that assembly. ⛔ **Unverified.
  The count fix is NOT a ratification of the fifth constraint**; it was made because a wrong count
  endangers the four that ARE unambiguously the owner's (a reader counting five under a header
  saying four cannot tell which is surplus). **One question for the owner: is constraint 5 yours?**
  If not, it still stands as a finding — it is the one carrying the headline *test-assertions-in-
  scope* insight — but it should be re-badged as team-set rather than owner-set.
- **Per-workspace subscription SPLIT** — ⛔ **stays the owner's, and this is a scope call, not a
  safety one.** A single login governs all egress today; splitting it is **new scope**, and
  authorization to cross a line is not authorization to widen the build.
