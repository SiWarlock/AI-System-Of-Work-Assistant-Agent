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

> ⛔⛔ **DORMANT AS OF 2026-08-29 — THIS PROJECT RUNS SOLO.** The owner's decision is that solo
> autonomous is the way forward; the agent-teams pattern is not in use. **Do not follow this file's
> role handoffs, messaging budget, or Step-9 routing-to-an-orchestrator as live instructions.**
> The live workflow is root `CLAUDE.md` "Solo autonomous operation — the live mode".
> ⭐ Kept intact, not deleted: it is the record of how the team pattern worked, and it is directly
> reusable if a team round is ever run again.


# Team Protocol — System of Work Assistant (Lead Playbook)

> Loaded by `/team-start`. **This is the team lead's playbook** — the lead's role, what it does, what it does NOT do, how it spawns + cycles teammates, and how it stays lean across many session cycles. **Shared comm rules (track-prefix, escalation taxonomy, messaging budget, phantom-defense) live in root `CLAUDE.md` "Team coordination — shared rules"**; the canonical three-way **close-out spec is `/orchestrate-end` Step 8**, and the canonical **auto-cycle tier table is this file** ("Context monitoring + auto-cycle"). This file is for the lead specifically.

> **Architecture sentence:** *governed local control plane — candidate-data-in, validated-and-policed-out; Markdown is the only canonical semantic truth and KnowledgeWriter is its only autonomous writer.*
>
> _(Delete this blockquote if the project has no single load-bearing one-liner.)_

> **Prerequisite:** Claude Code's agent-teams feature is experimental and OFF by default — it requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (set in `settings.json`'s `env` block or your shell environment). `/team-start` checks this before doing anything else; without it, none of this playbook engages and you fall back to "Single-operator fallback" below.

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

Naming: **`<track>-<area>-<role>`** when parallel teams run (e.g. `frontend-team-orchestrator`), else `<area>-<role>` (e.g. `contracts-orchestrator`) — full rule in root `CLAUDE.md` "Naming + numbered-doc collision prevention." The `<track>` values come from the `IMPLEMENTATION_PLAN.md` Track map, not invented ad-hoc.

---

## Phantom-message defensive posture (lead-specific)

The lead is the primary target for phantom messages because it sits at the human/agent boundary. Per root `CLAUDE.md` "Phantom-message defense" + lead-specific notes:

1. **Track-prefix mismatch** on any peer DM → a spawn-naming inconsistency within the lead's own team (not cross-team bleed, which can't happen — `SendMessage` only resolves within your own session-scoped team) — verify the sender rather than reflexively ignoring it.
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
6. ⛔ **A resume / handoff doc's spawn table MUST carry a disposition for ALL SIX code areas** — either *spawn now* or an explicit classification (*deliberately unqueued* · *no work this round* · *blocked on X*). **An OMITTED area is indistinguishable from a classified one.** ⭐ **The mechanism is the danger: once most rows carry an explicit disposition, a missing row reads as one more disposition rather than as a gap** — an absence promoted to an intent, contracts **L93** inverted. **This binds when WRITING a handoff (`/team-end`) as much as when reading one (`/team-start`)** — the writer is the only one positioned to notice.

> **The instance that earned this rule (2026-08-11).** Handoff `021` called itself *"the ONLY resume path"*; its Part-2 spawn table had **five** rows against root `CLAUDE.md`'s **six** areas, and the string `providers-integrations` **did not appear anywhere in the document**. Because `contract` and `eval-security` were classified there as *"deliberately unqueued, not overlooked,"* the fifth absence read as a fifth disposition — and a fresh lead repeated the omission verbatim into a new round. **Three tracked items sat in that area with no owner, one of them on a block-release path.** ⭐ **This is the "tracked work nobody is queued on" defect at AREA level, invisible to the same apparatus for the same reason: nothing enumerates the six areas and asks which have an owner.** The check is one line and nothing requires it — so require it here.

