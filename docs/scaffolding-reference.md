<!--
  TEMPLATE: docs/scaffolding-reference.md → write to docs/.
  The in-repo, project-specific map of this scaffolding. It is the companion to
  the universal SCAFFOLDING-GUIDE.md — the guide explains the pattern in general;
  this file records how THIS project instantiated it. Keep the workflow-pattern
  summaries; fill the inventory + command table + EXAMPLE BLOCKs. Delete this comment.
-->

# System of Work Assistant — Scaffolding Reference

> Project-specific map of this repo's Claude Code scaffolding. Documents what each piece is and how this project adapts the universal agent-team pattern.
>
> **For the universal pattern documented end-to-end**, see `SCAFFOLDING-GUIDE.md` (the project-agnostic guide this scaffolding was generated from). This file is the project-specific instance.

---

## TL;DR

This project runs the **agent-team orchestrator + implementer pattern** (three roles + human). Same slash commands, same Step-9 routing matrix, same N+2 commit cadence, same cross-doc invariants discipline as the universal pattern. **Adaptations are project-shaped:** this project's stack, code areas, phase plan (`0–12 (phase) / N.x (task)`), forbidden patterns, and architecture are its own.

**Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`** — Claude Code's agent-teams feature is experimental and OFF by default; `/team-start` checks this before spawning anything. Without it, the single-operator fallback below is the only available mode, not a stylistic alternative.

_(Single-operator fallback: drop the team-lead row + `/team-start`/`/team-end`; the human bridges between orchestrator + implementer sessions.)_

---

## File inventory

```
SoW-build/
├── .claude/
│   ├── commands/                       # Slash commands
│   └── agents/                         # Subagents (opt-in starter set + reactive additions)
├── packages/contracts/
│   ├── CLAUDE.md                       # Code-area conventions
│   └── LESSONS.md                      # Lessons logged (§1+)
├── docs/
│   ├── team-protocol.md                # Loaded by /team-start (team pattern only)
│   ├── orchestrator-briefing.md        # Loaded by /orchestrate-start
│   ├── tdd-brief-template.md           # /tdd brief format
│   ├── scaffolding-reference.md        # THIS FILE
│   ├── team-handoffs/                  # /team-end outputs (team pattern only)
│   ├── briefs/                         # Numbered /tdd briefs (NNN-<task-id>-<topic>.md)
│   ├── sessions/                       # Numbered chronological session docs
│   └── runbooks/                       # Operational procedures
├── CLAUDE.md                           # Root — project conventions + shared comm rules
├── IMPLEMENTATION_PLAN.md                    # Task tracker
└── ARCHITECTURE.md                        # Architecture / design contract

# User-global (~/.claude/) — populated at /team-start by spawn prompts (team mode only):
~/.claude/
├── statusline-command.sh               # Status line + heartbeat writer (install once)
├── scripts/
│   └── check-team-context.sh           # /context-check helper (install once)
├── team-registry/                      # Per-session: {session_id, name, track_label, role, cwd, ts} — OUR bookkeeping, not Claude's real (session-derived) team
│   └── <session_id>.json               # Written by teammate at startup via spawn prompt
├── heartbeats/                         # Per-session ctx_pct heartbeats (status line writes IFF registry exists)
│   └── <session_id>.json               # Updated every status line refresh
└── track-history/                      # Per-slice trajectory data
    └── <track>/<name>.jsonl            # Per-slice ctx snapshot (/context-check --snapshot) for 3-slice rolling growth
