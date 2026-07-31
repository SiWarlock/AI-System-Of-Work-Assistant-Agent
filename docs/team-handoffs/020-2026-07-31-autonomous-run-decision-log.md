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

| | |
|---|---|
| HEAD | `9121300c` |
| `origin/main` | `809516ad` — **87 commits unpushed, owner-run, DO NOT PUSH** |
| Tree | 10 modified (worker mid-slice on 13.8f-C), 0 untracked |
| Round terminal | `4811805b` (+ `214fc8a9`) — orchestrator's books, **not a round seal** |
| Slices this round | **14** |

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

## Deferred to the owner (do NOT decide)

- **Phase 9's exit** — blocked on a nonexistent Drive connector + the nothing-deferred ruling.
- **9.40** — Copilot proposal-row affordance: populate (needs a worker procedure) or delete
  (a product call). **Desktop's only unblock.**
- **`(a0)(viii)`'s three candidate fixes** — the tracked-work-nobody-is-queued-on gate.
- **`(a0)(ix)`** — L121's discoverability gap: a cross-area rule filed in one area's
  `LESSONS.md` is discoverable only by the area least likely to need it. Root `CLAUDE.md`
  amendment is the owner's, not the lead's — see the provenance argument in L121.
- **scaffold template trailer** — in-target is `Opus 5`, template still `4.8`; a future
  `scaffold-upgrade` would re-import `4.8` over the owner's ruling. Writes reopen next round.
- Employer login-switch residual · per-workspace subscription split · §ARM-23 web-fetch ·
  connector arming · §DEC-CANDGATE arming · task 24.6 pre-go-live safety audit.