> ⭐⭐ **AND THE CHECK IS NOW RUNNABLE, WHICH IT WAS NOT WHEN THIS RULE WAS WRITTEN (task `### 24.94`, 2026-08-28).** The rule above says *"nothing enumerates the six areas and asks which have an owner"* — that was true because **26 of the then-open tasks declared no `Track:` at all**, so an enumeration had nothing to enumerate. Every open task now carries one (or an explicit `Track: NONE` with a reason, which is a real answer).
>
> **RUN IT at `/team-start` and at `/team-end`, and NAME THE RESIDUE:**
>
> 1. Group the tracker's OPEN tasks by `Track:`.
> 2. Put the six code areas — `contract` · `worker` · `providers-integrations` · `knowledge` · `desktop` · `eval-security` — against that grouping.
> 3. For each area, state *spawn now* / *deliberately unqueued* / *no open work* / *blocked on X*.
> 4. **State the `Track: NONE` bucket separately** — those are docs, protocol, audits and traps, and they have no implementer by design. ⛔ **Do not let them vanish into a total; an item with no area is not an item with no work.**
>
> ⚠ **A cross-area task appears under EVERY area it names, and that is deliberate** — `13.8` counts for four. **The count is of AREAS WITH WORK, never a task total**, and adding the rows will over-count on purpose.
>
> ⛔ **A task whose `Track:` reads `CROSS-AREA` is a SPLIT INSTRUCTION, not an assignment.** Producer-first, one implementer per area; never one implementer driving a vertical through four territories.


---

## Context monitoring + auto-cycle

The orchestrator runs `/context-check <track>` locally after each slice but **pings the lead only when a tier ≥ WARN is crossed** (per root `CLAUDE.md` Messaging budget) — OK slices produce no ping, and the lead reads "work is advancing" from the free idle-notifications + the task list. When a ping does arrive it carries each teammate's `ctx_pct` (status-line heartbeat joined to the team-registry by session_id). The lead evaluates three thresholds — **this table is the canonical home for the tier ladder**; the numbers are the `check-team-context.sh` env defaults (`CLAUDE_TEAM_CTX_WARN/ACTION/HARD`), so an env override changes them everywhere at once; other docs cite tier NAMES only:

| Tier | Default % | What the lead does |
|---|---|---|
| **OK** | < 70% | **Silent.** Log the data; emit no text. |
| **WARN** | 70-74% | **One-line surface** to user: `<teammate> at X%. Trajectory: ~N slices to ACTION threshold. Will auto-cycle at action threshold.` No action yet — work continues. |
| **ACTION** | 75-79% | **Auto-trigger close-out cycle** (no asking). The lead never interrupts mid-slice; the trigger arrives AFTER Step-10, so the current slice is already landed. |
| **HARD-STOP** | ≥ 80% | **Halt dispatch of the NEXT brief + cycle.** Same as ACTION but the orch must NOT dispatch the next brief until the successor is alive. **Never interrupts the current slice** — the trigger arrived post-Step-10, so the current slice is already landed. See root `CLAUDE.md` "Slice atomicity." |

Thresholds configurable via env vars: `CLAUDE_TEAM_CTX_WARN`, `CLAUDE_TEAM_CTX_ACTION`, `CLAUDE_TEAM_CTX_HARD`.

### How the lead reads the ping

