# Session 096 — Phase-18 subscription routing + staged-ENABLE arming surface (worker-impl)

- **Date:** 2026-07-18
- **Phase:** 18 (§19.5 real ModelProvider — Option B, Claude subscription extraction)
- **Role:** implementer — worker (`apps/worker/`)
- **Team:** `session-4f4687dd` — lead + `main-orchestrator` + worker-impl (this) + providers-impl (18.19/18.22)
- **Predecessor:** `095-2026-07-17-phase18-flip-wiring-round.md`
- **Successor:** _(the step-6 wiring slice — a fresh worker-impl per `docs/runbooks/phase-18-subscription-enable-decision.md`)_

## Why this session existed
Owner chose **Option B** — extraction runs on the Claude **subscription** (Agent SDK on the local `claude` login; worker runs `ANTHROPIC_API_KEY` UNSET). This session built the worker legs of the subscription-extraction path + the staged-ENABLE arming surface (owner GO on steps 0–5), all DORMANT — nothing arms (the gate flip = owner step 6, first spend = step 7, remain the HARD STOP).

## What was built (4 slices, all dormant/byte-equivalent)

### 18.20 — subscription-extraction runtime runner (`7ab16dcb`)
- **Files created:** `apps/worker/src/composition/subscription-extraction-runner.ts` (+ test) — the runtime-branch runner: injected `ExtractionContentResolver` seam + capability-keyed request assembly (`buildExtractionCompletionRequest`) + COST-1→SDK `maxBudgetUsd` by presence + full `CompletionError→GateDeny` taxonomy (KIND-only, auth enforced-terminal) + TOTAL never-throws; candidate pass-through UNVALIDATED (rule 2).
- **Files modified:** `provider-runner.ts` — optional `subscription?` on `RealProviderRunnerDeps` + runtime-branch selection; threads through `buildRealProviderTransportGate` verbatim (zero composition-root edit). Defense-in-depth `egressClass==="cloud"` route guard added in review.

### 18.21 — real `ExtractionContentResolver` (`706334a2`)
- **Files created:** `real-extraction-content-resolver.ts` (+ test) — derefs the job's `contextRefs` `refKind:"source"` entry (EXACTLY-ONE, no-guess) → `sourceId`, reads `SourceEnvelope.body` via the existing `createDurableParkedReader`; **WS-8 read-back re-gate** (`envelope.workspaceId===job.workspaceId`, precedes body access); fail-closed code-only faults, never `ok("")`, TOTAL.

### 18.23a — arming surface: route knob + rule-5 proof + auth guard (`58ea6100`, SAFETY)
- **Files created:** `extraction-route-gate.ts` (`selectExtractionRoute`, AND-locked STRICT `===true`, byte-identical local default) + `subscription-auth-guard.ts` (`assertSubscriptionAuthEnv`, explicit extensible `SUBSCRIPTION_SHADOWING_ENV_KEYS`, fail-closed code-only) + their tests.
- **Files modified:** `egress-veto-assembled.test.ts` — the **rule-5 verification**: employer-raw + ack-OFF + cloud `{runtime}` ⇒ DENY `EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED` at `egress_veto` (run leg unreached) + a non-vacuity positive control (ack ON resolves past). security-reviewer CLEAN (0).

### 18.23b — arming surface: cost cap + health wrap (`e46160f4`, deny-only)
- **Files created:** `subscription-health-sources.ts` (+ test) — `createSubscriptionHealthSources` wraps the 18.22 verdict into `HealthGateSources` fail-closed (no false-green, L52; rides `gate.healthSource`).
- **Files modified:** `budget-ledger.ts` (`DEFAULT_BUDGET_DEFAULTS`) + `config/providers.defaults.json` (§budgets) — the extraction cost cap ($1.5/300 for `source.process`+`meeting.close`), moved IDENTICALLY (the drift-guard `default_budget_defaults_match_config` stays green); deny-only, L54 no-new-deny; placeholders. + `budget-cost-cap.test.ts` (+2).

