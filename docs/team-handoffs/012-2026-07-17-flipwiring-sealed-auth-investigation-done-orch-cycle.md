# Orch handoff 012 — 2026-07-17 — Phase-18 FLIP-WIRING sealed + AUTH INVESTIGATION done → owner A/B decision + ORCH cycle

Outgoing **orch2** → incoming **orch2** (SAME NAME reuse — lead terminates me + respawns `orch2`; worker-impl4 / integrations-impl keep addressing you, no rename/announce). Cycling at a CLEAN sealed boundary: flip-wiring round fully closed + pushed, no slice in flight, owner-decision lull. Qualitative self-flag (heavy after a long eventful round) — honored by the lead. Everything you need is here + in **task #13 metadata** (the canonical crossing/flip store — read it verbatim).

## ⏱️ IMMEDIATE STATE — verify `git log --oneline -4`
- Repo `/Users/dreddy/Documents/Dev/AI-tools/SoW/SoW-build`, single-track `main`, single shared checkout.
- **origin/main = `d193fa14`** (fully pushed + level; verify `git status -sb` = `* main...origin/main`).
- **⭐ PHASE-18 FLIP-WIRING ROUND COMPLETE + SEALED.** The LAST dormant build before the owner ENABLE. Commits: **18.18b providers `67f6b87a`** (`createRealModelHttpTransport` — real injected-fetch `HttpTransport`, `redirect:"manual"` egress-hardened, mock-fetch tested) + **18.18a worker `aa4b93e1`** (forward `config.providerTransport` through `bootWorker`→`assembleBackends` via a pure `buildBackendsConfig` seam + `buildRealProviderTransportGate` assembly helper) + round-close docs `d193fa14`. Both DORMANT / mock-tested / NO hard line. Suites green (worker 1700/0, providers green, typecheck 20/20).
- **Working tree — NEVER-STAGE:** `.claude/settings.json`, `CLAUDE.md`, `docs/team-handoffs/007-*`, `apps/worker/graphify-out/`, `graphify-out/`. (012 rides your first round-close, or the lead commits it.)

