# Team Handoff 013 — Phase-18 crossing built + dormant; owner chose subscription (Option B); team pause for clean /team-start restart

**Date:** 2026-07-18
**Track:** solo / single-track `main`
**Worktree:** root checkout (single-track)
**Predecessor handoff:** `012-2026-07-17-flipwiring-sealed-auth-investigation-done-orch-cycle.md`
**Successor handoff:** `014-2026-07-20-phase18-pathbeta-sealed-scaffolding-upgraded-team-cycle.md`
**Round-seal commit at handoff:** `171017b7`

## Why this handoff exists
Owner-directed **full team pause + clean restart**: this session ran the team as raw `Agent`-tool background subagents (which bypassed `/team-start` registration and broke `ctx_pct` context-monitoring). The work is whole + pushed; the owner is shutting the team + session down and restarting fresh with `/team-start` so monitoring + the canonical protocol are wired correctly.

## Team composition at close
- **Lead:** this session (single-track `main`). NOTE: ran as a resumed lead that never executed `/team-start`, so it never loaded `docs/team-protocol.md` (fixed in the MEMORY resume anchor).
- **Orchestrator:** cycled repeatedly (`orch` → `orch2` ×4, reused-name) — all terminated; last was the doc-flush orch2 (`171017b7`).
- **Implementers:** `worker-impl` → `worker-impl2` → `worker-impl3` → `worker-impl4` (worker); `integrations-impl` (providers); `contract-impl` (contract) — **all terminated**, all work committed.
- All teammates `/session-end`/`shutdown`-closed at round-seal **`171017b7`**. **Clean close — nothing in flight.**

## Active arc + where it landed
**Phase 18 (§19.5 real ModelProvider) — the whole crossing is BUILT, DORMANT, and PUSHED. NO hard line crossed; zero real spend.**
- Safe-build S1–S9 + the crossing-prereq round (CP-1…CP-7) + the flip-wiring round (18.18a/b) all landed. GATE-1 (REQ-F-017 `agent_extraction` no-inference schema) satisfied; GATE-2 (WS-8 multi-ws) deferred (single-workspace).
- **⭐ OWNER DECISION (load-bearing — ARCHITECTURE §7/§19.5):** the real-model **EXTRACTION runs on the Claude SUBSCRIPTION** — `createClaudeSubscriptionCompletion` (Agent SDK `query()` on the local `claude` login; worker runs `ANTHROPIC_API_KEY` **UNSET**), NOT a raw `x-api-key` key. Both paths converge on `AgentResult.candidateOutput`, so GATE-1 is shape-agnostic. The raw `ModelProviderPort`/`createRealModelHttpTransport` path stays the FALLBACK (isolated billing / non-Claude providers). **Do NOT have the owner provision an API key.**

## In-flight at close
**None — clean close.** All 35 tasks completed or pending-owner-crossing (#13 crossing preconditions, #15 pre-existing broken -live test, #18 deferred first-class-BrokerCandidate arch). Doc debt flushed (`171017b7`).

## Carry-forward to next team session
- **`IMPLEMENTATION_PLAN.md` "Currently in progress"** (authoritative — read it): the Option-B decision + the NEXT ROUND.
- **NEXT ROUND (Medium build, `packages/providers` + `apps/worker`):** route the extraction legs through the subscription synthesis — reuse the GATE-1 `agent_extraction` schema + gates; re-point the COST-1 cap to the SDK's native `maxBudgetUsd`; bind the currently-fail-closed runtime branch (`apps/worker/src/composition/provider-runner.ts:271-274`). Owner-gated; provision/enable NOTHING (the ENABLE stays lead+owner-run — first real subscription call).
- **#13** — Phase-18 owner crossing/arming preconditions (5 items + the redirect-safety + health-source + cap-tuning notes).
- **#15** — pre-existing broken `-live` test cluster (low-priority, NOT ours).

## Open decisions / blockers for the human
- **The ENABLE (first real subscription call/egress) is owner-gated** — comes AFTER the next build round routes extraction through the subscription. Employer-Work egress veto still applies (rule 5).
- Extraction cap recommendation: ~$1.50 metered (~$0.45 real) — but under Option B the SDK's native `maxBudgetUsd` is the simpler lever; finalize at enable.

## ⚠ Context-monitoring — fix at restart (load-bearing)
`/context-check` read `0%` for teammates all session because they were spawned as raw `Agent` subagents with **no** `~/.claude/team-registry/<session_id>.json` entry ⇒ no `ctx_pct` heartbeat. **Confirmed fix:** running `~/.claude/scripts/team-register.sh <name> <role> session-734f946b` on spawn makes `/context-check` read a real % (validated: a registered orch2 showed `22% [OK]`). A proper `/team-start` writes this registry entry via its spawn templates → restores the **canonical `docs/team-protocol.md` protocol: WARN 70% / ACTION 75% / HARD-STOP 80%** on `ctx_pct` (env `CLAUDE_TEAM_CTX_*`). **Cycle at ACTION (75%), never on a slice-count/lower-% heuristic** (that was a wrong invention this session).

## Spawn prompts ready for the next team session
Use the `/team-start` templates (which include the `team-register.sh` first action + the correct start command). WHY + WHERE only:

**Orchestrator** (runs `/orchestrate-start`, NOT `/session-start`):
```
Orchestrator for the SoW build, track solo/main. ARC: Phase-18 real ModelProvider — the crossing is BUILT + DORMANT + pushed (171017b7); owner chose the Claude SUBSCRIPTION for extraction (Option B — ARCHITECTURE §7/§19.5). YOUR ROUND: scope + drive the Medium build to route the extraction legs through the subscription synthesis (createClaudeSubscriptionCompletion; reuse GATE-1 schema + gates; SDK maxBudgetUsd cap; bind the fail-closed provider-runner.ts:271-274 branch). Read IMPLEMENTATION_PLAN "Currently in progress" + handoffs 012/013 + ARCHITECTURE §7. Provision/enable NOTHING — the ENABLE (first real subscription call) is owner-gated, lead-run.
```

**Implementer — worker** (`apps/worker`; runs `/session-start`):
```
Worker implementer, SoW build. ARC as above. Your legs: the runtime-branch binding (provider-runner.ts:271-274), the route-selection change, and re-pointing COST-1 to the SDK maxBudgetUsd. Dormant/mock-tested first; the ENABLE is owner-gated. TDD; security-reviewer on the credential/egress path.
```

**Implementer — providers-integrations** (`packages/providers`; runs `/session-start`):
```
Providers implementer, SoW build. ARC as above. Your legs: reuse createClaudeSubscriptionCompletion with the sow:agent-extraction schema for the extraction request; ANTHROPIC_API_KEY-unset invariant. Dormant/mock-tested first. TDD; Context7 for the Agent SDK query() shape; security-reviewer on egress.
```

## How to resume
Next team session: lead runs `/team-start` (loads `docs/team-protocol.md` — the tier table this session was missing), reads THIS handoff + `IMPLEMENTATION_PLAN.md` "Currently in progress" + ARCHITECTURE §7 on demand, spawns teammates using the prompts above **via the /team-start templates (with the `team-register.sh` first action)** so monitoring works, and verifies read-backs. Everything is on `origin/main = 171017b7`.
