---
description: Team lead — close-out the team session; write handoff doc; surface what's next (user-on-demand OR auto-cycle when lead's own context hits threshold).
allowed-tools: Read, Edit, Write, Bash, AskUserQuestion
argument-hint: "<short topic>"
---

<!--
  TEMPLATE NOTE (delete when generating):
  TEAM PATTERN ONLY. Skip generating this file in single-operator-fallback mode.
  Highly portable — fill placeholders + the handoff template; keep procedures
  + gate conditions VERBATIM.
-->

> **Role guard — TEAM LEAD only.** `/team-end` is the lead's pause-the-team close-out. Not the same as `/orchestrate-end` (orchestrator's round close-out) or `/session-end` (implementer's session close-out). Those run per-session; this runs when the team is **fully pausing** (end of day, arc-complete, lead-cycle, mode-swap to solo). Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to have been set when this team was started (see `/team-start`'s prerequisite check) — without it there was never a live team to close out.

Argument: `$ARGUMENTS` — short topic for the handoff doc filename (e.g. `eod-YYYY-MM-DD`, `arc-X-complete`).

**When to invoke:**
- **End of day / weekend** — preserving coordination state so tomorrow's `/team-start` resumes cleanly.
- **Arc complete** — a major milestone landed (phase done, demo green, deploy successful); want a clean handoff doc.
- **Lead context approaching limit** — the lead itself needs to cycle (rare but possible).
- **Solo-mode swap** — dropping the team to continue solo, or formal pause before swap.

**When NOT to invoke:**
- Per slice / per task / per phase / per round — the close-out gate is `/session-end` + `/orchestrate-end`, not this.
- Mid-arc — `/team-end` is for **pausing**, not for natural work boundaries.

## Step 0 — Confirm the trigger (two legitimate goes)

`/team-end` runs on **either** close-out trigger (root `CLAUDE.md` "Close-out gating"):