## 🔴 YOUR FIRST TASK — the OWNER A/B DECISION (the live enable blocker)
The auth investigation the lead flagged is **DONE** — I ran it read-only + delivered findings to the lead (our messages crossed; the lead's cycle-approval was composed before it saw the findings). **Do NOT re-run it.** The finding REFRAMES the enable:

**The owner is on a Claude SUBSCRIPTION (Claude Code login), NOT a pay-per-token API key — and the owner may NOT need a key at all.** Two built+dormant paths:
- **Option A** = ModelProviderPort (what the whole Phase-18 crossing built): `createRealModelHttpTransport` → raw `x-api-key` → NEEDS an Anthropic API key (`packages/providers/src/model/claude-provider.ts:119-150,:73-76`).
- **Option B** = subscription: `createClaudeSubscriptionCompletion` (`packages/providers/src/model/claude-subscription-completion.ts:115-175`) calls the Claude Agent SDK `query()` with NO credential — the SDK auto-uses the local `claude` login (no key, bills the subscription; the file's own header comment :1-8 says exactly this — I verified it). Gated by `copilotRealModel`/`copilotAgentMode` (default OFF).

**Q2 (verified):** the Agent SDK inherits the Claude Code login (claude-api skill: credential resolution `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login` OAuth profile → …; bare SDK works post-login). ⚠ **OPERATIONAL GOTCHA:** the worker MUST run with `ANTHROPIC_API_KEY` UNSET — even an empty/stale key shadows the subscription profile and wins precedence.

**Q3 — Option-B viability = VIABLE, Medium rework.** Both paths converge on `AgentResult.candidateOutput` (`packages/providers/src/ports/agent-result.ts:52`), so the candidate-schema gate + `validateNoInference`/REQ-F-017 (GATE-1/CP-1) are shape-agnostic — B satisfies the SAME invariants; the SDK already emits structured `json_schema` output. Work to do IF the owner picks B: bind the currently **fail-closed** runtime branch (`apps/worker/src/composition/provider-runner.ts:271-274`) OR reuse `createClaudeSubscriptionCompletion` with the `sow:agent-extraction` schema; change route-selection to emit a `{runtime,…}`/subscription route for the extraction capability; re-point COST-1 to the SDK-reported cost (the SDK has a NATIVE `maxBudgetUsd` cap — `claude-subscription-completion.ts:143` — even simpler than the CP-5 pricing projection). Egress veto (rule 5) still applies: subscription = cloud egress.

**The decision is a ToS question for the OWNER, not code (escalation cat-4 — the LEAD maps it, doesn't pick):** *"Is programmatic/headless extraction over the subscription login acceptable under its ToS + rate limits (same quota as interactive Claude Code) — or do you want isolated pay-per-token billing?"*
- Subscription-fine → **Option B: provision NO key.** Orchestrate the Medium build round (bind the runtime branch + subscription extraction leg + COST-1 re-point).
- Wants isolated/predictable billing → **Option A** (already built; one `providerTransport` flip + provision the key + the #13 arming preconditions below).

**Your first move on spawn:** `/orchestrate-start`, read this + #13, then WAIT for the lead to relay the owner's A/B choice. Do NOT provision/enable/flip anything (owner-gated hard line). The investigation subagent is resumable for deeper Option-B scoping: `SendMessage to: 'a08d299a9590a245f'`.

## 🧭 ENABLE STATE — #13 arming preconditions (apply if the owner picks A)
Enable order (owner-gated, lead-run; the orchestrator does NOT enable/flip). All detail on **#13 metadata**:
1. Owner provisions the Claude key into Keychain HIMSELF (`security add-generic-password`, `keychain://providers/claude` — never via lead/conversation, rule 7).
2. Construct `createRealModelHttpTransport({fetch})` with a **redirect-honoring** fetch (Node global honors `init.redirect`; the transport sets `redirect:"manual"`). #13 `arming_precondition_redirect_safety` — a fetch that drops `init.redirect` reopens a cross-origin `x-api-key` re-send.
3. **Bind a real `healthSource`** — the LAST functional prereq. Omitted ⇒ `selectHealthSources` → `UNAVAILABLE` deny (safe but first extraction fails closed). #13 `arming_precondition_health_source_producer`. May want a small mock-testable reachability-probe build, OR the owner binds a minimal deliberate source for the controlled first test.
4. Set the extraction cap (~$1.50 ≈ $0.45 real sonnet-4-6; #13 `cap_tuning_recommendation`). ⚠ if via `BootConfig.budgetDefaults`, first forward the budget siblings (`bootWorker`'s `buildBackendsConfig` drops `budgetDefaults`/`budgetPricing`/etc — #13 `arming_decision_budget_sibling_forward`); if via editing the compiled `DEFAULT_BUDGET_DEFAULTS` (L55 posture), no follow-up. COST-1 already fires at the shipped default regardless.
5. Assemble `buildRealProviderTransportGate({runnerDeps:{transport,facade,controller,allowedEndpoints,now,logSink}, healthSource})` → `config.providerTransport` (enabled:true) → flip → first real spend.

GATE-1 (REQ-F-017) satisfied. GATE-2 (WS-8 multi-ws) deferred — single-workspace.

## 📝 DOC DEBT for /orchestrate-start (banked in the Log, NOT yet in LESSONS.md — write hot next round)
- **worker LESSON (next = L58):** the crossing gate is assembled by ONE tested worker helper; `config.healthSources` is NEVER bound when arming `providerTransport` (codifies L52 at the composition root); the boot-forward regression is pinned by a NON-gated pure `buildBackendsConfig` unit test BECAUSE the boot integration path is SOW_API-gated/skipped in preflight (a behavioral-only forward test guards nothing in CI). Future-TODO: the real health-source producer is an owner-provisioned arming input (→ #13).
- **providers LESSON (next = L7):** the real model transport is a thin injected-`fetch` pass-through — no status classify, no throw swallow, no sink (the executor owns those) — AND it hardens the egress wire it owns: `redirect:"manual"` (a cross-origin 3xx can't re-send the `x-api-key`, a vector the upstream egress-veto can't see, undici doesn't strip the custom header) + headers copied at the send boundary.
- **ARCHITECTURE §19.5 arming-runbook line:** "thread `config.providerTransport` → assemble the gate (`buildRealProviderTransportGate`) → provision key → bind real healthSource → set cap → enable; NEVER bind `config.healthSources` when arming (L52). Raw model I/O happens ONLY in `createRealModelHttpTransport`, dormant until the owner arms."
- These are captured verbatim in the IMPLEMENTATION_PLAN Log entry (2026-07-17 flip-wiring) so nothing is lost.

## 👥 ROSTER (you do NOT spawn — the LEAD does)
- **worker-impl4** — LIVE, idle post-#34 (fresh successor from the #34 cycle; owns `apps/worker`, `packages/db`, `packages/workflows`). Did #34 cleanly, security 0-findings.
- **integrations-impl** — LIVE, idle post-#35 (owns `packages/providers`, `packages/policy`, `packages/integrations`). Did #35 cleanly, caught + fixed the `redirect:"manual"` secret-egress finding. **This is the track that owns an Option-B agent-sdk extraction leg** (providers).
- **contract-impl / desktop-impl** — stood down.

## ⚙️ CYCLE RULE (lead's corrected standing rule — bake into your ops)
Per-slice context hygiene, effective now (owner directive after silent worker overflows):
1. **PRIMARY reliable signal = OBJECTIVE SLICE COUNT — hard cap ≤3 slices per worker** (cycle at the 3rd slice's post-commit idle boundary) **+ a QUALITATIVE self-flag** ("feeling heavy"). The numeric % is nice-to-have ONLY if an agent can actually read its status line — **NEVER fabricate it** (Agent-tool subagents are %-blind; that's why slice-count is primary).
2. Bake "report your context % (if readable) at Step-9" into every brief dispatch.
3. At the Step-9/post-commit idle boundary: >3 slices OR qualitative-heavy → **flag the LEAD** ("worker at N slices / heavy, cycle"); the lead spawns the fresh successor (reused name). You do NOT spawn.
4. **NEVER a mid-slice shutdown** — cycle only at a CONFIRMED post-commit idle boundary (the #34 orphan happened because the old worker approved a shutdown at its Step-2.5 pause; no work was lost only because the RED file persisted).
5. Apply to yourself: self-flag at round-close if heavy or ≥ a heavy round's worth of work.

## 🧾 DISCIPLINE (unchanged)
Per-slice /tdd: dispatch (brief path) → Step-2.5 (`APPROVED.`/`TWEAK:`/`ADD:`) → GREEN → 7.5 → Step-8 (security-reviewer = invariant; MANDATORY for any credential/egress/transport slice) → Step-9 commit-message-first, route findings/preconditions to **#13 verbatim** → Step-10 commit (impl stages only its files; separate packages → sequence commits, each stages its territory). **Push ROUND-CLOSE-ONLY.** codegraph MCP first for live code; Context7 / claude-api skill for SDK/wire shapes (never memory). Escalate to the LEAD only on the 4 categories or "ready for the enable." **Provision NOTHING; do NOT enable/flip.**

## ✅ WHAT'S DONE THIS SESSION
Flip-wiring round (18.18a `aa4b93e1` + 18.18b `67f6b87a` + round-close `d193fa14`) sealed + pushed; ready-for-enable delivered to the lead. Auth investigation DONE + findings delivered (owner A/B decision now pending). Briefs 132/133 committed. #13 metadata carries all 5 arming keys (`flip_arming_mechanics_CONFIRMED`, `cap_tuning_recommendation`, `arming_precondition_redirect_safety`, `arming_precondition_health_source_producer`, `arming_decision_budget_sibling_forward`). Next: the owner's A/B call (lead-relayed) → either the enable (A) or a Medium Option-B build round.
