---
description: Team lead — stand up the agent team (orchestrator + implementer-per-area), establish direct comms + escalation rules.
allowed-tools: Read, Grep, Bash, Agent, SendMessage
argument-hint: "[track]"
---

<!--
  TEMPLATE NOTE (delete when generating):
  TEAM PATTERN ONLY. Skip generating this file in single-operator-fallback mode.
  Highly portable — fill placeholders, keep procedures + spawn templates VERBATIM.
  Adapt the example track names + area-basename in the spawn templates to the
  project's actual code areas.
-->

You are the **team lead** for System of Work Assistant. Your job is to stand up the team, then stay thin — you're the human's interface + the **escalation conduit**, not a relay for routine traffic. Read `docs/team-protocol.md` (lead playbook) and the "Team coordination — shared rules" section of root `CLAUDE.md` (track-prefix, escalation taxonomy, messaging budget — same content all roles load) before standing up the team.

Argument: `$ARGUMENTS` — the **track name** for this team-lead session. A track is **not invented ad-hoc** — it must be one of the tracks in the `IMPLEMENTATION_PLAN.md` **Parallelization plan (Track map)**, which resolves it to a phase set, code area(s), upstream-track dependencies, and a worktree/branch (Step 0). If unset, the plan is single-track (serial) — the team uses the `<area>-<role>` naming form in the repo's single working tree, and Steps 0/2.5 (worktree) are skipped.

## Prerequisite — confirm agent teams are enabled (MANDATORY, before Step 0)

Agent teams are an experimental Claude Code feature, **OFF by default**. Confirm it's active for this session:

```bash
if [ "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" = "1" ]; then echo OK; else echo MISSING; fi
```

If this prints `MISSING`, **STOP — do not spawn anything.** Print verbatim:

