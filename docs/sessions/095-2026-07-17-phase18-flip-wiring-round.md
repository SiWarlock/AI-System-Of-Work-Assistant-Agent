# Session 095 — Phase-18 FLIP-WIRING round (worker-impl4 + integrations-impl) — the last dormant build before the owner ENABLE

- **Date:** 2026-07-17
- **Phase:** 18 (§19.5 real ModelProvider) — FLIP-WIRING round (DORMANT / mock-tested / NO hard line crossed)
- **Track:** worker + providers-integrations (single-track `main`)
- **Predecessor session:** [094-2026-07-17-worker-impl4-cp3b-cp5b-crossing-prereq.md](094-2026-07-17-worker-impl4-cp3b-cp5b-crossing-prereq.md)
- **Successor session:** `096-2026-07-18-phase18-staged-enable-worker-impl.md` (the subscription-routing + staged-ENABLE arming round — 18.20/18.21/18.23, all dormant)
- **Commits:** 18.18b providers `67f6b87a` · 18.18a worker `aa4b93e1` · round-close docs `d193fa14`

## Why this session existed

The crossing-prerequisite round (session 094) landed all 7 CPs dormant. Everything the owner flip depends on was built EXCEPT the wire that actually carries an owner-set arming gate from `BootConfig` into the broker composition, and the real fetch client the owner injects. This round built those two legs — still DORMANT / byte-equivalent, NOT enabled (the ENABLE is the lead's owner-gated last step).

- **18.18b / providers (#35, integrations-impl)** — the real injected-`fetch` model `HttpTransport` (`createRealModelHttpTransport`).
- **18.18a / worker (#34, worker-impl4)** — forward `config.providerTransport` through `bootWorker`→`assembleBackends` + `buildRealProviderTransportGate` assembly helper.

## What was built

### 18.18b / providers — `createRealModelHttpTransport` (`67f6b87a`)

`createRealModelHttpTransport({fetch?})` implements the model-layer `HttpTransport` over an injected fetch (default: the Node global) — the real fetch client the owner injects into `config.providerTransport` at the crossing. Mock-fetch tested, NOT enabled (zero production caller; 18.18a injects it at owner ENABLE — L11-waivered).

**Thin pass-through by contract:** no status classification, no throw swallowing, no log sink — `executeCompletion` owns status→`ProviderError` mapping, throw classification, redaction. Hardens the egress wire it owns:
- `redirect:"manual"` at send for EVERY injected fetch (undici does NOT strip a custom `x-api-key` on a cross-origin 3xx; the redirect target is chosen inside fetch after url validation, invisible to the upstream egress veto) → a 3xx returns to the executor → `providerErrorFromStatus` → fail-closed (rule 7).
- headers copied at the send boundary (no injected fetch retains the caller's live secret map).
- AbortSignal forwarded (cooperative cancel on budget breach, §5.4).
- `RealHttpTransportDeps` has NO `logSink` field (compile-time rule-7 guarantee).

**Files:** `packages/providers/src/model/real-http-transport.ts` (NEW), `packages/providers/src/index.ts` (export), `packages/providers/test/model/real-http-transport.test.ts` (NEW, 8 tests).

**Security-reviewer:** surfaced a MEDIUM cross-origin-redirect secret re-send (the default global fetch inherits `redirect:"follow"`) → FIXED in-slice (`redirect:"manual"`). code-quality-reviewer: all findings fixed in-slice.

### 18.18a / worker — providerTransport forward + gate assembly (`aa4b93e1`)

Two-part worker leg, both DORMANT / byte-equivalent:

1. **Forward-only fix.** `bootWorker`'s `backendsConfig` reconstruction silently DROPPED `config.providerTransport` (the field is inherited — `BootConfig extends BackendsConfig` — but was never copied), so an owner-set gate never reached `selectProviderRunner`/`selectHealthSources`. Extract a pure `buildBackendsConfig(config): BackendsConfig` seam + forward `providerTransport` via conditional-spread. Unset ⇒ the key is ABSENT ⇒ `backendsConfig` byte-equivalent ⇒ the deterministic stub runner (shipped default unchanged).
2. **`buildRealProviderTransportGate(deps)`** assembles the owner's crossing bundle `{ enabled:true, make:()=>createRealProviderRunner(runnerDeps), healthSource? }` — `make` is a THUNK (`createRealProviderRunner` not invoked at build; factory-spy 0×@build, 1×@`make`). The real `healthSource` rides `gate.healthSource` ONLY (L52) — `config.healthSources` is dropped entirely, so arming can never bind a green source; omitted `healthSource` ⇒ `selectHealthSources` → `UNAVAILABLE_HEALTH_SOURCES` (fail-closed deny), never the green stub.

**Files:** `apps/worker/src/boot.ts` (buildBackendsConfig seam + forward), `apps/worker/src/composition/real-provider-transport-gate.ts` (NEW), `apps/worker/test/composition/buildBackendsConfig.test.ts` (NEW, 3 tests), `apps/worker/test/composition/real-provider-transport-gate.test.ts` (NEW, 4 tests).

**Finding-F:** `copilotRealModel`/`copilotAgentMode` (the separate agent-sdk `meeting.close` factory) untouched — `providerTransport` arms raw-model routes only. Forward regression pinned by a NON-gated `buildBackendsConfig` unit test (the boot integration path is SOW_API-gated/skipped-in-preflight, so a behavioral-only test guards nothing in CI). security-reviewer: 0 findings; code-quality: an L52 docstring fix in-slice.

## Territory / layer note

The `{enabled,make,healthSource}` bundle-assembly is WORKER-side: the `{providers,integrations} → policy → {domain,contracts}` layer rule forbids a `providers→worker` import, so providers owns only the reusable transport (`createRealModelHttpTransport`) and the worker owns the composition that binds it into a `ProviderTransportGate`.

## Decisions made / routed

1. **Owner A/B decision (auth investigation, load-bearing):** extraction runs on the Claude **SUBSCRIPTION** (`createClaudeSubscriptionCompletion` — Agent SDK `query()` on the local `claude` login, no credential; the worker runs `ANTHROPIC_API_KEY` UNSET) — NOT a raw-API key. The raw `x-api-key` `ModelProviderPort` (`createRealModelHttpTransport`) is the fallback for isolated-billing / non-Claude providers. Both converge on `AgentResult.candidateOutput`, so GATE-1 (candidate-schema gate + `validateNoInference`/REQ-F-017) is shape-agnostic and Option B satisfies the same invariants.
2. **NEXT round = a Medium build to route the extraction legs through the subscription synthesis** — reuse the GATE-1 `agent_extraction` schema + gates; re-point the COST-1 cap to the SDK's native `maxBudgetUsd`; bind the currently-fail-closed runtime branch (`provider-runner.ts:271-274`). Owner-gated go; provision/enable NOTHING.
3. All #13-routed arming preconditions unchanged (`arming_precondition_redirect_safety`, `arming_precondition_health_source_producer`, `arming_decision_budget_sibling_forward`).

## Doc hot-routing (flushed this round → docs commit `05d7d008`+)

- worker **Lesson 58** (assemble the crossing bundle in one tested worker helper; forward the arming gate through the boot reconstruction seam; pin the forward NON-gated).
- providers **Lesson 7** (the real model `HttpTransport` = a thin injected-`fetch` pass-through that owns its egress wire, `redirect:"manual"`).
- **ARCHITECTURE §19.5** flip-wiring build note + arming-runbook line; **§7** the owner subscription decision.

## Suites

Worker 1700/0 · providers green · repo-wide typecheck 20/20 · lint clean. NO hard line crossed — byte-equivalent/dormant until the owner arms `providerTransport`.
