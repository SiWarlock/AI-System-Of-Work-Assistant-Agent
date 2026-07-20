---
description: Orchestrator-only — initialize an orchestrator session; load briefing, summarize state, propose next /tdd slice.
allowed-tools: Read, Grep, Bash
argument-hint: ""
---

> **Role guard — ORCHESTRATOR only.** If you are an **implementer**, stop: run `/session-start`, not this. `/orchestrate-start` + `/orchestrate-end` are the **orchestrator's**; the implementer's pair is `/session-start` + `/session-end`.

You're starting an orchestrator session for System of Work Assistant. Orient before taking any action.

## Step 1 — Read the briefing

Read `docs/orchestrator-briefing.md` end-to-end. It covers: who the user is, project context, your responsibilities + messaging budget, the Step-9 routing matrix, commit cadence, conventions, tools available.

## Step 2 — (defer) the /tdd brief format

You'll read `docs/tdd-brief-template.md` **when you actually author a brief** (Step 8 / `/orchestrate-end` next-brief), not at orient — it isn't needed to summarize state. Deferring it keeps the session-start load lean.

## Step 3 — Read focused sections of `IMPLEMENTATION_PLAN.md`

**Don't read the whole file** — `grep -n "^##" IMPLEMENTATION_PLAN.md` for section offsets, then `Read` with `offset`/`limit` just:
- **"Currently in progress"** (top)
- **"Carry-forward to upcoming briefs"** (your working set)
- the **active phase section**
- the last 2-3 round entries — tail `docs/archive/IMPLEMENTATION_LOG.md` (the plan's `## Log` is only a pointer stub)

## Step 4 — Read the most recent session doc (named sections only)

```bash
ls docs/sessions/    # take the highest-numbered file
```

Read only its **"What was built", "Decisions made", "Decisions explicitly NOT made", "Open follow-ups"** sections (grep the headers + `Read` offset/limit) — not the whole doc.

## Step 4.5 — Pre-load architecture anchors cited by the active task(s)

`IMPLEMENTATION_PLAN.md` cites `ARCHITECTURE.md` anchors per phase + per task. Pre-load **only** the anchors cited by "Currently in progress" + "Next session target" — not the whole architecture.

```bash
grep -oE '#[a-z0-9-]+' IMPLEMENTATION_PLAN.md | sort -u    # all anchors in the tracker
# Then for the specific Currently-in-progress task(s):
grep -B 2 -A 15 "Currently in progress" IMPLEMENTATION_PLAN.md | grep -oE '#[a-z0-9-]+' | sort -u
```

For each anchor cited by the active task(s), use `/check-arch <topic>` (or targeted `Read` with `offset`/`limit`) to load just that section. **Skip when** the active task has no architecture-anchor citations.

**Purpose:** the orchestrator authors briefs that cite anchors; the anchors must be loaded to verify the brief's premises. Skipping this step risks authoring against stale assumptions.

## Step 5 — Read the area `CLAUDE.md` lookup table

Don't load it all. Read the lookup table (top section) + the cross-doc invariants table for the active area. The lookup table maps topics to `ARCHITECTURE.md` sections — it tells you where canonical answers live so you can dispatch reads on demand. The cross-doc invariants table is what you maintain when fields/invariants change.

## Step 6 — Conditional pre-orient code + architecture review

**Trigger — fires when ANY of these is true** (not the looser "subject is an existing code surface"):

(a) The next session target is **refreshing a stale brief** (a prior brief in `docs/briefs/` whose slice didn't ship yet, where any slice has since landed that touches the brief's scope).

(b) **The active area's cross-doc invariants table has changed** since the prior brief touched it (check via `git log --oneline packages/contracts/CLAUDE.md`).

(c) **The cited architecture-anchor section has been edited** since the prior brief touched it (check via `git log --oneline ARCHITECTURE.md`).

**Skip when** the next action is pure docs work, a greenfield slice with no existing surface, or a brief authored against current HEAD with none of the above triggers firing.

When triggered, read end-to-end:
- **(a)** the production code files the brief's slice will drive
- **(b)** the `ARCHITECTURE.md` sections the brief cites as spec anchors (extends Step 4.5 if drifted)
- **(c)** the prior brief being refreshed (`docs/briefs/NNN-<task-id>-<topic>.md`) + session doc(s) of any slices that landed since it was written
- **(d)** the canonical example / template the slice's output mirrors, if any

**Purpose:** confirm the brief's premises hold against shipped code — surfaces are real not placeholder, model shapes match the docs, spec anchors aren't drifted. Surface any cross-doc drift found — it's orchestrator territory to fix; flag for an atomic edit folded into the round.

**Output:** fold a short "pre-orient review" section into the Step 7 summary — what's operational, what's stale, any drift found, explicit confirmation you can author the refreshed brief.

**Discipline:** orient and report first — do NOT pre-author the refreshed brief during the review.

## Step 7 — Summarize back to the user

Report in 8–15 lines:

1. **Where the project is** — current `IMPLEMENTATION_PLAN.md` state, last commit hash + suite count (if applicable), deployment status if relevant.
2. **What's queued up** — "Currently in progress" anchor + "Next session target" pointer.
3. **Carry-forward items** the next brief must fold in.
4. **Most recent session doc summary** — what just landed in the prior round.
5. **Open decisions** from "Decisions tabled" if any.
6. **Any blockers** that may affect today's work.
7. **Proposed first action** — typically authoring the next `/tdd` brief per the "Next session target."

## Step 8 — Align on direction before acting

**Don't take action yet.** Report your summary up the chain — at team start, the team lead relays it to the human, who confirms the first action, redirects, or asks for clarification. Mid-project, the proposed first action defaults to `IMPLEMENTATION_PLAN.md` "Next session target"; proceed once that's confirmed (a redirect or a critical/safety question escalates; routine continuation does not).

## When to invoke

At the start of any orchestrator session. Run once per session; subsequent commands assume the briefing is loaded.

## Forbidden in this command

- **Don't author the next /tdd brief before the user confirms.** Brief authoring is a deliberate step — the user picks the next slice after seeing your summary.
- **The Step 6 pre-orient review is read-only orientation.** It informs the brief — it doesn't produce it.
- **Don't load the entire `ARCHITECTURE.md`.** Use the lookup table; load sections on demand.
- **Don't act on Step-9 items proactively.** Step-9 routing is reactive (the user pastes summaries from the implementer session).
