---
description: Implementer-only — initialize an implementer session; read the task tracker, summarize, confirm scope.
allowed-tools: Read, Grep
argument-hint: ""
---

> **Role guard — IMPLEMENTER sessions only.** If you are the **orchestrator**, stop: run `/orchestrate-start`, not this. The `/session-start` + `/session-end` pair is the **implementer's**; `/orchestrate-start` + `/orchestrate-end` are the **orchestrator's**.

The user is starting a new working session. Get oriented before doing any work.

Procedure:

1. Read `IMPLEMENTATION_PLAN.md` (repo root) **by section, not whole** — `grep -n "^##" IMPLEMENTATION_PLAN.md` for offsets, then `Read` offset/limit just:
   - **"Currently in progress"** (top)
   - the last ~2 **Log** entries (tail)
   - **"Decisions tabled"**

2. If working in a code area, also read its `CLAUDE.md` lookup table so you know where canonical answers live.

3. Summarize back to the user in 4–8 lines:
   - What phase + tasks were in progress
   - What landed in the last logged session
   - Any blockers or open decisions that may affect today's work

4. Ask the user explicitly: **"What are we working on this session?"**

5. Match the user's answer to the task list:
   - If the named feature appears in a phase's checklist, point at the specific task(s).
   - If it doesn't appear, flag it: *"this isn't currently represented in `IMPLEMENTATION_PLAN.md` — should we add it before starting, or is this an out-of-band exploration?"*

6. If the session is a continuation of an in-progress task, briefly verify the prior session's commits are present:
   - `git log --oneline -5`
   - Confirm the working tree state matches the user's mental model.

**Do not start implementing anything in this command.** The job is orientation only — the user picks what to work on after seeing the state.