```

<!-- ▼ EXAMPLE BLOCK [id=inventory-extension]: extend the inventory with the project's real layout — extra code areas, deliverable docs, eval suites. ▼ -->
<!-- ▲ END EXAMPLE BLOCK [id=inventory-extension] ▲ -->

---

## Team pattern (three roles + human)

The full topology, role/cwd/loads table, escalation taxonomy, and the track-naming/numbered-doc collision-prevention rule are **canonical in root `CLAUDE.md` "Team coordination — shared rules"** (+ `docs/team-protocol.md` for the lead). One-line map:

- **Team lead** — thin, durable; `/team-start` + `/team-end`; escalation conduit to the human; stateless between events. Reads progress from the task list + free idle-notifications; pings nobody per-slice.
- **Orchestrator** — planning, scope, docs, Step-2.5 review, Step-9 routing, commit messages, push, `/orchestrate-end`.
- **Implementer (per area)** — `/tdd` cycles, `/preflight`, `/session-end`, code commits only.

Orchestrator ↔ implementer communicate **directly** (`SendMessage` for checkpoints, the **task list** for status); the lead is looped in only for the 4 escalation categories + tier-crossing context.

---

## Slash commands

Command descriptions are injected by the harness per command; root `CLAUDE.md` "Slash commands" keeps only the role pairing. Pairs: lead `/team-start`+`/team-end`; orchestrator `/orchestrate-start`+`/orchestrate-end`; implementer `/session-start`+`/session-end`; plus `/tdd`, `/wired`, `/context-check`, `/preflight`, `/run-tests`, `/check-arch` (+ optional `/eval`, `/trace`). _(Single-operator: no `/team-start`/`/team-end`.)_

---

## Workflow patterns

### Per-slice TDD round

1. Orchestrator authors a brief → `docs/briefs/NNN-<task-id>-<topic>.md`
2. Orchestrator **creates + assigns the slice's task** (`TaskCreate` + `TaskUpdate owner`) + sends the brief reference (one line) to the area implementer
3. Implementer runs `/tdd <feature>` → Step 0 (self-check; user-confirm in single-operator) → Step 1 → Step 2 RED → Step 2.5 tight test-design write-up
4. Orchestrator reviews + replies directly (`APPROVED.`/`TWEAK:`/`ADD:`); escalates a safety design Q if needed
5. Implementer Steps 3-7 (confirm RED → GREEN → refactor → suite)
6. **Step 7.5 reachability** — confirm wiring from a production entry point (`/wired`)
7. Step 8 lint+typecheck + **policy-gated** reviewer fan-out (per root `CLAUDE.md` reviewer policy — security on invariant slices, code-quality lite)
8. Implementer sends categorized Step-9 flags directly to orchestrator
9. Orchestrator routes hot (commit-message-first reply); escalates deferments / safety findings / load-bearing architectural calls
10. Implementer Step 10: commits with the orchestrator-authored message, then **marks the task `completed`** (hash in metadata) + a one-line wake to the orch
11. **(Team mode)** Orchestrator runs `/context-check <track> --snapshot <hash>` locally; pings the lead **only if a tier ≥ WARN is crossed**; then dispatches the next slice without waiting
12. Repeat

### Context monitoring + auto-cycle (team mode only)

Status lines write per-session heartbeats (gated on a `~/.claude/team-registry/` entry, so solo sessions are silent). The orchestrator runs `/context-check <track>` **locally each slice** but pings the lead **only on a tier crossing** (≥ WARN) — OK slices produce no ping; the lead's free idle-notifications + the task list cover progress. The tier ladder (WARN/ACTION/HARD-STOP) and the full auto-cycle flow are **canonical in `docs/team-protocol.md` "Context monitoring + auto-cycle"** (numbers = the script's env defaults, `CLAUDE_TEAM_CTX_*`).

### Step-9 routing matrix

Canonical in `docs/orchestrator-briefing.md` "Step-9 routing matrix." (Implementer categorizes; orchestrator routes hot.)

### Carry-forward triage at `/orchestrate-end`

Five outcomes: DELETE / KEEP / **INLINE-TARGET (→ real task checkbox, not an annotation)** / DEFER (escalate) / SPREAD. DELETE + INLINE-TARGET run **mechanically** (no user prompt); only **DEFER** escalates. Resolved items are **deleted with an archive/commit pointer, never annotated in place**; live overflow past the ~7 cap moves to the owning phase's `#### Residuals`.

### Reachability (tested ≠ shipped)

`/tdd` Step 7.5 + `/wired` prove each feature is invoked from a real entry point; the `reachability-auditor` subagent (if installed) audits an entire code area at phase boundaries.

### Commit cadence

N slice commits + 1 session-doc commit + 1 round commit = **N + 2** per round. Push once at `/orchestrate-end` — **only when a remote is configured** (to **none configured (run `git init`; push when a remote is set)**).

---

## Project-specific conventions

<!-- ▼ EXAMPLE BLOCK [id=instance-conventions]: the conventions unique to this project — its architecture sentence (if any), its forbidden patterns, its key safety rules, its layer dependency rule, its cross-doc invariant set. These distinguish this project's instance from the universal pattern. ▼ -->
- **Tracker:** `IMPLEMENTATION_PLAN.md` — 13 phases (0–12), `N.x` tasks, read by section.
- **Contract:** `ARCHITECTURE.md` — §-anchored; Appendix A is the model inventory the area cross-doc tables mirror.
- **Tracks/worktrees:** 6 (see `docs/team-protocol.md`). Numbered docs are `<track>-NNN` prefixed (per root CLAUDE.md).
- **Stack:** TS monorepo (pnpm + Turbo); uniform commands (`pnpm test`/`lint`/`typecheck`/`build`), `--filter` to scope a track.
- **Posture:** production-grade. Reviewer policy: security=invariant, code-quality=every-slice.
<!-- ▲ END EXAMPLE BLOCK [id=instance-conventions] ▲ -->

