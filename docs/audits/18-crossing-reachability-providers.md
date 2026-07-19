# Reachability audit — Phase-18 SUBSCRIPTION ENABLE crossing · `packages/providers`

- **Gate:** `/phase-exit 18` — phase-exit reachability gate.
- **Audit surface:** crossing diff ONLY — `git range 6d6d94bd..HEAD` (HEAD `7180a49a`, tip commit `5427898`), NOT the safe-build 18.1–18.10 work.
- **Area:** `packages/providers` (providers-integrations track). Entry points for this area = the barrel `packages/providers/src/index.ts` (package exports) consumed by `apps/worker/**` composition + the live broker `createBroker` assembled in `apps/worker/src/composition/backends.ts:791` (`assembleBackends`).
- **Method:** codegraph `codegraph_callers` + graphify `query`/`path` for orientation, confirmed with targeted reads. Test-only (`test/**`, `*.test.ts`) and fixture references do NOT count as reachable.
- **Waiver basis:** dormant-till-arming exports are reachability-WAIVERED per **L11** (real-I/O / owner-provisioning gate ⇒ default-absent inert, byte-equivalent; the owner arm injects the concrete input at ENABLE). A waiver is valid ONLY if a committed injection SEAM exists that the owner arm activates. A waived export with NO seam anywhere = dead = BLOCKED.

## Result

**packages/providers — 9 crossing exports of interest audited (of 20 changed source files)**
- REACHABLE (live, shipped-default path): 2 classes — `conservativeProviderPricing` + the modified live broker surface (broker/normalizer/schema-gate `agent_extraction` extensions)
- WAIVED + BOUND (L11, committed injection seam confirmed): 7
- UNREACHABLE / dead (no binding site): **0**

## Per-symbol classification

### LIVE-reachable (not merely waived — on the shipped default path)

- **`packages/providers/src/broker/pricing.ts:34` · `conservativeProviderPricing` (18.15a)**
  Referenced from: `apps/worker/src/composition/budget-ledger.ts:122` → builds `DEFAULT_PROVIDER_PRICING` → threaded into the live budget gate at `apps/worker/src/composition/backends.ts:814` (`pricing: config.budgetPricing ?? DEFAULT_PROVIDER_PRICING`) inside `assembleBackends`.
  Verdict: **REACHABLE.** Deny-only cost cap ships ON (worker L44/L54) — this is a genuine shipped-default call path, no arm required. `conservativeProviderPricing` has no direct codegraph caller only because it is invoked at module-init to construct a const; the const is live-consumed.

- **`packages/providers/src/broker/broker.ts` · `BrokerCandidate` union + `agent_extraction` producer (18.12a); `output-normalizer.ts` normalizer branch; `schema-gate.ts` change**
  The broker (`createBroker`) is assembled live at `backends.ts:791`. These are modifications to already-reachable live symbols; the crossing adds `agent_extraction` as a union member + normalizer/schema-gate handling.
  Verdict: **REACHABLE** (live broker). Note: the `agent_extraction` candidate KIND is only *produced* on the owner-armed extraction path (co-gated with the worker `CANDIDATE_MODEL_SCHEMAS` parser + `outputSchemaId` flip per worker L64), but the broker plumbing that carries it is live-reachable.

### WAIVED + BOUND (L11 — committed injection seam confirmed; activates on the owner arm)

- **`packages/providers/src/model/extraction-completion-request.ts:44` · `buildExtractionCompletionRequest` (18.19)** — also `DEFAULT_EXTRACTION_BETAS:28`, `ExtractionCompletionOptions:31`.
  Binding site: **`apps/worker/src/composition/subscription-extraction-runner.ts:201`** (`createSubscriptionExtractionRunner` calls it). That runner is bound on the armed subscription path via `buildRealProviderTransportGate` (`apps/worker/src/composition/subscription-extraction-arming.ts:154`).
  Verdict: **WAIVED (L11), NOT an orphan** — real committed caller on the armed path.

- **`packages/providers/src/model/extraction-request.ts:105` · `buildMeetingExtractionRequest` (18.12a) + `:135` `buildSourceExtractionRequest` (18.13a)** — plus their internal helpers exported for test: `MEETING_EXTRACTION_PROMPT:30`, `SchemaResolver:42`, `registrySchemaResolver:53`, `ClaudeExtractionOutputConfig:59`, `ExtractionRequestFault:68`, `buildClaudeExtractionOutputConfig:79`, `AgentExtractionRequest:95`, `SOURCE_EXTRACTION_PROMPT:122`.
  Binding site: **`apps/worker/src/composition/subscription-extraction-runner.ts:36-37` (import) + `:167-168`** (`buildMeetingExtractionRequest(job)` / `buildSourceExtractionRequest(job)`). The helper exports (`buildClaudeExtractionOutputConfig`, `registrySchemaResolver`, prompts, `AgentExtractionRequest`) are consumed transitively INSIDE the two bound builders.
  Verdict: **WAIVED (L11), NOT orphans** — the two builders have a real committed caller on the armed path; the rest are transitively reachable through them.