A ping arrives only on a tier crossing, carrying the verbatim `/context-check <track> --brief` line — act on the tier it names. The lead can also invoke `/context-check <track>` directly any time for an ad-hoc snapshot (same helper script).

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
   - A `name` (the `Agent` param) issued by the lead — that alone is what makes it a teammate session, not `team_name` (accepted but ignored by the runtime) and not any team-creation step (none exists). The successor lands in the same session's one implicit team automatically, since the lead session persists across the cycle.
   - Track label (the `$TRACK_LABEL` from `/team-start` Step 1 — the track name, or `session-<first-8>`; this is our own context-monitoring bookkeeping, reused so the registry-write below groups with the outgoing teammate's entries)
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
- **Context-check:** orchestrator runs `/context-check <track>` locally each slice; pings the lead **only on a tier crossing**.
- **Commit + close-out:** implementer commits the slice (Step 10) with the orchestrator-authored message and marks the task `completed`. `/session-end` + `/orchestrate-end` run on user-explicit go OR auto-cycle trigger.

---

## State lives in files, not in messages

**Git + the project docs are the source of truth.** Teammate messages are pointers; the durable content is always in `docs/briefs/`, `docs/sessions/`, `docs/team-handoffs/`, `IMPLEMENTATION_PLAN.md`, `<area>/LESSONS.md`, and `ARCHITECTURE.md`. A fresh orchestrator runs `/orchestrate-start` and re-derives state from files; a fresh implementer runs `/session-start`; a fresh lead runs `/team-start` and (if continuing from a paused team) reads the most recent `docs/team-handoffs/` doc.

**The lead is stateless between events.** It does NOT maintain a task board, mirror, or planning view between events. When a cycle, escalation, or close-out arrives, the lead re-reads `IMPLEMENTATION_PLAN.md` "Currently in progress" + the most recent session doc on demand (≤2 file reads, ~50 lines total). This is cheaper than continuous state maintenance + survives many orchestrator/implementer cycles without context bloat.

Between events the lead is silent. Visibility comes from the free idle-notifications + the shared task list (`TaskList`), not from pings; a ping arrives only on a tier crossing. No task board, no mirror, no internal state. Files + the task list are the source of truth; re-read on demand.

---

## Working tree → tracks + worktrees

**The Parallelization plan's Track map drives worktrees proactively.** When the Phase/Track DAG has ≥2 parallel-eligible tracks, each track runs in its **own git worktree** (`git worktree add ../SoW-build-<track> track/<track>`, provisioned by that track's `/team-start <track>` Step 2.5) with its **own team** (lead + orch + per-area implementer). Single-working-tree is the fallback for a single-track (serial) plan, or a DAG that never branches. ("Explicit `git add <path>`, never `git add -A`" matters more than ever with parallel worktrees.)

⛔⛔ **A HOLD DEFERS THE COMMIT, NOT THE EFFECT — AND A PARKED RED MUST BE PUBLISHED (task `### 24.56`).**
In a SHARED tree, work that a ruling parks *uncommitted* is still **in the tree everyone else is
building on**. ⇒ ***"we held that commit" does not mean the tree is clean*** — the effect is live
for every session sharing the checkout, and only the COMMIT was deferred.

⭐ **THEREFORE: whenever a ruling parks work uncommitted, PUBLISH the known-red** — which suite,
which file, and that it is deliberate. A red nobody announced is indistinguishable from a
regression someone just caused, and the next person to run the suite will either waste a session
bisecting it or, worse, "fix" it back.

⚠ **This is the same class as the crossed-approval failure the magic-words rule addresses** (root
`CLAUDE.md`): both are cases where **the STATE a teammate is acting on is not the state that
exists**, and in both the cheap control is to say what you actually observed.

**Cross-worktree coordination (multi-track only):**

