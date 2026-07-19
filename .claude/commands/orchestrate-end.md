---
description: Orchestrator-only close-out — verify hot routing, reconcile the task tracker, prep next session.
allowed-tools: Read, Edit, Write, Bash, Grep, SendMessage
argument-hint: ""
---

> **Role guard — ORCHESTRATOR only.** If you are an **implementer**, stop: run `/session-end`, not this. `/orchestrate-end` is the orchestrator's round close-out; the implementer's close-out is `/session-end`.

An implementer just ran `/session-end` and produced a session doc (its recap came to you directly). You (the orchestrator) reconcile planning state and prep the next session. **You ARE the orchestrator** — the one who routed Step 9 items hot during the session and authored the `/tdd` briefs.

`/orchestrate-end` is verification + reconciliation, not aggregation. Hot routing should already have done most of the work. This command catches drift and captures the orchestrator's framing.

> **Note on per-slice context-checks:** the per-slice context check (orch runs `/context-check` locally; pings the lead only on a tier crossing) is NOT part of this command — it runs after each slice's Step-10 (see `docs/orchestrator-briefing.md` "Per-slice context check"). `/orchestrate-end` is just the round close-out.

## Step 1 — Locate the implementer's session doc

```bash
ls docs/sessions/
```

Find the highest-numbered file. Read it end-to-end. The "What was built", "Decisions made", "Decisions explicitly NOT made", and "Open follow-ups" sections are critical context.

If no implementer session ran this round (orchestrator-only session — scaffolding, deploy ops, big planning shifts with no `/tdd` cycles), skip to Step 6.

## Step 2 — Verify Step-9 hot-routing landed

