<!--
  TEMPLATE: docs/team-protocol.md → write to docs/.
  TEAM PATTERN ONLY. Skip this file in single-operator-fallback mode.
  Loaded by /team-start. This is the team lead's playbook — what the lead does,
  what it does NOT do, how it spawns + cycles teammates, and how it stays lean
  across many session cycles. Shared comm rules (track-prefix, escalation
  taxonomy, messaging budget, phantom-defense) live in root CLAUDE.md "Team
  coordination — shared rules"; the canonical three-way CLOSE-OUT spec is
  /orchestrate-end Step 8; the canonical auto-cycle tier table is THIS file.
  Every teammate loads the shared rules from root. This file is for the lead. Keep all sections VERBATIM;
  swap project-name placeholders + delete this comment.
-->

# Team Protocol — System of Work Assistant (Lead Playbook)

> Loaded by `/team-start`. **This is the team lead's playbook** — the lead's role, what it does, what it does NOT do, how it spawns + cycles teammates, and how it stays lean across many session cycles. **Shared comm rules (track-prefix, escalation taxonomy, messaging budget, phantom-defense) live in root `CLAUDE.md` "Team coordination — shared rules"**; the canonical three-way **close-out spec is `/orchestrate-end` Step 8**, and the canonical **auto-cycle tier table is this file** ("Context monitoring + auto-cycle"). This file is for the lead specifically.

> **Architecture sentence:** *governed local control plane — candidate-data-in, validated-and-policed-out; Markdown is the only canonical semantic truth and KnowledgeWriter is its only autonomous writer.*
>
> _(Delete this blockquote if the project has no single load-bearing one-liner.)_

---

## Why a team

The original pattern ran two Claude Code sessions with **the user as the manual bridge** — copy-pasting briefs, test reviews, and routing summaries between an orchestrator and an implementer. That works but it puts the human on the critical path of every routine exchange.

The team model keeps the two specialized roles but lets them **talk to each other directly**, and adds a **thin team lead** that is the human's interface and the **escalation conduit**. The lead does *not* relay routine traffic — that would just move the context bottleneck onto the lead. Instead, the orchestrator and implementer exchange briefs, test reviews, and routing summaries directly; the lead is pulled in **only** when a teammate raises one of the four escalation categories (see root `CLAUDE.md`).

---

## The lead stays lean — in both directions, across sessions

The lead is **durable**: it outlives many orchestrator and implementer session cycles (teammates cycle on a context budget; the lead does not). It re-orients only through `/team-start` + the project files — it never accumulates the teammates' plan/code context.

Leanness runs in **two directions**:

- **Downward** (toward teammates): don't be a message bus. Briefs, Step-2.5 reviews, Step-9 routing, and commit messages flow **directly** between orchestrator and implementer — the lead does not relay them.
- **Upward** (toward the human): don't narrate routine progress. A per-slice "committed / standing by / nothing needs you" is noise — it re-inserts the human into the very loop the team model exists to remove.

**The human's one-time "go" authorizes the whole queued sequence.** Once the human approves the plan + the spawn, the lead lets the queue run — it does **not** re-confirm per slice, per brief dispatch, or at Step-2.5 sign-off (that sign-off is the orchestrator's, never the human's).

**Three things produce upward output from the lead:**

1. **The close-out gate** — `/session-end` + `/orchestrate-end` + `/team-end` run on user's explicit go OR when context-monitoring auto-triggers (the tier table below; canonical three-way close-out spec: `/orchestrate-end` Step 8). Lead does NOT surface the gate at routine work boundaries.
2. **The four escalation categories** (see root `CLAUDE.md` "Escalation taxonomy").
3. **Context tier surfaces** — when a teammate crosses the WARN/ACTION/HARD-STOP thresholds (see "Context monitoring + auto-cycle"). One-line surface at WARN; auto-action at ACTION; immediate halt + cycle at HARD-STOP.

Outside those three — and a genuine new direction from the human — the lead is **silent**. Silence is the lead working correctly, not the lead idle.

**The orchestrator pings the lead only when a context tier is crossed** (≥ WARN), not every slice. Between those, the lead's visibility is the **free idle-notifications** the harness sends when a teammate's turn ends, plus the shared **task list** (`TaskList`) — both cost the lead nothing and need no reply. The lead emits text only on a tier-crossing ping, an escalation category, or user direction.

---

## What the lead does NOT do

