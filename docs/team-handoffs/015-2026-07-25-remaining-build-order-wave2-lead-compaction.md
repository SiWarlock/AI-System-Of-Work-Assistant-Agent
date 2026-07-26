# Team Handoff 015 — Remaining-Build-Order Wave-2 in flight; LEAD compaction

**Date:** 2026-07-25 · **Track:** single-track `main` · **Predecessor:** `014-2026-07-20-*`
**Why this exists:** the THIN LEAD is being **compacted** (a lead-only context reset — the team keeps running). This is the lead's re-orientation doc, same role a `/team-end` handoff plays for a fresh lead. **The 6 teammates + orchestrator STAY LIVE across the compaction** — do NOT re-spawn them unless they're gone.

## Base / recovery anchor
- `origin/main` was at `78888b98` (Wave-1 seal); Wave-2 commits landed on top (13.3a, 12.16, 13.13, 21.1/2-logic, 12.18, 13.17-logic, 9.12r, …). A **pre-compaction round SEAL is being run by the orch** (`/orchestrate-end` + push, NO teardown) — **on resume, `git log --oneline -5` + `git rev-parse origin/main` to get the actual latest sealed hash.** Everything is pushed → recoverable even if the team is gone.

## The work: owner-approved REMAINING-BUILD-ORDER (full plan: `docs/planning/remaining-build-order.md`)
8 arcs, dependency-ordered, run **in parallel across 6 areas** (owner directive: "work in parallel where possible"). Status as of compaction:
- **ARC 0 integrity** ✅ (7.19 retention rebuild, 11.2 schema-refusal) — DONE.
- **ARC 1 close Phase 9 → /phase-exit 9** 🔶 (9.14 done; 9.12r done; UiSafe-types done; 9.9 split into 9.9a worker-producer + 9.9b desktop-renderer; 9.8/9.5 follow-ups; 9.10-A/B safety; then the FIRST desktop /phase-exit).
- **ARC 2 frozen contracts** ✅ (13.15 Task+priority+TaskRepository + FailureClass members, sealed 54b052a7) — the bottleneck, DONE.
- **ARC 3 retrieval** 🔶 (13.3a local-embed done; 13.17 re-ranker done; 13.3b eval harness in flight).
- **ARC 4 §13.8 KEYSTONE** 🔶 (13.8a EntityResolver in flight → 13.8b LinkHealer → 13.8c planner → 13.8d ingest-rewrite → 13.8f meeting → 13.8g attendee→person; + 13.16 task-rollup). ⭐ The OSB-parity / smart-vault payoff.
- **ARC 5 dormant machinery** 🔶 (provint: 21.1/2-logic done, 13.13-provider in flight, extractors 13.2, 25.x output-workflows).
- **ARC 6 eval suites** 🔶 (evalsec: 12.16 done, 12.18 done, 13.3b).
- **ARC 7 hardening** (Phase 24) + phase-exits — later.
- Owner-gated crossings (§ARM-17/18/GBRAIN/21/23/RESEARCH) = build dormant only; live arming is the owner's per-crossing call via the lead.

## Parallelization + STANDING RULES (enforce these)
- **One implementer per area; no cross-track single-implementer vertical slices.** A vertical spanning areas = a brief per area, coordinated, **producer-first** (e.g. 9.9a worker producer → 9.9b desktop renderer). The territory-guard hook blocks cross-area writes + two impls in one area = single-tree collision.
- **Composition-root (apps/worker) touches = WORKER.** Standing ARC-5 pattern: build LOGIC in the owning package, WIRE at boot by worker (e.g. 21.1/2-logic in packages/integrations → the thin backends.ts binding is a worker task).
- **Safety commits route Step-9 to the LEAD:** 9.10-B (egress-ack command, rule-5) + any §5/rule-5-touching rework (e.g. 9.12r was Option-A, §5-preserving). security-reviewer=invariant on those.