You routed each Step-9 item hot during the session, per the **canonical matrix in `docs/orchestrator-briefing.md`** (loaded at `/orchestrate-start` — don't re-copy it here). Verify each landed: grep the lesson title in `packages/contracts/LESSONS.md` + its linked index row in `packages/contracts/CLAUDE.md`; `git diff` any `ARCHITECTURE.md` edits; grep Carry-forward / the phase for routed TODOs; confirm any deferment was escalated. The **most-likely-to-slip** is *Completed work → ticked checkbox* — Step 3.

Anything that slipped — write the fix now (escalate only if it's a deferment or safety finding).

## Step 3 — Reconcile `IMPLEMENTATION_PLAN.md` checkbox state

The "Completed work → ticked checkbox" row is the most-likely-to-slip routing. Walk the implementer's session doc "What was built" + "Decisions made" sections. Every completed task should have a `[x]`. Tick any missed ones now (conservative — only `[x]` if work is *complete and verified*, not "mostly done").

If a slice landed partial work, leave the box `[ ]` and add a parenthetical note: `(partial: <what landed; what's still missing>; deferred to <slice or phase>)`.

**Phase ticks are gated.** A phase-level checkbox is ticked complete only after a **CLEAR `/phase-exit` verdict** for that phase (or rows explicitly waived by the human, recorded on the row). Task-level ticks are this step's normal work; phase-level ticks are not.

**New-task anchor rule (HEADING-level only).** Any `### <phase-id>.N` heading added this round (Step-9 routing, Step-5.5 INLINE-TARGET) must carry `(implements §X; origin: <slice>)` — or `(ops — no contract anchor)` for purely operational tasks — and §X must be covered by its phase's `Spec anchors:` line. No covering anchor ⇒ that's a **contract gap**: route an Architecture-doc note + escalate as a Finding; never a silent task add. A task carries exactly ONE state-checkbox line (the first content line under its `### <phase-id>.N` heading); the metadata/field lines beneath are plain fielded lines, never checkboxes.

## Step 4 — Append a Log entry to `docs/archive/IMPLEMENTATION_LOG.md`

The plan file carries **no** inline Log. Append the round's framing (same format below) to `docs/archive/IMPLEMENTATION_LOG.md` — an append-only audit trail read on demand, never loaded whole. Do **not** write round narratives into `IMPLEMENTATION_PLAN.md`; the plan holds only NOW (Currently-in-progress) + the forward working set (Carry-forward).

Format:

```markdown
### YYYY-MM-DD — <session topic, orchestrator's framing>

- <bullet: what completed at the planning level>
- Decisions made: <if any>
- Scope shifts: <if any items moved between phases, between MVP and nice-to-haves>
- New blockers / open questions: <if any>
- Next session target: <what's queued up>
- Reference: implementer session doc `<NNN>-<date>-<topic>.md` for technical detail.
```

## Step 5 — Update planning state

- **Decisions tabled** — resolved entries move to the round's Log entry in `docs/archive/IMPLEMENTATION_LOG.md` (with the resolution); new entries get added with rationale.
- **Carry-forward to upcoming briefs** — add items the next `/tdd` brief MUST fold in. New entries include an origin marker `(origin: YYYY-MM-DD <slice-id>)`; multi-slice spreads also include `last-consumer-slice: <id>`.
- **Trims / Nice-to-Haves Catalog** — add entries for anything deferred this session with come-back guidance.
- **"Currently in progress"** — **REPLACE the whole section (do NOT append).** It is a snapshot of NOW: `≤3` items / `≤15` lines — last commit hash, suite count, next session target, active blockers. **Delete** the prior snapshot's lines; never stack rounds. **No round narratives** (those go to `docs/archive/IMPLEMENTATION_LOG.md`) and **no materialized `/phase-exit` checklists** (those live in the archive with a `Gate:` pointer — see `/phase-exit`).

## Step 5.5 — Triage Carry-forward to upcoming briefs

The Step-9 routing matrix routes operational/optimization items INTO the Carry-forward section (Step 5). There's no symmetric step that routes them OUT. Without active triage the section accumulates monotonically and stops being useful for next-brief authoring. Step 5.5 closes the loop.

Walk every bullet under `## Carry-forward to upcoming briefs`. Read each item + its origin date marker. **Apply DELETE and INLINE-TARGET mechanically — no user prompt** (a completed or phase-owned item is a bookkeeping fact, not a scope decision). **Only DEFER (a scope cut) escalates to the user.** For each item pick one of five outcomes:

| Outcome | When | Action |
|---|---|---|
| **(a) DELETE** | Item was completed since it landed in Carry-forward | Remove the bullet; cite where it was completed |
| **(b) KEEP** | Item is needed in the IMMEDIATELY next `/tdd` brief (next 1–2 slices) | Leave in Carry-forward; fold it into the next brief |
| **(c) INLINE-TARGET** | Item belongs in a specific phase's scope | **Convert it into a real task checkbox in that phase/subphase** (a `- [ ]` entry, phrased as a unit of work); remove from Carry-forward. Do NOT leave it as an `Operational TODO` annotation — it becomes a first-class task. |
| **(d) DEFER** | Item is genuinely post-current-sprint | **Deferment → escalate to the human.** On approval, move to the deferred-phase backlog / Trims with an origin note; remove from Carry-forward |
| **(e) SPREAD** | Item spans multiple future slices | Annotate with `last-consumer-slice: <id>`; keep in Carry-forward; auto-delete at that slice's `/orchestrate-end` |

Per-item: apply the outcome directly. DELETE/KEEP/INLINE/SPREAD are orchestrator-handled; **DEFER escalates** (deferment approval).

**Resolved items are DELETED, never annotated.** An item completed since it landed is removed with a one-line archive/commit pointer — do **not** leave a `✅ RESOLVED` / "safe to prune next round" marker in place. A resolved annotation is a lint failure. Overflow past the `~7` cap that is still live moves to that item's phase as a `#### Residuals` bullet, not kept in Carry-forward.

After the walk, surface counts: *"Triage complete: K deleted, M inlined, J deferred, S spread, N kept."* **Hard cap: keep Carry-forward under ~7 items.** If it's still over the cap after triage, or any item is >3 slices old with no consumer, force-resolve those (INLINE-TARGET or DEFER) — Carry-forward is a small working set, not a backlog.

This step runs BEFORE the round commit (Step 7) so triage outcomes land in the same commit.

## Step 6 — Optionally create an orchestrator-side session doc

Decision criterion: did substantial *orchestrator-side* work land this round? Substantial = scaffolding refactor, deploy ops, infrastructure changes, big planning shifts, or a session that ran orchestrator-only with no `/tdd` cycles.

If YES → create `docs/sessions/<NNN>-<date>-<topic>.md` (next sequential NNN, shared sequence with implementer docs; **track-prefixed `<track>-<NNN>-…` in multi-track mode**, same track as your implementer's docs — root `CLAUDE.md` "Naming + numbered-doc collision prevention"). Update the predecessor session doc's Successor link.

If NO → no orchestrator-side doc needed.

## Step 6.5 — Run the plan-format lint (blocking)

Before staging, run the structural lint on the reconciled tracker:

```bash
scripts/plan-lint.sh IMPLEMENTATION_PLAN.md
```

It enforces the format contract mechanically: `≤3` Currently-in-progress items, `≤7` Carry-forward with no resolved-in-place annotations, exactly one state-checkbox line per `### N.M` task (vocabulary `DONE/PARTIAL/OPEN/DEFERRED/OWNER-GATED`; `DONE` needs `` `hash` `` + ISO date), no state tokens on headings, a `**Spec:**` anchor or `arch_gap` per task, `OWNER-GATED` tasks pointing at a defined `§ARM-*/§DEC-*` ledger, and a Log section that is only a pointer. **Exit non-zero blocks the close-out** — fix the violations, do not commit around them. This is the mechanical backstop for the caps that were promised but never enforced.

## Step 7 — Commit the round + push

After reconciliation, the orchestrator-side working tree has:
- `IMPLEMENTATION_PLAN.md` updates (box ticks, Carry-forward additions + Step-5.5 triage relocations, "Currently in progress" refresh, Decisions tabled changes)
- Any hot-routed `packages/contracts/LESSONS.md` + `packages/contracts/CLAUDE.md` index additions that haven't ridden a slice commit yet
- Any hot-routed `ARCHITECTURE.md` prose edits that haven't ridden a slice commit yet
- Any `/tdd` brief file(s) authored this round in `docs/briefs/<NNN>-<task-id>-<topic>.md` (incl. in-place refreshes of a stale brief)
- Optionally a new `docs/sessions/<NNN>-<date>-<topic>.md` from Step 6

Stage these explicitly (do NOT use `git add -A`):

```bash
git add IMPLEMENTATION_PLAN.md \
        docs/archive/IMPLEMENTATION_LOG.md \
        packages/contracts/LESSONS.md \
        packages/contracts/CLAUDE.md \
        ARCHITECTURE.md \
        docs/briefs/<NNN>-*.md \
        docs/sessions/<NNN>-*.md
git status --short  # Verify only orchestrator-domain files staged
```

Author the commit message — Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer — capturing the orchestrator's framing of the round:

```bash
git commit -m "$(cat <<'EOF'
docs(tasks): <round topic — orchestrator framing>

<body — what was reconciled, scope decisions, transition state, next
session target. Reference the implementer's session doc by NNN.>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

Then **push to none configured (run `git init`; push when a remote is set) only**:

```bash
git push <remote> <branch>
```

This is the round's terminal commit. **Verify the push mechanically** — the `git push` exit status plus `git status -sb` showing the branch is no longer ahead. Never block the close-out waiting for a human to confirm a push the shell already confirmed; who you REPORT to depends on mode (Step 8).

## Step 8 — Close the round (mode- and trigger-aware)

Assemble the close-out summary:
- What was reconciled (boxes ticked, Log entry appended to `docs/archive/IMPLEMENTATION_LOG.md`, Carry-forward additions)
- Step-5.5 triage outcomes + threshold-warning state
- Anything that slipped through hot routing (and the fix that landed)
- Whether an orchestrator-side session doc was created
- Round commit hash + mechanical push verification
- Suggested next slice — reference `IMPLEMENTATION_PLAN.md` "Currently in progress" + "Carry-forward" (now triaged)
- _(production-grade, optional)_ a report-only `pnpm audit --prod` one-liner (new-vs-baseline) if run this round — the blocking run stays at `/phase-exit`

Then route it three ways (this is the **canonical close-out spec** — root `CLAUDE.md` "Close-out gating" points here):

- **(a) Single-operator** — present the summary to the user and confirm. Once the user confirms, author the next `/tdd` brief per `docs/tdd-brief-template.md` (saved as `docs/briefs/NNN-<task-id>-<topic>.md`) if the user wants to continue. Otherwise the round closes here.
- **(b) Team, user-on-demand close-out** — ack the **LEAD** via `SendMessage`: one terse send (round-seal hash + "round closed"; the lead relays to the user — you never report to the user directly). Then **idle**. Author the next brief only on lead-relayed direction, never on your own initiative after a close-out.
- **(c) Team, auto-cycle (context-triggered)** — ack the lead with the same one-liner (include the verbatim `/context-check --brief` tier line when the cycle is for your own context). **Author NO next brief** — your successor authors it after `/orchestrate-start` reads the reconciled tracker. Expect a `shutdown_request` from the lead; approve it once the round commit is in and your working tree is clean. **Nothing in this branch waits on a human reply** — the mechanical trigger already carried the authorization (root `CLAUDE.md` "Close-out gating").

## Forbidden in this command

- **Re-aggregating Step 9 items.** They were already routed hot. This command verifies, doesn't re-route.
- **Pushing to the wrong remote.** Push to none configured (run `git init`; push when a remote is set) only.
- **Authoring the next /tdd brief before the round is sealed** (commit + mechanically-verified push). In single-operator mode, also wait for the user's confirm; in a team auto-cycle, never author it at all — the successor does (Step 8c).
- **Blocking the close-out on a human reply in team mode.** Push verification is mechanical (exit status); the ack goes to the lead via `SendMessage`. A context-triggered cycle that waits on a user confirmation deadlocks the team at exactly the moment context is scarcest.
- **Skipping Step 2 or Step 3 verification.** The whole point of this command is catching what slipped through hot routing.
- **Skipping Step 5.5 triage.** If the Carry-forward section is never drained, it accumulates monotonically and stops being useful.
- **Deferring without escalating.** A DEFER (scope cut) is a deferment approval — escalate to the human; never cut scope agent-only.
- **Committing a round whose `plan-lint.sh` exits non-zero.**