## Decisions made
- **Content seam = injected `ExtractionContentResolver`** (18.20), UNBOUND until ENABLE; real resolver (18.21) derefs a `contextRefs` `refKind:"source"` convention (one concrete member of the open ContextRef taxonomy arch_gap), EXACTLY-ONE (no-guess, WS-8).
- **Arming coupling** — `selectExtractionRoute(armed)` reads the SAME `providerTransport` gate predicate `selectProviderRunner` reads (one flip, no split-brain, L52).
- **Auth guard = pure helper, WAIVERED** (boot binds at step 6, not wired this round — L11 don't-wire-dormant-on-dormant).
- **18.23 split A/B** — A = route/egress/auth (SAFETY); B = cost cap/health wrap (deny-only).
- **Config seed edit** — `config/providers.defaults.json §budgets` is worker-consumed config coupled to the constant by the drift-guard; orchestrator confirmed it's worker territory, moved with the constant.

## Decisions explicitly NOT made (deferred to the #13 ENABLE, step 6/7)
- No arming: `config.providerTransport` unset, route knob unflipped, no real spend, no API key provisioned.
- The full `SUBSCRIPTION_SHADOWING_ENV_KEYS` set (beyond `ANTHROPIC_API_KEY`) — enumerate + confirm against live SDK docs at flip (a missed var = silent fail-open).
- Single-sourcing `LOCAL_EXTRACTION_ROUTE` with boot.ts:1094 — deferred to the step-6 binding (drift inactive while unwired).
- Boot wiring of `selectExtractionRoute`/`assertSubscriptionAuthEnv`/`createSubscriptionHealthSources`/the real `ContentResolver` — the step-6 flip.

## TDD compliance
**Clean.** All 4 slices strict TDD — failing test written first, confirmed RED for the right reason, then GREEN. Review-driven additions (the egressClass guard, auth-terminal enforcement, exactly-one deref, WS-8 re-gate, positive control) each got a RED test before the fix.

## Cross-doc invariant audit
**No contract-model field changed** this session — every slice is an internal worker seam (`ExtractionContentResolver`/`ContentResolutionFault`, `RealProviderRunnerDeps.subscription?`, `selectExtractionRoute`, `assertSubscriptionAuthEnv`, `createSubscriptionHealthSources`, budget values). `ProviderRoute`/`ProviderMatrix`/`AgentJob`/`SourceEnvelope`/`ContextRef` unchanged. Flagged NONE at each Step 9; orchestrator confirmed. No drift.

## Reachability
- **18.20 runner** — reachable from `createRealProviderRunner`'s runtime branch (armed path); WAIVERED (L11) — no `{runtime}` route in shipped `capabilityDefaults`.
- **18.21 resolver · 18.23a route knob + auth guard · 18.23b health wrap** — WAIVERED (L11), 0 production callers (codegraph-confirmed); bind at the owner ENABLE (step 6).
- **18.23a rule-5 test** — drives the REAL `assembleBackends({})` broker (a test entry point).
- **18.23b cost cap** — LIVE deny-only via `DEFAULT_BUDGET_DEFAULTS`→`assembleBackends` (ships ON, L44).
No tested-but-silently-unwired gaps: every dormant helper is a documented owner-ENABLE binding point.

## Open follow-ups (the #13 ENABLE ledger — orchestrator routes to plan)
1. Enumerate + confirm the full `SUBSCRIPTION_SHADOWING_ENV_KEYS` set (live SDK docs) + wire `assertSubscriptionAuthEnv` fail-closed at boot.
2. Single-source `LOCAL_EXTRACTION_ROUTE` with boot.ts:1094 + `DEFAULT_ROUTE` (L37).
3. Memoize the `checkReachable` probe (short-TTL) at the health-source binding (double-probe).
4. Re-confirm the $1.5 cost + 300s runtime placeholders + `DEFAULT_EXTRACTION_MODEL` id at the flip.
5. The ENABLE caller populates a `{refKind:"source", ref:sourceId}` ContextRef when assembling the extraction job; the cloud `{runtime}` route re-triggers the egress veto (prove fail-closed for employer-raw before ENABLE).
6. Boot wires all four helpers at step 6, then HOLD at the arm for the owner env/login confirm.