## LIVE ROSTER (exact names — verify with /context-check on resume)
- `main-orchestrator` (coordinating) · `worker-implementer-2` · `desktop-implementer-2` · `knowledge-implementer` · `provint-implementer` · `evalsec-implementer` · `contract-implementer`.
- ⚠ Name history: earlier day-gap/limit deaths caused `-2` suffixes; all stale base-name duplicates were retired this session. The `(stale)` entries in /context-check are those dead old sessions — ignore them; the names above are live.

## CONTEXT MONITORING — read this
- **FIXED this session:** `~/.claude/scripts/check-team-context.sh` `STALE_SECONDS` 600→1800 (env `CLAUDE_TEAM_HB_STALE`). Heartbeats are a side-effect of status-line render; Agent-tool teammates render only ~every 7-8 min, so the old 10-min window hid live teammates as "stale." Now `/context-check main` shows all live teammates with real ctx% + "last update <age>" (numbers are LAGGY by up to ~8 min — judge trust by the age).
- **Deeper fix = TRACKED FOLLOW-UP:** write the heartbeat from a per-turn hook (Stop/PostToolUse), decoupled from status-line render, for continuous refresh. Verify a hook's input exposes `context_window.used_percentage` first. Land in the **scaffolding repo** `templates/scripts/` + hook config (owner directive: tooling fixes → scaffolding, not silent in-target) + update `~/.claude/`. (Same as task #19's spec-lint scaffolding port.)
- **Tiers:** WARN 70 / ACTION 75 / HARD 80 (`CLAUDE_TEAM_CTX_*`). **Backup discipline (heartbeats laggy):** proactive slice-count cycling at round boundaries + teammates self-flag context on WARN+.
- At compaction the LEAD was at **69%** (highest; the reason for the compaction). Teammates 36-61%.

## PENDING OWNER DECISIONS / GATES (bring these to the owner)
1. **9.10-B egress-ack command** — Step-9 routes to the lead (rule-5, security-reviewer=invariant).
2. **Employer-Work cloud egress = OWNER-APPROVED** (via the COMPANY Claude subscription — see memory `employer-egress-company-subscription`). The FLIP is gated on the owner confirming the active `claude` login **IS the company subscription** at flip time (route via lead). Until the per-workspace **subscription-split** (new planned scope) lands, ONE login governs all egress. Sub-question still open: point the single login at the company sub now (personal rides it interim) vs build the split first.
3. **21.3** write-enum coverage vs read/write asymmetry — flagged owner decision (surface when it comes up).
4. Personal egress path = 9.10-A Option A + seed personal allowlist=[claude] (decided, in flight).

## SESSION HYGIENE (owner-flagged, in memory)
- **Group cycle:** ALL impls `/session-end` → orch `/orchestrate-end` → shut ALL down (verify `shutdown_approved` — conclusive; don't wait for `teammate_terminated`) → THEN spawn. Never spawn replacements while old sessions live (base-name sprawl). **Orch-only cycle** (fan-out team, only coordinator loaded) = cycle orch alone, keep impls. Memory: `cycle-closeout-order`, `cycle-terminate-drained-teammate`.
- On resume after a gap: retire orphaned/dead sessions PROACTIVELY before spawning (verify git captured their work — single tree).

## HOW TO RESUME (post-compaction lead)
1. `git log --oneline -5` + `git rev-parse origin/main` — get the actual sealed hash.
2. `/context-check main` — confirm the live roster above is up (now works post-fix); ignore `(stale)` old duplicates.
3. Read this doc + `docs/planning/remaining-build-order.md` + `IMPLEMENTATION_PLAN.md` "Currently in progress".
4. If the team is LIVE (expected): resume thin-lead mode — hold silently, surface at arc milestones (§13.8 keystone / /phase-exit 9), the 9.10-B safety Step-9, owner-gated crossings (esp. the employer-flip precondition), escalations. If the team is GONE: re-spawn per the group-spawn templates from the sealed base + this roster/arc-plan.
5. Do NOT re-close/re-spawn a live team just because you compacted.