1. **User-on-demand** — the user explicitly signaled the pause. Keep the explicit-go gate: if the user didn't signal it and trigger 2 doesn't hold, stop and surface the question instead.
2. **Auto-cycle** — the mechanical trigger **is** the go: your own (the lead's) `ctx_pct` ≥ ACTION on canonical `/context-check` output, or a full-team cycle that requires lead teardown. Verify the tier from the script output (never self-reported), proceed, and **notify the user** with one line (trigger + handoff-doc path) — a notification, not a blocking question. Waiting for a confirmation here deadlocks the close-out at exactly the moment the lead's context is scarcest.

Reaching this command at a natural work boundary (end of phase / arc / round) with **neither** trigger present is NOT a go — that's the auto-pause the Forbidden section bans. Step 1's all-teammates-closed gate applies on both triggers, unchanged.

## Step 1 — Gate: all teammates at closed state

Before writing anything:

1. **Every implementer must be `/session-end`-closed.** Confirm by checking for an in-flight slice — if any implementer is mid-`/tdd`, mid-Step-2.5, or mid-anything, **STOP**. Surface to the user; ask whether to (a) wait for the slice to land + `/session-end`, or (b) abort the close-out.
2. **The orchestrator must be `/orchestrate-end`-closed** for the round. Check `git log --oneline -1` — the most recent commit should be the round terminal commit (typically `docs(tasks): ...`). If a slice commit is the tip, the round isn't sealed — STOP + surface.

Do NOT proceed to Step 2 until both gates pass. **Never tear down mid-work.**

## Step 2 — Read current state pointers

Read for the handoff doc:
1. `git log --oneline -5` — last 5 commits, includes the round-seal hash.
2. `IMPLEMENTATION_PLAN.md` "Currently in progress" + "Next session target" + "Carry-forward to upcoming briefs"; plus the last round entry in `docs/archive/IMPLEMENTATION_LOG.md` (the plan's `## Log` is only a pointer stub).
3. The most recent `docs/sessions/<NNN>-*.md` — what just landed.
You already hold the rest of the coordination state (team composition, active arc, open decisions) from the task list, tier-crossing pings, and escalations during the team's life; re-read `IMPLEMENTATION_PLAN.md` if unsure.

## Step 3 — Compute the handoff doc number

```bash
ls docs/team-handoffs/ 2>/dev/null | head -20
```

Take the highest numeric prefix + 1, zero-pad to 3 digits. If the `docs/team-handoffs/` directory doesn't exist yet, create it + start at `001`. Filename: `<NNN>-<YYYY-MM-DD>-<topic>.md` per `$ARGUMENTS`. **Multi-track mode (this lead carries a `<track>`): prefix the filename with the track** — `<track>-<NNN>-<YYYY-MM-DD>-<topic>.md` — and compute `<NNN>` within the track (`ls docs/team-handoffs/<track>-*`), so parallel tracks' handoffs don't collide when the track branches merge (root `CLAUDE.md` "Naming + numbered-doc collision prevention"). Single-track / solo → plain `<NNN>-…`.

## Step 4 — Write the handoff doc

```markdown
# Team Handoff <NNN> — <topic>

**Date:** YYYY-MM-DD
**Track:** <track from /team-start, or "solo">
**Worktree:** <`../SoW-build-<track>` (branch `track/<track>`), or "root checkout (single-track)">
**Predecessor handoff:** <docs/team-handoffs/NNN-1-...md if any, else "first handoff">
**Successor handoff:** _(filled in when the next /team-end runs)_
**Round-seal commit at handoff:** `<commit hash from git log>`

## Why this handoff exists
<one sentence: end-of-day / arc-complete / lead-cycle / mode-swap>

## Team composition at close
- Lead: this session (track `<track>`)
- Orchestrator: `<track>-<area>-orchestrator` — last session ID + last commit
- Implementer(s): `<track>-<area>-implementer` for each spawned area — last session ID + last commit
- All teammates `/session-end` + `/orchestrate-end` closed at: <round-seal commit>

## Active arc + where it landed
<2-3 sentences: what arc the team was on, what landed in the closing round, what's the next planned slice>

## In-flight at close (should be empty)
<list anything started-but-not-closed, OR "None — clean close">

## Carry-forward to next team session
- `IMPLEMENTATION_PLAN.md` "Currently in progress": <quote>
- `IMPLEMENTATION_PLAN.md` "Next session target": <quote>
- Open Carry-forward items: <bullet list, or pointer to IMPLEMENTATION_PLAN.md section>

## Open decisions / blockers for the human
<bullet list — load-bearing architectural calls pending, deferment approvals pending, deploy/env questions, etc. Empty if none.>

## Spawn prompts ready for the next team session
**Orchestrator:**
```
<filled-in template from /team-start with the right track + activated-because line>
```

**Implementer (`<area>`):**
```
<filled-in template from /team-start with the right track + activated-because line>
```

## How to resume
Next team session: lead runs `/team-start <track>`, reads this handoff doc + `IMPLEMENTATION_PLAN.md` "Currently in progress" on demand, spawns teammates using the prompts above, verifies read-backs. No re-orient overhead — this doc IS the orient.
```

## Step 5 — Update IMPLEMENTATION_PLAN.md

**REPLACE** (don't append to) the `Currently in progress` snapshot with the pause marker, keeping it within the ≤3-item / ≤15-line cap:

```markdown
- **Team paused at <YYYY-MM-DD>** — handoff doc: `docs/team-handoffs/<NNN>-<date>-<topic>.md` · last round-seal: `<commit hash>` · next-slice target: <task ID or "TBD per handoff">
```

## Step 6 — Commit

Stage explicitly:
```bash
git add docs/team-handoffs/<NNN>-<date>-<topic>.md IMPLEMENTATION_PLAN.md
git status --short    # verify only handoff doc + IMPLEMENTATION_PLAN.md staged
```

Conventional Commits + AI trailer (HEREDOC):
```bash
git commit -m "$(cat <<'EOF'
chore(team): handoff <NNN> — <topic>

<one-paragraph body: why the team is pausing, what landed in the closing round,
where the next session resumes from. Reference the predecessor handoff if any.>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

If a predecessor handoff exists, also update its "Successor handoff" link to point at this one — same commit.

**Do NOT push** unless a remote is configured + the user explicitly approves.

## Step 6.5 — Clean up team-registry entries

Remove this team's registry entries so `/context-check` no longer reports them as live (heartbeats would also age out via the 10-minute staleness filter, but explicit cleanup is cleaner):

This cleans up **our custom monitoring layer only**. The Claude Code team itself (`~/.claude/teams/session-<first-8>/`) is auto-removed when your session exits — don't touch it. Match on the **track label** every teammate registered under at `/team-start` (the `$TRACK_LABEL` — track name, or `session-<first-8>`); that one filter catches the lead + every teammate, so no separate official-config read is needed:

```bash
TRACK="<the $TRACK_LABEL used at /team-start>"
# Remove each registry entry (and its heartbeat) registered under this label.
for f in "$HOME/.claude/team-registry"/*.json; do
  [ -f "$f" ] || continue
  if [ "$(jq -r '.track_label // empty' "$f" 2>/dev/null)" = "$TRACK" ]; then
    sid=$(jq -r '.session_id // empty' "$f" 2>/dev/null)
    [ -n "$sid" ] && rm -f "$HOME/.claude/heartbeats/${sid}.json"
    rm -f "$f"
  fi
done
```

If a predecessor handoff is being resumed later, the next `/team-start` re-spawns teammates → fresh registry entries land via spawn prompts.

## Step 6.6 — Track worktree teardown + merge gate (multi-track only; skip if single-track)

If this team ran in a track worktree (provisioned by `/team-start <track>` Step 2.5):

1. **Merge gate.** If the track's phases are **complete** AND its upstream tracks have already merged, merge the track branch into the integration branch **in DAG topological order**, then run the **integration preflight** — `/preflight` per touched code area from the integration checkout — per `docs/team-protocol.md` "Working tree → tracks + worktrees" rule 2 (one actor runs the merges; never race track leads; a failing preflight blocks downstream merges and escalates as a Finding). If the track is only **pausing** (not done), do NOT merge — leave the branch for the next session. A merge that touches a **shared contract** is a **Finding** → surface to the human before merging.
2. **Worktree teardown.** Once the branch is merged (or the team is fully done with the worktree), remove it:
   ```bash
   git worktree remove ../SoW-build-<track>     # add --force ONLY after confirming no uncommitted work
   ```
   Leave the worktree in place if the team is merely pausing and will resume in it.


## Step 7 — Tell the user

Report:
- Handoff doc at `docs/team-handoffs/<NNN>-<date>-<topic>.md`.
- Team is paused; teammates are idle (already `/session-end`-closed at Step 1).
- Next `/team-start` resumes from this handoff doc.
- (Multi-track) the track's worktree was torn down + merged, or left in place if the team only paused.
- Any open decisions / blockers surfaced in the doc.

## Forbidden in this command

- **Running this without one of the two triggers** — user-explicit go, or the mechanical auto-cycle trigger verified from canonical `/context-check` output (root `CLAUDE.md` "Close-out gating"). A natural work boundary alone is neither.
- **Tearing down mid-work.** Step 1's gate is non-negotiable — on both triggers.
- **Auto-pausing at a natural boundary** (end of phase, end of arc, end of round) with neither trigger present. The user signals, or the context trigger fires; you act.
- **Blocking an auto-cycle close-out on a user confirmation.** Trigger 2 notifies; it does not ask.
- **Pushing without explicit approval.** Round-seal commits aren't pushed silently.
- **Skipping the spawn-prompt section** of the handoff doc. The prompts are the load-bearing handoff content — without them, the next `/team-start` has to re-derive coordination state from scratch.