---

## State sources of truth

| Concern | Source of truth | Loaded by |
|---|---|---|
| Team topology + escalation rules | Root `CLAUDE.md` "Team coordination" + `docs/team-protocol.md` | `/team-start` (lead-specific) |
| Current state, "what's done, what's next" | `IMPLEMENTATION_PLAN.md` | `/orchestrate-start` + `/session-start` |
| Technical narrative of just-landed work | Most recent `docs/sessions/<NNN>-*.md` | `/orchestrate-start` |
| Round ledger (thin pointer-lines) | `IMPLEMENTATION_PLAN.md` "Log" | `/orchestrate-start` |
| Per-slice design audit trail | `docs/briefs/<NNN>-<task-id>-<topic>.md` | On-demand; latest at `/orchestrate-start` |
| Team-pause handoff state | Most recent `docs/team-handoffs/<NNN>-*.md` | `/team-start` (when resuming) |
| Conventions / patterns | `packages/contracts/LESSONS.md` (prose) + `packages/contracts/CLAUDE.md` (index) | On-demand |
| Architecture / design contract | `ARCHITECTURE.md` | On-demand via `/check-arch` |
| Workflow rules | `docs/orchestrator-briefing.md` (Step-9 matrix canonical); this doc | `/orchestrate-start` |
| `/tdd` brief format | `docs/tdd-brief-template.md` | Via `/orchestrate-start` |
| Universal scaffolding pattern | `SCAFFOLDING-GUIDE.md` (in the source scaffolding repo) | Reference only; not loaded per session |

The principle: **single source of truth per concern.** Drift between sources is a bug.

---

## How to evolve this scaffolding

- **New slash command** → file in `.claude/commands/` + add to root `CLAUDE.md` "Slash commands" + reference in `docs/orchestrator-briefing.md`.
- **New subagent** → file in `.claude/agents/` + `.claude/agents/README.md` inventory + area `CLAUDE.md` "Subagents".
- **New lesson** → next anchor in `packages/contracts/LESSONS.md` + row in the `packages/contracts/CLAUDE.md` index. Hot-routed at Step 9.
- **New convention** → entry in `packages/contracts/CLAUDE.md` Forbidden patterns or root `CLAUDE.md` Key safety rules + a `LESSONS.md` entry if durable.
- **New cross-doc invariant** → row in the `packages/contracts/CLAUDE.md` table + atomic `ARCHITECTURE.md` edit.
- **New escalation category** → root `CLAUDE.md` "Escalation taxonomy" + `docs/team-protocol.md` "What the lead does NOT do" cross-reference.

**Don't** add project *state* to scaffolding files — state lives in `IMPLEMENTATION_PLAN.md`. **Don't** rename the cross-referenced files (`IMPLEMENTATION_PLAN.md`, the `CLAUDE.md` files, `packages/contracts/LESSONS.md`, `docs/team-protocol.md`, `docs/orchestrator-briefing.md`, `docs/tdd-brief-template.md`) casually — they're named inside slash command bodies; renaming is a multi-file ripple.

---

## Limits / known gaps

1. **Track-prefix naming is a legibility/collision-prevention convention, not a delivery-channel defense** — genuine cross-team `SendMessage` bleed can't occur (each parallel track runs its own session-scoped Claude team), so the real risk is a spawn-naming mistake within one's own team, not "another track's" message arriving.
2. **Documentation drift between a lesson and the code it governs is only audit-caught** — the cross-doc invariants table catches model↔spec drift mechanically; lesson↔code drift is not.
3. **Subagents aren't sandboxed** — their forbidden-patterns section is the only guard.
4. **HITL chokepoints stay HITL** — deploys, scope cuts, load-bearing architectural decisions, push approvals keep the user in the loop.
5. **The brief-drafter subagent (if installed) requires a quality trial before standard adoption** — briefs are load-bearing.

See `SCAFFOLDING-GUIDE.md §12` for the full list.

---

**End of scaffolding reference.** For the universal pattern, see `SCAFFOLDING-GUIDE.md`.