- **`packages/providers/src/model/subscription-health-probe.ts:56` · `probeClaudeSubscriptionHealth` (18.22)** — plus `SubscriptionReachability:22`, `SubscriptionReachabilityCheck:28`, `SubscriptionHealthProbeDeps:31`, `SubscriptionHealthReason:36`, `SubscriptionHealthVerdict:45`.
  Binding site: **`apps/worker/src/composition/subscription-extraction-arming.ts:137` and `:200`** (`probeClaudeSubscriptionHealth({ checkReachable: deps.checkReachable })` — committed call, not a comment). Wrapped into `HealthGateSources` on the armed path (L52/worker L9).
  Verdict: **WAIVED (L11), NOT an orphan** — committed caller in the arming composition.

- **`packages/providers/src/model/subscription-reachability-probe.ts:47` · `probeSubscriptionReachability` (18.26)** — plus its exported default deps `DEFAULT_CLAUDE_LOGIN_PATH:67`, `PathExists:70`, `detectClaudeLogin:78`, `ModuleResolver:90`, `resolveAgentSdk:100`, and `SubscriptionReachabilityProbeDeps:27`.
  Binding SEAM (committed): **`config.subscriptionArm.checkReachable`** — declared at `apps/worker/src/boot.ts:280-284`, wired into `buildSubscriptionArmWiring` at `boot.ts:1301` (`config.subscriptionArm?.checkReachable ?? FAIL_CLOSED_REACHABILITY`). The exact arm-time injection is documented in committed code at **`apps/worker/src/composition/claude-keychain-login.ts:15-16`**: `checkReachable = () => probeSubscriptionReachability({ detectLogin: detectClaudeKeychainLogin })`. The owner-supplied `detectClaudeKeychainLogin` (committed, `claude-keychain-login.ts:50`) overrides the macOS-fail-closed default `detectClaudeLogin`; `resolveAgentSdk` is the committed default `resolveSdk`.
  Verdict: **WAIVED (L11), NOT an orphan** — this is the same owner-injected-config-seam pattern the gate explicitly accepts (`config.subscriptionArm.checkReachable`). Seam committed + injection point named in-code. The exported default primitives are `probeSubscriptionReachability`'s own defaults, transitively reachable through it.

- **`packages/providers/src/model/real-http-transport.ts:68` · `createRealModelHttpTransport` (18.18b)** — plus `FetchResponseLike:35`, `FetchLike:42`, `RealHttpTransportDeps:59`.
  Binding SEAM (committed): the raw-API **FALLBACK** transport. Consumed as `RealProviderRunnerDeps.transport` (an `HttpTransport`), forwarded by **`apps/worker/src/composition/real-provider-transport-gate.ts:47` (`buildRealProviderTransportGate`, dep at `:34`)** into `config.providerTransport` (the 18.24 raw-API arm). The injection point is named in committed code at **`packages/providers/src/model/real-http-transport.ts:24-26`** ("NO production call-site until the worker gate-assembly helper injects this at the owner ENABLE. Reachability-WAIVERED (L11)") and in providers **L7** ("18.18a injects it at ENABLE").
  Verdict: **WAIVED (L11), NOT an orphan.** Caveat flagged: `createRealModelHttpTransport` currently appears only in its own test (`packages/providers/test/model/real-http-transport.test.ts`) — the weakest binding in this diff, because the owner constructs it at arm-time and passes it as `runnerDeps.transport` (no committed call-expression). It serves the raw-API-KEY fallback the owner has explicitly chosen NOT to provision (subscription/Option B is primary — the subscription path does not use `HttpTransport` at all; it egresses via the Agent SDK runtime). The committed seam + named injection point are identical in kind to the accepted `config.subscriptionArm.checkReachable` pattern, so it is a valid L11 waiver, not a dead export. Recommend the orchestrator confirm the raw-API arm remains a named Future-TODO (not a silently-dropped path) if the fallback is ever exercised.

## Dead / orphaned exports (non-waived, no binding site)

**None.** Every new/changed export in the crossing diff is either live-reachable on the shipped default path or a valid L11 waiver with a committed injection seam.

## Summary for orchestrator

- Wiring tasks recommended: **0** — no non-waived dead exports.
- Waived exports (7) all have a confirmed committed binding site/seam that activates on the owner arm (subscription-extraction-runner, subscription-extraction-arming, `config.subscriptionArm.checkReachable`, `buildRealProviderTransportGate`/`config.providerTransport`).
- Barrel (18.19) correctly surfaces the CP-2/CP-3 extraction-request builders + the completion assembler + both probes — `packages/providers/src/index.ts` re-exports `./model/extraction-request`, `./model/extraction-completion-request`, `./model/subscription-health-probe`, `./model/subscription-reachability-probe`, `./model/real-http-transport`, `./broker/pricing`; the worker imports resolve against these.
- One caveat to carry forward (not a blocker): `createRealModelHttpTransport` (18.18b) is the raw-API FALLBACK transport, dormant for a path the owner is deliberately not provisioning; its seam is committed but its only current reference is its own test. Valid L11 waiver.

## Phase-exit gate: **CLEAR** (0 unreachable / 0 dead exports)