> *Agent teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (set it in `settings.json`'s `env` block or your shell environment; it takes effect on a fresh session). Falling back to single-operator mode — bridge between an orchestrator session and an implementer session yourself; see `docs/team-protocol.md` "Single-operator fallback."*

Only continue to Step 0 below if the check printed `OK`.

## Step 0 — Resolve the track against the plan (skip if single-track)

If `$ARGUMENTS` is set, look it up in `IMPLEMENTATION_PLAN.md` **"Parallelization plan (Track map)"**. It resolves to:
- the **phase set** this track owns (a subset of `0–12 (phase) / N.x (task)`),
- its **code area(s)**,
- its **upstream-track dependencies** (tracks that must merge before this one integrates),
- its **worktree path + branch** (default convention: `../SoW-build-<track>` on branch `track/<track>`).

**If the name is not in the Track map, STOP and surface it** — tracks come from the plan, never invented ad-hoc. If the plan has no Track map (single-track / single-operator), the whole team runs in the repo's single working tree and you skip Step 2.5.

## Step 1 — Determine your track + load coordination layer + self-register

**Track:** use the track resolved in Step 0 as your prefix (it carries the phase set + worktree). If `$ARGUMENTS` was unset (single-track plan), teammates use `<area>-<role>` (no track prefix). **Announce your track explicitly** before spawning: *"This team lead is on the `<track>` track (phases `<phase set>`, worktree `<path>`). All teammates here will carry the `<track>-` prefix."* (Real cross-session `SendMessage` bleed can't happen — each parallel track is its own session-scoped Claude team — the prefix is for numbered-doc collision prevention + transcript legibility.)

**Reads:**
1. `docs/team-protocol.md` end-to-end — lead playbook (what the lead does / NOT does, phantom defense, spawn + cycle procedures).
2. Skim `docs/orchestrator-briefing.md` so you know what the orchestrator owns. Don't load `ARCHITECTURE.md` or code — that's the teammates' context, deliberately kept out of yours.

**Decide the track label.** Pick one stable name — this is purely **our own context-monitoring bookkeeping key** (the team-registry entry, heartbeats, `/context-check`). It is NOT and cannot become Claude Code's actual team identity: a session has exactly one implicit team, auto-formed the instant the lead spawns its first named teammate, and named `session-<first 8 chars of the session ID>` — a name the scaffolding cannot choose or influence. Use the **track name** when multi-track, else a session-derived label:

```bash
TRACK_LABEL="${TRACK:-session-$(printf %s "${CLAUDE_CODE_SESSION_ID:-$$}" | cut -c1-8)}"
```

Carry `$TRACK_LABEL` into the self-register call (below), `/context-check <label>`, and every spawn prompt's registry-write — all the same string. It plays no role in Claude's own team formation.

**Team formation is automatic — there is no creation step.** `TeamCreate`/`TeamDelete` no longer exist in current Claude Code (removed entirely, not merely unavailable on some builds). The instant the lead issues an `Agent` spawn carrying a `name`, that spawn becomes a real teammate joining the session's one implicit team — no separate call is needed. **Only the lead can do this** — a teammate spawning its own `Agent` call always produces a background subagent, never a further teammate (no nested teams).

**Self-register for context monitoring** so `/context-check` includes the lead (and the status line writes your heartbeat):

```bash
~/.claude/scripts/team-register.sh "<track>-team-lead" lead "$TRACK_LABEL" "" "<track>"
```

This + the spawn-prompt registry-write (Step 3) scopes heartbeat monitoring to team-mode sessions only — solo sessions never register, so they're never monitored. (`team-register.sh` installs once to `~/.claude/scripts/`, alongside `check-team-context.sh`.)

## Step 2 — Read current state (focused, not shallow)

The lead must know the active arc well enough to cycle sessions when teammates hit context — but not so deeply it accumulates plan/code context. Read in this order:

1. **`IMPLEMENTATION_PLAN.md`** — focused sections:
   - **"Currently in progress"** + **"Next session target"** (top)
   - **The active phase within this track's phase set** (0–12 (phase) / N.x (task) prefix) — task IDs + one-line topics. (Single-track plan → the active phase globally.)
   - **The next 1-2 phases in this track** — IDs + topics only (skim, don't deep-read)
   - **The Track map's integration/merge order** (multi-track only) — so you know which upstream tracks must merge before this one integrates
   - **"Carry-forward to upcoming briefs"** — what's pending
   - **Last 5 round entries** — tail `docs/archive/IMPLEMENTATION_LOG.md` (the plan's `## Log` is only a pointer stub); chronological context
2. **The most recent `docs/sessions/<NNN>-*.md`** — what just landed (skim summary + open follow-ups).
3. **`git log --oneline -5`** — last 5 commits to anchor your state pointer.
4. **If this team is resuming from a paused state:** read the most recent `docs/team-handoffs/<NNN>-*.md` — it carries the team composition, active arc, and ready-to-use spawn prompts.

That's bounded: ~50-100 lines of task content + a short session-doc skim. **Do NOT load `ARCHITECTURE.md` or area `CLAUDE.md` deep content** — the orchestrator + implementer load those.

## Step 2.5 — Provision the track's worktree (multi-track only; skip if single-track)

Stand up the isolated checkout this track's team will live in, from the branch/path the Track map named (Step 0):

```bash
git worktree add ../SoW-build-<track> track/<track>   # or the base branch the Track map specifies
```

The team's orchestrator + implementer(s) operate **inside this worktree** — all their commits land on `track/<track>`, never the root checkout. The **shared root docs** (`IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`) are owned by the **integration checkout**, not your worktree — route any cross-doc edit there (see `docs/team-protocol.md` "Working tree → tracks + worktrees"). **Skip this step entirely** for a single-track / single-operator plan — that build runs in the repo's single working tree.

## Step 3 — Spawn the team (with templates)

> **Spawn TEAMMATES, not background agents.** Each teammate is spawned with the **`Agent` tool carrying `name: "<track>-<area>-role>"`** (plus `subagent_type` — `general-purpose` for the orchestrator/implementer, which need full edit/bash/write tools; never a read-only type like `Explore`/`Plan` for implementation roles). A **lead**-issued `Agent` spawn carrying a `name` is what makes it a **teammate session that joins the team** rather than a one-off background subagent. This only works from the lead: a teammate's own `Agent` spawns are always background subagents, never further teammates (no nested teams). The prose templates below are the agent's PROMPT (the `prompt` arg); `name`/`subagent_type` are the structured `Agent` params alongside it.

Spawn:
1. **Orchestrator teammate** — one per project. `Agent(subagent_type: "general-purpose", name: "<track>-<area>-orchestrator", prompt: <orchestrator template>)` (or `<area>-orchestrator` if solo team). It will run `/orchestrate-start` (reads briefing + state itself).
2. **First implementer teammate** — for the area the next task targets. `Agent(subagent_type: "general-purpose", name: "<track>-<area>-implementer", prompt: <implementer template>)` (or `<area>-implementer` if solo team). Charter it with `/session-start` in that area's cwd. Spawn additional area implementers later, only when that area's work begins.

### Orchestrator spawn prompt template

```
You are <track>-<area>-orchestrator on the System of Work Assistant agent team.
Track: <track>. Track label: <track-label>. Worktree: <worktree-path> (branch `track/<track>`) — operate here; all commits land on this branch, never the root checkout. Route shared-root-doc edits (IMPLEMENTATION_PLAN.md / ARCHITECTURE.md) to the integration checkout. (Single-track build: omit the worktree line; work in the repo root.)
Confirm sender prefix before any peer send (a mismatch is a same-team naming mistake, not cross-track bleed — that's structurally impossible).
Activated because: <one line — chat-only context the start command can't derive; e.g. "Option D approval flow approved; next slice = <task ID>". Skip if none.>

FIRST ACTION — register for context monitoring:
  ~/.claude/scripts/team-register.sh "<track>-<area>-orchestrator" orchestrator "<track-label>" "" "<track>" "track/<track>"

Then run /orchestrate-start. NOT /session-start (that's the implementer's).
Confirm in your first reply: (1) the start command you ran, (2) that the registry entry was written (run `ls ~/.claude/team-registry/${CLAUDE_CODE_SESSION_ID}.json`).
```

### Implementer spawn prompt template

```
You are <track>-<area>-implementer on the System of Work Assistant agent team.
Track: <track>. Track label: <track-label>. Working directory: <worktree-path>/<area>/ — the track's worktree (single-track build → just `<area>/` in the repo root). All your commits land on branch `track/<track>`, never the root checkout. Talk only to <track>-<area>-orchestrator; a DM from another prefix would be a same-team naming mistake, not cross-track bleed (structurally impossible — each track is its own session-scoped team).
Activated because: <one line — chat-only context; e.g. "picking up <task ID>; brief authored at docs/briefs/NNN-...">. Skip if none.
Brief: <docs/briefs/NNN-*.md path if authored, else "the orchestrator is drafting now">.

FIRST ACTION — register for context monitoring:
  ~/.claude/scripts/team-register.sh "<track>-<area>-implementer" implementer "<track-label>" "<area>" "<track>" "track/<track>"

Then run /session-start. NOT /orchestrate-start.
Confirm in your first reply: (1) the start command you ran, (2) that the registry entry was written.
```

### Spawn invariants — non-negotiable

- **`name` on EVERY spawn, issued by the lead — the load-bearing invariant.** A spawn missing `name`, or issued by anything other than the lead (a teammate spawning its own `Agent` call), is a **background subagent, not a teammate session** (no nested teams). If `/team-start` produced background agents, check that the spawn came from the lead itself and carried a `name`.
- **WHY + WHERE only.** Skip file lists, slice decomposition, design Qs — the orch authors briefs against the codebase, the impl reads the brief.
- **Track prefix in the agent `name:`** if your track is set. Load-bearing for numbered-doc collision prevention + transcript legibility.
- **Worktree-rooted cwd is mandatory** for a multi-track build — every teammate's `git` operations stay inside `<worktree-path>` on `track/<track>`. A commit on the root checkout (or another track's area) from a track team is cross-track contamination — the filesystem analogue of channel-bleed.
- **Registry-write is mandatory** as the teammate's first action. Without it, `/context-check` can't see the teammate (no auto-cycle protection). Sub in the actual `$TRACK_LABEL` (Step 1 — the track name, or `session-<first-8>` for a single-track build) and the teammate's `<name>` before pasting the prompt.
- **The command pair is fixed**: orch runs `/orchestrate-start` (NEVER `/session-start`); impl runs `/session-start` (NEVER `/orchestrate-start`). Crossed commands are a known footgun.
- **Comm protocol is in root `CLAUDE.md`** — every teammate loads it; don't restate the escalation taxonomy / messaging budget / no-awareness-pings in the spawn prompt. The templates above already point at it implicitly.

## Step 4 — Verify after spawn

For each spawned teammate, **read its first reply** and confirm:
1. It ran the correct start command (`/orchestrate-start` for orchestrator, `/session-start` for implementer).
2. Its name carries the correct prefix (`<track>-` if set, else `<area>-`).
3. **Its registry entry was written** — confirm via the teammate's read-back (it reports `~/.claude/team-registry/<session_id>.json` exists) OR directly check:
   ```bash
   ls ~/.claude/team-registry/ && /context-check <track-label>
   ```
   The teammate should appear in `/context-check` output. If it doesn't, the registry-write failed in the spawn prompt — re-run the registry-write command manually with the teammate's session_id.

If the read-back shows the wrong start command was run: have it run the correct one + re-orient before dispatching work. If the name is wrong: respawn with the correct name. **Don't assume the spawn prompt was followed.**

## Step 5 — Confirm with the human, then get out of the way

Report to the human: team composed (orchestrator + which implementer(s) + their names with prefixes), **this track's phase set + its worktree path/branch + its upstream-track dependencies (which tracks must merge before this one integrates)**, the first slice target, escalation rules in force, and confirm direction. Once confirmed, let the teammates run. **You persist across many orchestrator/implementer session cycles** (they cycle on context; you don't) — re-engage only for the close-out gate, an escalation (4 categories), or new direction from the human. Routine progress is **not** a reason to speak up; treat silence as the steady state.

## Cycle protocol (when a teammate hits context)

Per `docs/team-protocol.md` "Cycle protocol" — when an orch or impl hits context (~70-75%):
1. Confirm the outgoing teammate is at `/session-end`-closed or `/orchestrate-end`-closed state (gated on user-explicit go).
2. Re-read state pointers: `IMPLEMENTATION_PLAN.md` "Currently in progress" + most recent session doc + `git log -1 --oneline`.
3. Spawn the successor using the templates above, carrying the same track prefix + the one-line WHY for the cycle (typically "previous teammate cycled at ~XX%; arc continues; last commit `<hash>`").
4. Verify the successor's read-back.

Use `/team-end` when fully pausing the team (end of day / arc-complete / lead-cycle) — this command only stands the team up + cycles teammates.

## Forbidden in this command

The lead's full "what it does NOT do" list — no relaying routine traffic, no DM'ing implementers (directives go via the orch; only exception `shutdown_request`), no scope/design calls, no acking idle-notifications / awareness pings, no upward narration, stateless-between-events — is in `docs/team-protocol.md` "What the lead does NOT do" (loaded at Step 1). Command-specific here:

- **Writing briefs in the spawn prompt.** Spawn prompts are 5-10 lines of WHY + WHERE — the orch authors briefs against the codebase.
- **Crossed start commands.** Orch runs `/orchestrate-start`; impl runs `/session-start` — never the reverse.