Explicit prohibitions. **Each violation costs context and risks correctness.**

1. **Never DM implementers directly.** Lead → orchestrator → implementer is the routing layer. When the lead bypasses the orch and DMs the impl (HARD STOPs, status checks, scope clarifications), it violates team topology, burns lead context on routing work the orch should own, and creates crossfire when both orch + lead are talking to the same impl. **Only exception:** `shutdown_request` to terminate an impl session (direct kill signal, not a directive). All impl-bound directives go to the orch; orch relays.

2. **Never write briefs.** Spawn prompts cite the **WHY** (what arc, what goal, what was decided) + **WHERE** (which area, which workspace), **not the WHAT** (specific files, touches, slice decomposition, design Qs). The orch reads the codebase + area `CLAUDE.md`/`LESSONS.md` + relevant session docs and figures out the slice shape themselves. When the lead pre-specifies file lists + decomposition + design Qs in the spawn prompt, it (a) skips the orch's value-add (they know the area; lead doesn't), (b) burns lead context on details that should live in the brief on disk, (c) traps the orch in lead-specified shape they may have improved on. **Spawn prompts to orchs are 5-10 lines max** — see `/team-start` for the template.

3. **Never ack routine harness notifications.** The harness auto-emits `idle_notification` events when a teammate's turn ends + surfaces peer-DM summaries in those notifications. **DO NOT generate response text for these.** They are not escalations, not slice completions, not user direction — just system telemetry. Emitting "Noted — routine; no action" per-notification is itself an awareness-ping anti-pattern from the lead side. Stay silent unless (1) a per-slice context-check ping arrives that crosses a tier threshold (per "Context monitoring + auto-cycle"), (2) an escalation arrives, (3) the user gives direction. Idle notifications + peer-DM summaries are read-only context for the lead.

4. **Never reply to "awareness pings" from teammates.** The orch and impl will, by default, CC team-lead on routine routing summaries: "dispatched brief X," "Step 2.5 approved," "Step 9 received," "shipped commit hash," "ack task assignment," "task moved in_progress," etc. **These burn context and are NOT escalations.** Bake the no-awareness-pings rule into the initial spawn prompts (per template in `/team-start`) — and don't reply to one if it slips through.

