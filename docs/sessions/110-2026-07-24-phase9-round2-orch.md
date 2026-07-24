# Session 110 — Phase-9 "make the daily briefing real" round 2 (orchestrator)

- **Date:** 2026-07-24
- **Phase:** 9 (Electron Desktop UI — the "make the daily briefing real" arc, round 2)
- **Track / role:** `main` / main-orchestrator
- **Predecessor:** [109-2026-07-24-phase9-open-in-vault-desktop.md](109-2026-07-24-phase9-open-in-vault-desktop.md)
- **Successor:** _TBD_
- **Round seal commit:** _(this `/orchestrate-end` commit)_

## Why this session existed

Cycle-successor orchestrator resuming the Phase-9 dashboard arc (prior trio cycled at the round-1 clean seal). Drove 5 slices across both tracks to a genuinely-populated, owner-runnable Today. Mid-round the owner hit a hard launch blocker that reprioritized the queue.

## What was built (5 slices, both tracks — all reviews CLEAN/low)

- **9.18 `2ce23ef1` (desktop) — ⚡ ./dev.sh startup-bug fix.** THE priority interrupt: the owner couldn't launch the app. Root-caused (orchestrator) as a REGRESSION from 9.12 — Electron main `require()`'d `@sow/contracts` and resolved to raw `src/index.ts` (main externalizes `@sow/*` but lacks the `sow-built` condition the worker-host child sets) → `SyntaxError` at load. Fix: exclude pure `@sow/*` from the main externalize + deep-import `@sow/contracts/primitives/result` (390K→16.5K, no zod/ajv drag). `./dev.sh` boots. Desktop L17.
- **9.16 `d44a1f24` (worker) — ingestion-inbox park-sink producer** bound at the composition root (park upserts / disposition removes, fail-SAFE both seams, WS-8). Worker L77.
- **9.17 `2405c39f` (desktop) — authoritative durable first-run gate** (main-owned marker + write-once backfill for existing installs; gates only the mount, never the WS-8 predicate; completes 9.11). Desktop L18.
- **9.19 `0c8aa450` (worker) — DEV-ONLY `SOW_DEMO_SEED` demo-seed** (vault-free, full Global Today read-model, read-model-ONLY, strict gate byte-equivalent OFF). Worker L78.
- **9.20 `cc811286` (desktop) — Today-live daily-brief + honest-empty schedule** (deterministic model-free brief from store counts; live e2e verified). Desktop L19.

**Briefs authored (all spec-lint PASS):** 157 (9.16) · 158 (9.17) · 159 (9.18 bug-fix) · 160 (9.19) · 161 (9.20). Plan tasks 9.16–9.20 added + ticked; 9.21 (repair-leg) added OPEN.

## Decisions made

- **Startup fix = bundle pure `@sow/*` into main**, NOT change the shared `@sow/contracts` package.json `default`→`dist` (that breaks the source-based vitest/tsc flows). Deep-import to avoid the barrel's zod/ajv graph.
- **Sequencing under owner pressure:** the startup fix jumped ahead of the queued producer legs (owner blocker); the desktop-implementer's just-started 9.17 was shelved (RED written, not run — cleanest shelve point) and resumed after. Lead confirmed finish-then-startup vs shelve; shelve won (fastest owner unblock, zero lost work).
- **Demo-seed = read-model-ONLY** (the lead was emphatic): never Markdown/KnowledgeWriter/candidate-gate/egress. Seeding the approvals OPERATIONAL store would break that pin, so a populated approvals inbox is a deferred SEPARATE dev-seed.
- **Daily-brief = deterministic-from-counts** (model-free): the rich model-synthesized brief stays the on-request Copilot path / Phase-24.x. Dropped the health-derived "open issues" stat (conflated infra health with work + duplicated the System Health section). **Schedule = honest-empty** ("No calendar connected") — not a fabricated demo schedule; real via 9.9 Calendar.
- **First-run backfill** added for EXISTING installs (create-only marking never protects installs predating the feature; the WS-8 registry is authoritative onboarding evidence).
- **Round-seal at the demo-complete milestone, NOT a cycle** (context OK 52%) — both tracks HELD for owner-dogfooding feedback to steer the next sub-phase (avoids speculative deep dispatch that the active feedback loop keeps redirecting).

## Decisions explicitly NOT made (deferred)

- The remaining Phase-9 surfaces — **9.9 Calendar · 9.10 egress-ack** (⚠ SAFETY-SENSITIVE, rule-5-adjacent — the lead must review the control design BEFORE dispatch) · 9.14 renderer-isolation/redaction specs · 9.6 real Copilot · the real dashboard/task-rollup producer → then `/phase-exit 9` + the owed LIVE `/design-review`.
- The queued MAJOR arc **§13.8 living-vault synthesis** (owner-confirmed next-major) EXTENDED with the Granola gaps (**13.8f** meeting-path rewrite · **13.8g** attendee→person resolution — verify ARCH §9 workflow-1 L297 · **23.8** Granola SPINE) + the 2 new gaps (Task/Project priority model + retrieval re-ranker) — all subagent-authored, ANCHOR-VERIFY before canonical; lead routes at the §13.8 integration point.

## Open follow-ups (Residuals-9, routed this seal)

§ARM-21 disposition-ws liveness (9.16) · 9.16-health HealthItem · first-run first-boot-worker-down residual + backfill-on-fault (9.17) · demo approvals-seed + `SOW_DEMO_SEED` dotenv-allowlist (9.19) · global-approvals-in-brief + populated-demo-schedule (9.20) · packaging `@sow/*` resolution (9.18).

## How to use what was built

**Owner:** `SOW_DEMO_SEED=1 ./dev.sh` → a genuinely populated Global Today (recent activity, ingestion inbox, waiting-on-you cards, projects, system health, cross-workspace surface, and a real deterministic daily brief) with ZERO model calls / no arming / no egress. Plain `./dev.sh` boots to an empty-until-data Today (byte-equivalent — the seed is strictly gated).