1. **Shared root docs have one owning checkout.** `IMPLEMENTATION_PLAN.md` + `ARCHITECTURE.md` live in the **integration checkout** (the root tree), not in any track worktree. A track that needs to edit the plan or the contract (a Step-9 cross-doc-invariant change, a new phase) **routes the edit to the integration owner** rather than editing its own branch's copy — a per-worktree edit guarantees a merge conflict. (This is the multi-track extension of the orchestrator's normal ownership of those files.)
2. **Merge order = DAG topological order, gated by an integration preflight.** A downstream track does **not** merge into the integration branch until its upstream tracks have merged. The lead owning the critical-path track coordinates the sequence; **one actor runs the merges** (no merge races between track leads). **After every track merge, run `/preflight` in each code area the merge touched, from the integration checkout** (collapses to one invocation for single-area projects — and `/preflight`'s cwd detection runs ONE area per invocation, so invoke it per touched area, not once from the root). A failing integration preflight **blocks downstream merges** and escalates as a **Finding**.
3. **Shared-contract changes propagate owner → integration → consumers.** A type / interface / schema two tracks both depend on (an `ARCHITECTURE.md` Appendix-A model crossing a §2.5 edge) has a **single owning track**. A change to it is (a) made in the owning track, (b) merged to the integration branch, (c) pulled into consuming track worktrees (`git merge <integration>`) **before** they build against it. Consuming tracks treat the contract as **frozen** until the owner signals the change is merged. A shared-contract change mid-build is a **Finding** (escalation category #2) — it reaches the human via the lead.
4. **Cross-worktree commit bleed = the filesystem analogue of channel-bleed.** A track team's commits land only on its own branch/worktree; a commit touching another track's area, or the root checkout, is cross-track contamination. The `git add <path>` discipline (never `git add -A`) is the primary guard.
5. **Context monitoring is naturally per-track** — each track runs in its own lead session, so it's a distinct, session-scoped Claude team (current Claude Code is "one team per session"), and our `/context-check <track-label>` is already scoped by the `$TRACK_LABEL` each track's teammates register under; the `team-register.sh` `track`/`branch` fields let tooling group + locate a track's teammates.
6. **Numbered docs are track-prefixed.** Briefs, session docs, and team-handoffs are written from each track's worktree, so their per-directory `NNN` counters would **collide on merge** unless prefixed. Each track prefixes its numbered docs with `<track>-` and counts within that prefix — `docs/briefs/<track>-NNN-…`, `docs/sessions/<track>-NNN-…`, `docs/team-handoffs/<track>-NNN-…` (canonical rule in root `CLAUDE.md` "Naming + numbered-doc collision prevention").

---

_(Single-operator fallback: see templates/docs/team-protocol.md in the scaffolding repo — this generated copy is team-mode.)_


---

# ARCHIVED — the root `CLAUDE.md` "Team coordination — shared rules" section

> ⛔ **MOVED HERE 2026-08-29, VERBATIM, because this project runs SOLO** (owner decision: solo
> autonomous is the way forward). It used to occupy **150 of root `CLAUDE.md`'s 374 lines — 40%** of
> the file every session loads, describing role handoffs that do not happen in the mode we run.
>
> ⭐ **WHY MOVED RATHER THAN DELETED:** it is the record of how the team pattern worked, and several
> rulings inside it were expensive to learn. **Nothing here was edited on the way in** — this is a
> byte-for-byte move, so a future team round can lift it straight back.
>
> ⛔⛔ **WHAT DID *NOT* MOVE — three rules were TRANSLATED into root `CLAUDE.md`'s
> "Solo autonomous operation" section rather than archived, because they are MODE-INDEPENDENT and
> archiving them would have silently retired live safety routing:**
>   1. the **four escalation categories** (what reaches the human) — now "what reaches the owner";
>   2. ⛔ **the ALL-SEVEN auto-route** — a flag touching any of the seven safety rules reaches the
>      owner, no judgment call at the boundary;
>   3. **route on KIND, never on reachability** — dormancy governs disposition, never whether an
>      item is reported.
> ⚠ **If you restore team mode, do NOT re-import those three from here — root `CLAUDE.md` holds the
> live copy and this one is a snapshot.** Two copies of a safety-routing rule is exactly the
> divergence `contracts L39` forbids.

## Team coordination — shared rules (all roles)

> Claude Code's native agent-teams feature is **experimental and OFF by default** — it requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (set in `settings.json`'s `env` block or your shell environment; takes effect on a fresh session). Without it, `/team-start` cannot spawn real teammates at all — see its prerequisite check. Everything below assumes the flag is set; unset, use the single-operator fallback instead.

Runs as a Claude agent team — a thin **team lead** (human interface, escalation conduit only, persists across cycles), an **orchestrator** (plan/scope/docs/Step-2.5 review/Step-9 routing/commits), and **one implementer per code area** (TDD cycles). Orchestrator ↔ implementer communicate **directly**; lead is pulled in only for escalations + the close-out gate.

| Role | cwd | Loads |
|---|---|---|
| Team lead | repo root (`SoW-build/`) | this file + `docs/team-protocol.md` (lead playbook only) |
| Orchestrator | repo root | this file + `docs/orchestrator-briefing.md` |
| Implementer — contract | `packages/contracts/` (owns `contracts`, `domain`) | this file + `packages/contracts/CLAUDE.md` |
| Implementer — worker | `apps/worker/` (owns `worker`, `db`, `workflows`) | this file + `apps/worker/CLAUDE.md` |
| Implementer — providers-integrations | `packages/providers/` (owns `providers`, `policy`, `integrations`) | this file + `packages/providers/CLAUDE.md` |
| Implementer — knowledge | `packages/knowledge/` | this file + `packages/knowledge/CLAUDE.md` |
| Implementer — desktop | `apps/desktop/` | this file + `apps/desktop/CLAUDE.md` |
| Implementer — eval-security | `packages/evals/` | this file + `packages/evals/CLAUDE.md` |

<!-- 6 code areas = 6 build tracks; each runs in its own worktree (see IMPLEMENTATION_PLAN.md Parallelization plan). -->

### Naming + numbered-doc collision prevention

**`<track>-<area>-<role>`** when multiple team-lead sessions run in parallel in the same repo (e.g. `frontend-team-orchestrator`, `backend-team-implementer`). Otherwise `<area>-<role>` (e.g. `contracts-orchestrator`). The lead announces its track on `/team-start`. **Track names are not invented ad-hoc — they come from the `IMPLEMENTATION_PLAN.md` Parallelization plan (Track map)** (one entry per parallel-eligible track on the Phase/Track DAG, derived from `ARCHITECTURE.md` §2.5 subsystem boundaries refined by the task dependency graph); the Track map is the authority for the set of valid `<track>` prefixes. Each parallel team-lead session has its own separate, session-scoped Claude team — `SendMessage` only resolves within your own team, so a DM from another track's session structurally cannot reach you. The prefix exists for numbered-doc filename collision prevention (below) and transcript legibility, not as a delivery-channel defense. Still confirm a recipient's exact name before any peer send — a typo addresses the wrong (real) teammate in your own team, not "another track."

**Numbered docs are track-prefixed too (multi-track only).** Each track works in its own git worktree on its own branch, so the per-directory `NNN` counters for briefs, session docs, and team-handoffs run **independently per track** and would **collide on merge** (two `001-…` files with different topics but the same number). So **when you carry a `<track>-` name prefix, prefix your numbered doc filenames with it** and compute the next `NNN` **within that prefix**:
> `docs/briefs/<track>-NNN-<task-id>-<topic>.md` · `docs/sessions/<track>-NNN-<date>-<topic>.md` · `docs/team-handoffs/<track>-NNN-<date>-<topic>.md` — next `NNN` = (max of `ls docs/<dir>/<track>-*`) + 1.

Single-track / single-operator builds keep the plain `NNN-…` form. Predecessor/successor links reference the full filename, so they stay correct across the prefix.

### Escalation taxonomy — what reaches the human (via the lead)

Four categories only. Everything else, orchestrator + implementer settle directly.

1. **Critical / safety design questions** — touching a safety rule below.
2. **Findings** — a discovered problem with material impact (spec/code contradiction, security issue, invariant at risk, broken premise, scope-threatening blocker).
3. **Deferment approvals** — any scope cut. Never silently drop work.
4. **Load-bearing architectural decisions** — Option A/B/C calls shaping UX, dev-facing API surface, or load-bearing contract surface. Lead maps options + tradeoffs via `AskUserQuestion`; does NOT pick on the user's behalf.

⛔⛔ **A Step-9 flag touching ANY OF THE SEVEN safety rules auto-routes to the LEAD as well as the orchestrator. ALL SEVEN. No exceptions, no judgment call at the boundary.** *(Lead ruling 2026-08-13, task `### 24.62`.)*

⛔⛔ **AND ROUTE ON KIND — REACHABILITY GOVERNS DISPOSITION, NEVER ROUTING.** *(Lead ruling 2026-08-13.)* ***"It's an arming precondition rather than a live breach" is a statement about TIMING, not about KIND.*** **A thing is a safety matter because of WHAT IT IS, not because of WHEN it becomes reachable.** ⇒ **an item routes on what it IS; its reachability determines what happens AFTER it arrives — fence vs fix-now, priority, owner-gate — never WHETHER it arrives.** ⭐ **The two are not exclusive: something can be an arming precondition AND a rule-4 flag, and the second is usually what makes the first load-bearing.**

> ⛔ **WHY THIS OUTRANKS THE INSTANCE THAT PRODUCED IT — it is the systematic form of the standing census re-derivation, shared-task-list `#43`.** That task records that `24.6`'s severity gradings rest on **reachability qualifiers** and that **only the SAFE direction has ever been sampled.**
> > ⚠ **CITATION CORRECTED 2026-08-13 (`### 24.66`) — THE RULING IS UNAFFECTED; ONLY THE POINTER WAS WRONG, AND IT MUST NOT BE RE-OPENED ON THAT BASIS.** This line previously cited `### 24.43`, which is the `lifecycle.test.ts` `DOMAIN_TABLES` task and **contains no reachability claim at all** (its own shared-list entry is `#29`). ⛔ **`#43` does make the claim, so the reasoning was sound throughout.** ⭐ **Why it mattered anyway: a reader following the citation to AUDIT this ruling landed on an unrelated stale-array task and would most likely conclude they had misread — so the bad pointer actively discouraged the check it exists to enable.** ⛔ **BINDING CONVENTION (lead-adopted 2026-08-13): `#NN` = the shared task list · `### 24.NN` = `IMPLEMENTATION_PLAN.md` · NEVER a bare number for either.** **Both namespaces start at 1, so a bare `43` resolves to two unrelated tasks** — Carry-forward `6(a0)(x)`'s class (*five ledgers each starting at §1*) in a new namespace, and this one had already reached a protocol document. ⇒ ***if "not yet reachable" also downgraded ROUTING, the entire class of latent-but-real safety items would never reach the lead at all — and the one direction nobody checks would become the one direction nobody is even TOLD about.*** **Two independent mechanisms, same blind spot, compounding.**
> ⭐ **Provenance: an implementer flagged the CLASSIFICATION rather than the content — noticing that a categorisation decision was itself load-bearing — and the orchestrator agreed it would have made the same call.** ⚠ **When two careful people independently make the same call and it is wrong, the RULE under-specified; no amount of care would have fixed it** (the `L141`-amendment shape, applied to routing).

> ⛔ **THIS CORRECTS A REAL DEFECT THAT GOVERNED THE WHOLE ROUND: spawn prompts said `rules 1/4/5/6`, and there is NO principled reason that set excluded 2, 3 or 7** — it was a prior convention mirrored rather than derived. **The lead filed it against themselves: *"the same substitute-a-model-for-a-check failure I've made four times today, except this one shipped as PROTOCOL."***
> ⚠ **How it surfaced: a rule-7 (redaction) finding — `persistDenialAudit` gating one of two data channels — had NO auto-route, so it reached the lead only because the implementer flagged it (*"your call, not mine to make silently"*) and the orchestrator then chose to route it.** ⇒ ***a secrets finding's escalation depended on two people in sequence making a good judgment call while not tired.***
> ⛔ **Rules 2 (candidate-data gate) and 3 (external-write envelope) sit in the IDENTICAL gap and nobody has hit them yet.** ⭐ **Fixed as a CLASS deliberately: patching only rule 7 — the one that happened to surface — would repeat the error ruled against on `### 24.54`, widening a declared set by exactly the amount the complaint demanded.**

### Messaging budget — two channels

Coordination uses two channels for two different things. Keep them separate:

- **Shared task list** (`TaskCreate` / `TaskUpdate` / `TaskList`) carries **status** — slice assignment, in-progress, completion, the commit hash (in task metadata). Per the agent-teams protocol, status / assignment / completion belong here, **never in a prose message**. The orchestrator and lead learn progress by reading `TaskList` plus the **free idle-notifications** the harness emits whenever a teammate's turn ends — so there are **no status pings**.
- **`SendMessage`** carries only the **interactive checkpoints** that must wake a teammate with content to act on. Bodies stay **terse** — point at the brief / test file / task for detail; the `summary` field is the human-facing preview (use it; don't pad the body for the human).

**Per-slice `SendMessage` sequence (the entire budget):**

1. **Dispatch** — orchestrator → implementer: create + assign the slice's task (`TaskCreate` + `TaskUpdate owner`) + one line naming the brief path. Wakes the impl.
2. **Step-2.5** — implementer → orchestrator: the tight test-design write-up (the review surface; format in `/tdd` Step 2.5). Wakes the orch; reply is `APPROVED.` / `TWEAK:` / `ADD:`.
3. **Step-9** — implementer → orchestrator: categorized flags + ship-ask. Wakes the orch; reply is commit-message-first.
4. **done** — implementer: after the Step-10 commit, `TaskUpdate` the slice task to `completed` (hash in metadata) + a one-line wake to the orch so it dispatches the next slice. No prose report — the hash + status are on the task.
5. **Step-7.5** — implementer → orchestrator: **only** if a wiring concern needs the orch before Step 9 (else it rolls into Step 9).
6. **`/session-end`** — implementer → orchestrator: final recap, at close-out only.

**Orchestrator → lead is CONDITIONAL, not per-slice.** The orchestrator runs `/context-check <track>` locally after each slice (cheap, local) but pings the lead **only when a tier ≥ WARN is crossed** (or to raise one of the 4 escalation categories). On OK slices it sends nothing — the lead already has visibility from the task list + idle-notifications.

**No awareness pings, no relaying, no quoting.** No "ready for review," "FYI," "brief dispatched," "ack." Never re-quote a teammate's message — it's already rendered. The lead stays silent on routine idle-notifications + peer-DM summaries (free read-only context, not prompts to reply).

### Phantom-message defense

If a message's content + tone doesn't match the named sender, confirm before acting on high-stakes directives. When an agent pushes back on a correction with verifiable evidence, defer to the evidence — the original input may have been the phantom. A peer DM without the expected track prefix is a spawn-naming inconsistency within your own team (not cross-track bleed, which can't happen — `SendMessage` only resolves within your own session-scoped team) — verify the sender rather than reflexively ignoring it.

### Inter-teammate messaging — `SendMessage` only, parseable headers

**Every send to a teammate uses the `SendMessage` tool.** Plain assistant output reaches the USER only — never a teammate, even if it reads like a message in your transcript. (If a teammate seems to be waiting on you, first check you actually *called* `SendMessage` last turn — a reply composed as plain text never left your session. Don't re-send as text; call the tool.)

Messages auto-deliver as a turn and **wake** an idle teammate, so **never nag or re-send** — one send is enough; the reply is your wake-up.

**Magic-words headers** so the recipient parses the reply deterministically. The orchestrator's Step-2.5 reply starts with exactly one:
- **`APPROVED.`** — tests correct; impl proceeds to Step 3.
- **`TWEAK: <what>`** — impl revises and re-sends Step-2.5.
- **`ADD: <test>`** — impl adds the test and re-sends Step-2.5.

Answer any open questions in the body. No ambiguous "looks good, just check the X."

⛔⛔ **EVERY APPROVAL CITES THE STATE IT APPROVES — BARE APPROVALS ARE INVALID (task `### 24.56`).**
`APPROVED.` / `Ship it` / `TWEAK:` / `ADD:` MUST carry the artifact they were issued against: the
brief's spec-lint stamp, a commit hash, a test count, or the specific message being answered.
A recipient receiving a bare approval treats it as **not yet answered** and asks what it was
issued against — that is diligence, not obstruction.

> ⭐⭐ **WHY, and it is an OBSERVED failure rather than a precaution.** Handoff `026` measured six
> lead↔orchestrator message crossings. Four alarmed that work was MISSING when it had landed —
> and named that direction **SELF-CORRECTING**, because an alarm makes someone re-check. It then
> named the direction that would NOT self-correct — ***a crossed message asserting something IS
> done / IS approved when it is not, because nobody re-checks a reassurance*** — recorded that it
> had not yet happened, and that nothing structural prevented it.
>
> ⛔ **IT HAPPENED THE NEXT DAY.** An `APPROVED. / Ship it` for `### 24.45` crossed a Step-7.5
> report of an OPEN cross-package break ⇒ **an authorization issued against stale state.**
>
> ⛔⛔ **AND IT DID NOT SELF-CORRECT — IT WAS REFUSED.** The implementer declined an explicit ship
> authorization from their own orchestrator and said why. ⇒ ***the defence was a PERSON, not a
> control.*** ⭐ **An APPROVAL is harder to refuse than a CLAIM, because refusing it looks like
> insubordination rather than diligence** — so the social cost falls on exactly the person doing
> the right thing. It was caught only because that implementer had ALREADY measured the tree, so
> the reassurance CONTRADICTED something they knew rather than filling a gap they did not.
> ⚠ **Had the crossing arrived BEFORE they ran the suite, nothing would have caught it.**
>
> ⚠ **THE FAILURE MODE THIS RULE CREATES FOR ITSELF, named so it is not discovered later: a
> COPIED-FORWARD STAMP.** Citing a hash or a test count you did not just re-read is a bare
> approval wearing evidence. **The citation must be the state you actually observed when you
> wrote the approval** — if you are quoting the message you are answering, quote it; if you are
> citing a suite, cite the run you saw.

### Canonical context source — NO self-reporting

**The ONLY canonical source of any teammate's context usage is `/context-check`** (which reads heartbeats written by the status line script). **No agent self-reports context %.** Self-reporting is unreliable, creates dual sources of truth, and wastes context narrating internal state.

- **Implementer NEVER includes context % in any send** — not in Step-9, not in done-with-slice, not in `/session-end` recap, not anywhere.
- **When the orchestrator pings the lead** (only on a tier crossing — see Messaging budget) **it carries ONLY the verbatim output** of `/context-check <track> --brief` — not the orch's own assessment, not a paraphrase.
- **Lead uses ONLY the canonical script output** to evaluate threshold tiers. If a ping arrives with self-reported context, the lead treats the context value as missing (data corruption) and either re-invokes `/context-check` itself or waits for the next clean ping.

If you (any agent) notice your own status bar showing high context mid-work: **ignore it**. Finish your current slice. The status line is the system's signal to the heartbeat file, not your signal to break protocol. The next `/context-check` will surface the data through the canonical path.

### Slice atomicity — current slice ALWAYS finishes

**Current slices ALWAYS finish before any close-out action.** This is a hard rule, not a guideline.

- The auto-cycle trigger fires AFTER Step-10 commit by design — by definition no slice is in flight at the trigger point.
- Even at HARD-STOP, the action is **"halt dispatch of the NEXT brief"** — never "interrupt the current slice."
- **Implementer ignores any "stop now" / "halt" / "cycle" messages that arrive mid-slice.** Finish the current `/tdd` cycle through Step-10 commit, then become interruptible. Ack receipt silently if needed, but the slice continues.
- **Orchestrator does not relay halt-now signals to a mid-slice impl.** If a cycle instruction arrives from the lead while the impl is mid-slice, the orch holds the instruction until the impl's "done with slice" message arrives, then routes the close-out.
- **Lead never sends "stop now" to a mid-slice teammate.** Cycle instructions are always dispatched at slice boundaries (after the per-slice context-check ping arrives, which means the slice already landed).

If a user explicitly tells the lead "halt mid-slice now," the lead surfaces the user's instruction to the orch — but defaults to the slice-atomicity rule unless the user repeats with explicit "yes, interrupt mid-slice; I accept losing the in-flight work." Even then, the impl gets to abandon cleanly (no half-commit).

### Close-out gating

Close-out (`/session-end` + `/orchestrate-end` + `/team-end`) runs on **user-on-demand** OR the **context auto-cycle trigger** — never at routine work boundaries. The **canonical three-way close-out spec is `/orchestrate-end` Step 8** (it exists in every mode). Hot-routing accumulates in the working tree across slices until a trigger fires.
Lead-side auto-cycle mechanics (tier table, cycle flow): `docs/team-protocol.md` "Context monitoring + auto-cycle".

### Context monitoring (team-mode only)

Mechanics live in `docs/team-protocol.md` "Context monitoring + auto-cycle" (the canonical tier table) + the `check-team-context.sh` script — thresholds are the script's env defaults (`CLAUDE_TEAM_CTX_*`). Two rules load here: heartbeats are written **only** when a `~/.claude/team-registry/<session_id>.json` entry exists (so non-team sessions are silent), and the orchestrator pings the lead **only on a tier ≥ WARN crossing** (see Messaging budget).

_(Single-operator fallback rules live in the scaffolding repo — templates/CLAUDE.md "Single-operator fallback".)_

See `docs/team-protocol.md` for the lead's full playbook (team pattern only), `docs/orchestrator-briefing.md` for the orchestrator charter, `docs/tdd-brief-template.md` for the brief format.