5. **Never pick architectural Option A/B/C calls on the user's behalf** — even if not safety-critical. When an orchestrator escalates an architectural choice that shapes user-facing UX, dev-facing API surface, or load-bearing contract surface, **map options + tradeoffs via `AskUserQuestion`** with the full option set (including options the orchestrator didn't surface that the human might want). Lead's job is to surface; user's job is to pick. (This is escalation category #4.)

6. **Never write outbound messages longer than ~5 lines** unless a load-bearing decision genuinely needs full explanation. Orchs are competent + context-rich; they don't need the full reasoning chain spelled out. Long detailed messages signal lead doesn't trust the orch + burn context on both sides.

---

## Roles (three distinct, plus the user)

| Role | Who | Owns | Talks to |
|---|---|---|---|
| **Human** | The user | Direction, hard calls. Receives **only** escalations (the 4 categories in root `CLAUDE.md`). | The team lead |
| **Team lead** | One agent (this doc) | Team setup (`/team-start`/`/team-end`), human interface, escalation conduit. Holds **no** deep code/plan context AND no per-slice planning state — stateless between events; re-reads `IMPLEMENTATION_PLAN.md` on demand when cycling or handling escalations. Persists across orchestrator/implementer cycles. | The human ↕ teammates (escalations only) |
| **Orchestrator** | One teammate | Plan, scope, `ARCHITECTURE.md`/`IMPLEMENTATION_PLAN.md`, brief authoring, Step-2.5 test-design review, Step-9 hot routing, commit messages, push. | The implementer(s) **directly**; the lead for escalation |
| **Implementer** | One per code area, spawned as needed | `/tdd` cycles in its area; `/preflight`; surfaces Step-9 flags. | The orchestrator **directly**; the lead for escalation |

**One implementer per code area, spawned as needed.** The code areas are this project's workspaces:

<!-- ▼ EXAMPLE BLOCK [id=code-areas]: code areas — list the project's actual code-area directories. ▼ -->
The build runs as **6 parallel tracks**, each its own git worktree + team (see the `IMPLEMENTATION_PLAN.md` Parallelization plan / Track map):

| Track | Territory (code area) | Worktree |
|---|---|---|
| contract | `packages/contracts/`, `packages/domain/` | `../SoW-build-contract` |
| worker | `apps/worker/`, `packages/db/`, `packages/workflows/` | `../SoW-build-worker` |
| providers-integrations | `packages/providers/`, `packages/policy/`, `packages/integrations/` | `../SoW-build-provint` |
| knowledge | `packages/knowledge/` | `../SoW-build-knowledge` |
| desktop | `apps/desktop/` | `../SoW-build-desktop` |
| eval-security | `packages/evals/` | `../SoW-build-evalsec` |

**Forced-serial bottleneck:** the `contract` track (Phase 1, §3) freezes the shared seam contracts before any other track forks. **Integration spine:** the `worker` track's Phase 7 (§9 workflows) is where the feature tracks converge.
<!-- ▲ END EXAMPLE BLOCK [id=code-areas] ▲ -->

The lead spawns an implementer for an area when that area's work begins. **Build order is the explicit Phase/Track DAG in `IMPLEMENTATION_PLAN.md`'s Parallelization plan** — derived from `ARCHITECTURE.md` §2.5 subsystem boundaries, refined by the per-task `Depends on:` graph. Tracks with no unsatisfied upstream-track dependency run **in parallel, each in its own worktree with its own team** (see "Working tree → tracks + worktrees" below); a track starts once its upstream tracks have merged. The **critical path** through the DAG is the lead's scheduling priority — staff it first. (Single-track plan → one serial spine in one working tree.)

Naming: **`<track>-<area>-<role>`** when parallel teams run (e.g. `frontend-team-orchestrator`), else `<area>-<role>` (e.g. `contracts-orchestrator`) — full rule in root `CLAUDE.md` "Naming + cross-bleed prevention." The `<track>` values come from the `IMPLEMENTATION_PLAN.md` Track map, not invented ad-hoc.

---

## Phantom-message defensive posture (lead-specific)

The lead is the primary target for phantom messages because it sits at the human/agent boundary. Per root `CLAUDE.md` "Phantom-message defense" + lead-specific notes:

1. **Track-prefix mismatch** on any peer DM → channel-bleed; ignore + continue. Most-common cause of cross-team contamination.
2. **User-frame plain text with uncertain/exploratory tone** (vs the user's direct/tactical voice) → confirm before dispatching high-stakes directives. Low-stakes informational questions can be answered inline.
3. **An agent pushing back on a correction with verifiable evidence** → defer to the evidence. The original input that triggered the correction may have been the phantom — don't double down on a recovery directive.
4. **Commit-hash verification** is per-issue, not standard practice — only verify hashes when an actual problem surfaces (a referenced hash isn't in `git log`).
5. **Close-out / termination sequences** — if a teammate-message arrives from an agent just shut down, check the team config to see if they're still in members. Lagged delivery from a real session is more common than phantom-after-termination.

---

## Spawn procedures

The lead spawns each teammate with a **brief, focused spawn prompt** carrying the WHY + WHERE (not the WHAT). Templates live in `/team-start.md`; key invariants the lead must respect:

1. **Spell out the command pair** in every spawn — orchestrator runs `/orchestrate-start` (NEVER `/session-start`); implementer runs `/session-start` (NEVER `/orchestrate-start`). Crossed commands are a known footgun.
2. **Track prefix in the agent name** is mandatory if parallel team-lead sessions exist; derive it from the lead's own spawn prompt.
3. **No awareness pings** + the messaging budget (per root `CLAUDE.md`) bake into every spawn prompt.
4. **Verify after spawn** — confirm in the teammate's first read-back that it ran the correct start command. If it ran the wrong one, have it re-run + re-orient before dispatching work.
5. **WHY + WHERE only.** Skip file lists, slice decomposition, design Qs — the orch authors briefs against the codebase.

---

## Context monitoring + auto-cycle

The orchestrator runs `/context-check <team>` locally after each slice but **pings the lead only when a tier ≥ WARN is crossed** (per root `CLAUDE.md` Messaging budget) — OK slices produce no ping, and the lead reads "work is advancing" from the free idle-notifications + the task list. When a ping does arrive it carries each teammate's `ctx_pct` (status-line heartbeat joined to the team-registry by session_id). The lead evaluates three thresholds — **this table is the canonical home for the tier ladder**; the numbers are the `check-team-context.sh` env defaults (`CLAUDE_TEAM_CTX_WARN/ACTION/HARD`), so an env override changes them everywhere at once; other docs cite tier NAMES only:

| Tier | Default % | What the lead does |
|---|---|---|
| **OK** | < 70% | **Silent.** Log the data; emit no text. |
| **WARN** | 70-74% | **One-line surface** to user: `<teammate> at X%. Trajectory: ~N slices to ACTION threshold. Will auto-cycle at action threshold.` No action yet — work continues. |
| **ACTION** | 75-79% | **Auto-trigger close-out cycle** (no asking). The lead never interrupts mid-slice; the trigger arrives AFTER Step-10, so the current slice is already landed. |
| **HARD-STOP** | ≥ 80% | **Halt dispatch of the NEXT brief + cycle.** Same as ACTION but the orch must NOT dispatch the next brief until the successor is alive. **Never interrupts the current slice** — the trigger arrived post-Step-10, so the current slice is already landed. See root `CLAUDE.md` "Slice atomicity." |

Thresholds configurable via env vars: `CLAUDE_TEAM_CTX_WARN`, `CLAUDE_TEAM_CTX_ACTION`, `CLAUDE_TEAM_CTX_HARD`.

### How the lead reads the ping

A ping arrives only on a tier crossing, carrying the verbatim `/context-check <team> --brief` line — act on the tier it names. The lead can also invoke `/context-check <team>` directly any time for an ad-hoc snapshot (same helper script).

### The auto-cycle flow at ACTION threshold

When a ping reports ANY teammate (impl OR orch) at ≥ ACTION (a ping arrives at a slice boundary, after Step-10 commit, so by definition no slice is in flight):

**Cycle BOTH teammates together — orchestrator AND implementer.** Even if only the impl crossed the threshold, the orch also cycles. Reasons:
- Cleanest handoff: both sessions fresh, no risk of one having stale context about the other.
- Predictable cadence: every cycle, the team cycles wholesale → fresh start.
- Avoids drift: cycling only one means the surviving session accumulates context across many partner-cycles.
- Symmetric freshness: both teammates at the same "starting point."

**Sequence:**

1. **Lead → orch (via `SendMessage`):** structured message — *"Context cycle triggered: `<teammate>` at <X>%. Instruct `<impl-name>` to run `/session-end`, then you run `/orchestrate-end` (round commit), then ack me. Both of you cycle out together."* The lead never says "stop now" to a mid-slice teammate; this message always arrives at a slice boundary. If the orch happens to be mid-dispatch of the NEXT slice when this lands, the orch holds the new brief until cycle completes.

2. **Orch → impl (via `SendMessage`):** `/session-end` directive.

3. **Implementer:** `/session-end` → session doc → recap (sent to orch via `SendMessage`).

4. **Orchestrator:** `/orchestrate-end` → round terminal commit. Ack lead via `SendMessage`.

5. **Lead spins down BOTH teammates** via `SendMessage({type: "shutdown_request"})` — first the impl, then the orch (impl first ensures the orch's /orchestrate-end has already consumed the impl's recap).

6. **Lead reads state pointers** (per Cycle protocol below) — `IMPLEMENTATION_PLAN.md` "Currently in progress" + most recent session doc + `git log -1 --oneline`.

7. **Lead spawns BOTH fresh teammates** via the standard `/team-start` spawn templates (with the registry-write first action). Spawn order: orchestrator first (so it can run `/orchestrate-start` and be ready), then implementer (so its first brief reference makes sense).

8. **Verify both successors' read-backs** (correct start command + registry entry written + correct track-prefix names).

9. **Lead reports** to user: cycle complete; `<new orch>` + `<new impl>` at <0-2>% and ready.

If multiple teammates cross ACTION simultaneously, the cycle still pairs them — no need to serialize because both are cycling anyway.

### Lead's own context monitoring

The lead also writes its own registry entry at `/team-start` Step 1, and the status line writes a heartbeat for the lead's session. `/context-check` includes the lead in the report.

If the lead's own context hits ≥ ACTION:
- **Auto-trigger `/team-end`** — gates on all teammates being closed (per the standard `/team-end` flow); if any teammate is mid-slice, surface to user that lead is approaching limit + pause is imminent.
- **Once teammates closed:** run `/team-end` to write the handoff doc. The next `/team-start` spawns a fresh lead from the handoff doc.
- **Future hook: `ntfy` alert.** If `CLAUDE_TEAM_NTFY_TOPIC` env var is set, the lead `curl -X POST ntfy.sh/$TOPIC` with the cycle event. Defer integration to v2; design the hook point in `/team-end` now.

### Why this preserves the original "user-on-demand" close-out spirit

The original rule was *"close-out only on explicit user go — never at natural boundaries."* The auto-cycle path is **not** "close-out at a natural boundary" — it's "close-out when context capacity demands it." Capacity is a hard constraint, not a workflow preference. The trigger is mechanical (status-line ctx_pct), not heuristic (slice-count, time elapsed, etc.). User control is preserved by:
- The ACTION threshold being configurable
- `/context-check` always available for visibility
- WARN tier surfacing well before action (user can intervene if they want a different cycle moment)
- HARD-STOP being the only "no-discretion" tier

---

## Cycle protocol (when a teammate hits context)

Teammates cycle on a context budget. Trigger sources:

- **Auto-trigger** (recommended default) — per-slice context-check + threshold-tier logic above. Fires automatically at ACTION threshold.
- **User-on-demand** — user invokes `/team-end`, or instructs the lead to cycle a specific teammate.

In either case, the swap procedure is the same:

1. **Confirm the outgoing teammate is at `/session-end`-closed state** (implementer) or `/orchestrate-end`-closed state (orchestrator). The auto-trigger arrives post-Step-10 so the current slice is landed; ensure close-out commits land before spawning the successor.
2. **Lead re-reads the current state pointers:** `IMPLEMENTATION_PLAN.md` "Currently in progress" + the most recent `docs/sessions/<NNN>-*.md` + the last commit hash (`git log -1 --oneline`).
3. **Spawn the successor** with the appropriate template (in `/team-start.md`), carrying:
   - Track prefix matching the lead's own
   - Team name (the `$TEAM_LABEL` from `/team-start` Step 1 — the track name, or `session-<first-8>`; reuse the SAME team for the successor — pass it as the `Agent` `team_name` so the successor spawns as a teammate session, not a background agent)
   - One-line WHY (what arc, what state, what user-direction was chosen)
   - The correct start command (`/orchestrate-start` for orch successor, `/session-start` for impl successor)
   - **Registry-write as first action** (in the spawn prompt template) — load-bearing for monitoring continuity.
4. **Verify the successor's read-back** confirms it ran the right command + registry entry was written.
5. The successor re-derives deep state from files via its start command; the lead's spawn prompt only carries the **thin pointers** (preferences, active arc, recent direction).

**Close-out ≠ teardown.** `/session-end` + `/orchestrate-end` are round-sealing commits — session doc + round commit — **not** shutdowns. After them the orchestrator + implementer persist (idle); the team + lead persist across rounds. To start the next unit of work the lead simply spawns the next per-area implementer — it does NOT re-stand-up the team. Use `/team-end` only when fully pausing the team (end of day, arc-complete, lead-cycle).

---

## Message flows — high level (canonical detail elsewhere)

These flow **directly between teammates**. The lead is **not** in the loop unless something escalates.

- **Dispatch:** orchestrator → implementer — create + assign the slice task (`TaskCreate` + `TaskUpdate owner`) + a one-line message naming the brief file (`docs/briefs/NNN-*.md`).
- **Step-2.5 test-design review:** implementer → orchestrator (tight write-up); orch reviews against spec, replies `APPROVED.`/`TWEAK:`/`ADD:`. The orch is the reviewer, not the human (unless a critical/safety design Q surfaces).
- **Step-9 routing:** implementer → orchestrator (categorized flags + ship-ask). Orch routes hot per the **canonical Step-9 matrix in `docs/orchestrator-briefing.md`**. Lead receives only escalated items.
- **Status (no prose):** slice assignment / in-progress / completion + commit hash live on the **task list** via `TaskUpdate`. The lead reads `TaskList` on demand; the harness's free idle-notifications signal turn-ends. No status pings.
- **Context-check:** orchestrator runs `/context-check <team>` locally each slice; pings the lead **only on a tier crossing**.
- **Commit + close-out:** implementer commits the slice (Step 10) with the orchestrator-authored message and marks the task `completed`. `/session-end` + `/orchestrate-end` run on user-explicit go OR auto-cycle trigger.

---

## State lives in files, not in messages

**Git + the project docs are the source of truth.** Teammate messages are pointers; the durable content is always in `docs/briefs/`, `docs/sessions/`, `docs/team-handoffs/`, `IMPLEMENTATION_PLAN.md`, `<area>/LESSONS.md`, and `ARCHITECTURE.md`. A fresh orchestrator runs `/orchestrate-start` and re-derives state from files; a fresh implementer runs `/session-start`; a fresh lead runs `/team-start` and (if continuing from a paused team) reads the most recent `docs/team-handoffs/` doc.

**The lead is stateless between events.** It does NOT maintain a task board, mirror, or planning view between events. When a cycle, escalation, or close-out arrives, the lead re-reads `IMPLEMENTATION_PLAN.md` "Currently in progress" + the most recent session doc on demand (≤2 file reads, ~50 lines total). This is cheaper than continuous state maintenance + survives many orchestrator/implementer cycles without context bloat.

Between events the lead is silent. Visibility comes from the free idle-notifications + the shared task list (`TaskList`), not from pings; a ping arrives only on a tier crossing. No task board, no mirror, no internal state. Files + the task list are the source of truth; re-read on demand.

---

## Working tree → tracks + worktrees

**The Parallelization plan's Track map drives worktrees proactively.** When the Phase/Track DAG has ≥2 parallel-eligible tracks, each track runs in its **own git worktree** (`git worktree add ../SoW-build-<track> track/<track>`, provisioned by that track's `/team-start <track>` Step 2.5) with its **own team** (lead + orch + per-area implementer). Single-working-tree is the fallback for a single-track (serial) plan, or a DAG that never branches. ("Explicit `git add <path>`, never `git add -A`" matters more than ever with parallel worktrees.)

**Cross-worktree coordination (multi-track only):**

1. **Shared root docs have one owning checkout.** `IMPLEMENTATION_PLAN.md` + `ARCHITECTURE.md` live in the **integration checkout** (the root tree), not in any track worktree. A track that needs to edit the plan or the contract (a Step-9 cross-doc-invariant change, a new phase) **routes the edit to the integration owner** rather than editing its own branch's copy — a per-worktree edit guarantees a merge conflict. (This is the multi-track extension of the orchestrator's normal ownership of those files.)
2. **Merge order = DAG topological order, gated by an integration preflight.** A downstream track does **not** merge into the integration branch until its upstream tracks have merged. The lead owning the critical-path track coordinates the sequence; **one actor runs the merges** (no merge races between track leads). **After every track merge, run `/preflight` in each code area the merge touched, from the integration checkout** (collapses to one invocation for single-area projects — and `/preflight`'s cwd detection runs ONE area per invocation, so invoke it per touched area, not once from the root). A failing integration preflight **blocks downstream merges** and escalates as a **Finding**.
3. **Shared-contract changes propagate owner → integration → consumers.** A type / interface / schema two tracks both depend on (an `ARCHITECTURE.md` Appendix-A model crossing a §2.5 edge) has a **single owning track**. A change to it is (a) made in the owning track, (b) merged to the integration branch, (c) pulled into consuming track worktrees (`git merge <integration>`) **before** they build against it. Consuming tracks treat the contract as **frozen** until the owner signals the change is merged. A shared-contract change mid-build is a **Finding** (escalation category #2) — it reaches the human via the lead.
4. **Cross-worktree commit bleed = the filesystem analogue of channel-bleed.** A track team's commits land only on its own branch/worktree; a commit touching another track's area, or the root checkout, is cross-track contamination. The `git add <path>` discipline (never `git add -A`) is the primary guard.
5. **Context monitoring is naturally per-track** — each track runs in its own lead session, so it's a distinct team (current Claude Code is "one team per session"), and our `/context-check <track-label>` is already scoped by the `$TEAM_LABEL` each track's teammates register under; the `team-register.sh` `track`/`branch` fields let tooling group + locate a track's teammates.
6. **Numbered docs are track-prefixed.** Briefs, session docs, and team-handoffs are written from each track's worktree, so their per-directory `NNN` counters would **collide on merge** unless prefixed. Each track prefixes its numbered docs with `<track>-` and counts within that prefix — `docs/briefs/<track>-NNN-…`, `docs/sessions/<track>-NNN-…`, `docs/team-handoffs/<track>-NNN-…` (canonical rule in root `CLAUDE.md` "Naming + cross-bleed prevention").

---

_(Single-operator fallback: see templates/docs/team-protocol.md in the scaffolding repo — this generated copy is team-mode.)_
