# Session 097 — Phase-18 subscription ARM code-complete (18.24 + 18.25 STEP-1 + detectLogin); HELD before the irreversible run

- **Date:** 2026-07-18
- **Phase:** 18 (§19.5 Real Model Transport & Intelligence Legs) — the owner ENABLE / hard-line crossing (real cloud egress + real ~$0.45 spend, Option B / subscription)
- **Role / track:** worker-impl (implementer), single-track `main`, team `session-4f4687dd`
- **Predecessor:** [`096-2026-07-18-phase18-staged-enable-worker-impl.md`](096-2026-07-18-phase18-staged-enable-worker-impl.md)
- **Successor:** _(the FRESH worker-impl that executes the ARM + RUN — see "Open follow-ups → ARM-EXECUTION HANDOFF")_
- **Cycle reason:** worker-impl at 77% [ACTION] on the canonical /context-check heartbeat → cycle at the next clean break. This IS the clean break: the arm is **code-complete, before the irreversible real-spend run**.

## Why this session existed

Two things: (1) build the Phase-18 step-6 subscription arming wiring (18.24), and (2) — after the owner GO — build the arm's remaining machinery (18.25 STEP-1 + the login detector) so the owner ENABLE (steps 6–7: arm + first real extraction) becomes executable. **The irreversible arm+run was NOT executed this session** — it is deliberately handed to a fresh, focused context (careful-over-fast for the hard line).

## What was built (all committed DORMANT / byte-equivalent; NO hard line crossed; NOT pushed — mid-crossing)

**18.24 — step-6 subscription arming wiring (2 commits):**
- `65dd9e5f` (18.24a, pure helpers): `subscription-auth-guard.ts` shadowing set 1→**8 vars** (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, ANTHROPIC_BASE_URL, ANTHROPIC_API_URL, HTTP_PROXY, HTTPS_PROXY); `provider-runner.ts` extract `isProviderTransportArmed` type-guard (the SINGLE AND-lock predicate); NEW `subscription-extraction-arming.ts` — `gateSubscriptionExtraction` (owner gate builder, memoized health) + `resolveSubscriptionArming` (degrade-not-crash on a shadowing-env refusal, L52).
- `c9361092` (18.24b, composition-root): `boot.ts` `withSubscriptionExtractionArming` co-gate + bootWorker degrade-arm wiring + single-sourced `capabilityDefaults["source.process"]` route; `buildActivities.ts` `SourceIngestionParams.contextRefs` + threading (WS-8, routing-bound id); `source-extraction.ts` `DEFAULT_ROUTE` single-sourced (3rd copy unified, item iv).

**18.25 STEP-1 — the deferred FINDING piece (the eager-consumption ordering) — `7e892be3`:**
- `real-extraction-content-resolver.ts`: `ReaderHolder` + `createReaderHolder` + `createLateBoundParkedReader` — a `ParkedSourceReader` that delegates to `holder.reader` at READ time (per-job); unfilled ⇒ fail-closed `source_unavailable` (never `ok("")`, never throws).
- `subscription-extraction-runner.ts`: `createSubscriptionOnlyProviderRunner` — serves the cloud `{runtime}` route via `createSubscriptionExtractionRunner`, **FAILS CLOSED on a `provider` route** (structural raw-API-route denial; no 5-provider registry ⇒ NONE of the post-`assembleBackends` `controller`/`now`/`transport` deps — only the reader is late-bound).
- `subscription-extraction-arming.ts`: `gateSubscriptionOnlyExtraction` (subscription-only gate builder) + `buildSubscriptionArmWiring` (wires the content resolver over the late-bound reader holder).
- `boot.ts`: `config.subscriptionArm` opt-in ⇒ bootWorker constructs the arm gate → `assembleBackends` → **fills the holder POST-assembly ONLY on `effectiveArmed`**; `FAIL_CLOSED_REACHABILITY` default; a LOUD warn on the both-transports-set mis-config.

**18.25 arm — the login detector — `dd347b3c`:**
- NEW `claude-keychain-login.ts`: `detectClaudeKeychainLogin` — the spend-free macOS Keychain PRESENCE probe (`security find-generic-password -s "Claude Code-credentials"`, **NO `-w`** — never reads the value, rule 7; absolute bin, args-array/no-shell, 5s timeout; fail-closed/total). The concrete `detectLogin` the ARM injects into 18.26's `probeSubscriptionReachability`.

**(providers-impl, not mine, this round):** `42a7af14` 18.26 `probeSubscriptionReachability` ({detectLogin, resolveSdk}; spend-free; DEFAULT file-path `detectLogin` fails closed on macOS by design).

## Decisions made

- **The FINDING was broader than "the reader is post-assembly":** the whole `createRealProviderRunner` registry (`controller`/`now`/`transport`) is post-`assembleBackends`, but the gate is consumed EAGERLY at `backends.ts:809`. Chose the **subscription-only runner** (Option A, orchestrator-approved) — no registry ⇒ only the reader needs the holder late-bind, AND the arm structurally can't serve a raw-API cloud route (a safety narrowing). Not the fragile 3-holder wrap of `createRealProviderRunner`.
- **The single arming signal is `config.providerTransport`** (the SAME `isProviderTransportArmed` predicate `selectProviderRunner` reads — no split-brain). The 18.25 arm opt-in (`config.subscriptionArm`) makes bootWorker CONSTRUCT that gate (with the late-bound reader) — solving the ordering.
- **The auth-guard DEGRADES, never crashes** (#2 TWEAK): armed + a shadowing var ⇒ strip the transport (LOCAL/stub, zero cloud extraction) + surface a code-only fault — never a boot-throw (L52).
- **The real `checkReachable` is layer-split:** the spend-free reachability CONTRACT is providers (18.26); the concrete macOS `detectLogin` primitive is the arm's (worker, `detectClaudeKeychainLogin`). The DEFAULT is fail-closed (HEALTH UNAVAILABLE) until the real detector is injected.
- **The Claude subscription login lives in the macOS Keychain** under service `Claude Code-credentials` (account = OS user `dreddy`) — determined by a presence probe (no value read). The default file-path detector fails closed on macOS (correct).

## Decisions explicitly NOT made (deferred to the fresh worker-impl)

- **THE ARM + THE RUN were NOT executed.** The arm (controlled boot with `config.subscriptionArm` set) + CP2 + the ONE real extraction are the irreversible hard-line crossing — deliberately handed to a fresh, focused context under lead+owner authorization. `config.subscriptionArm` is UNSET in the shipped default (byte-equivalent).
- **The model-id was NOT re-verified** — `DEFAULT_EXTRACTION_MODEL` = "claude-sonnet-5" is a placeholder; the successor RE-VERIFIES it vs the live Agent-SDK catalog (Context7) IMMEDIATELY before the run.

## TDD compliance

**CLEAN.** Every slice was test-first (RED → GREEN) and dual-reviewed: 18.24a/b, 18.25 STEP-1, `detectClaudeKeychainLogin`. Reviews: 18.24 security 6/6 PASS; 18.25 STEP-1 security 6/6 PASS + code-quality 0 hi/med (2 fixed in-slice); `detectClaudeKeychainLogin` security CLEAN (0 findings). No TDD violations, no safety-critical skips. worker suite **1793/0** (35 skip); repo typecheck **20/20**; lint clean.

## Cross-doc invariants

**No cross-doc invariant change this session** (confirmed at each Step-9). `config.subscriptionArm` is worker-internal `BootConfig`; `SourceIngestionParams.contextRefs` is worker-internal `ProofSpineParams`; `ProviderRoute`/`ProviderMatrix`/`AgentJob`/`ContextRef` schemas unchanged. No `ARCHITECTURE.md` edit owed.

## Reachability

- 18.24 seams (`resolveSubscriptionArming`, `withSubscriptionExtractionArming`, `isProviderTransportArmed`, 8-var guard, single-source route, `SourceIngestionParams.contextRefs`) — WIRED to production (`bootWorker` · `buildAutoIngestProofSpineParams` · `buildProofSpineActivities`).
- 18.25 arm wiring (`createSubscriptionOnlyProviderRunner`, `gateSubscriptionOnlyExtraction`, `buildSubscriptionArmWiring`, `config.subscriptionArm` construction) + `detectClaudeKeychainLogin` — **reachability-WAIVERED (L11)**: no production caller; the owner ARM injects `config.subscriptionArm` at the flip. The late-bind ASSEMBLY PROOF (a unit test) exercises the whole chain (runner denies pre-fill w/ zero dispatch, resolves post-fill) — the `-live`-equivalent without Temporal. No tested-but-unwired gap that a later slice removed.

## Open follow-ups

### ⭐ ARM-EXECUTION HANDOFF (the critical one — for the fresh worker-impl, under lead+owner authorization)

**Authorization state:** the LEAD DIRECTLY (first-hand) authorized THIS crossing (owner reaffirmed): real cloud egress + real ~$0.45 spend, Option B / subscription, benign NON-employer content, ONE run. Implementer-executes; arm → CP2 pause → the ONE run only after the **owner-acked run-release** (the orchestrator's verbatim relay of the lead's post-CP2 ack). HALT-not-force at every gate.

**Pre-arm gates — ALL CONFIRMED (mine + lead):** 11 shadowing vars unset · no `apiKeyHelper` in any Claude Code settings · shell profiles clean (no export) · `anthropic_api_key` Keychain entry BENIGN (third-party `ClaudeClipboardCleaner`, not loaded into the worker env) · `/login` refreshed · worker-ACL exit-0 (Node `spawnSync` mimic, prompt-free). The armed-boot `assertSubscriptionAuthEnv` over `process.env` is the DEFINITIVE gate.

**The 6-step execution:**
1. **RE-VERIFY the model-id:** `DEFAULT_EXTRACTION_MODEL` ("claude-sonnet-5", `extraction-route-gate.ts`) vs the LIVE Agent-SDK catalog (Context7 `/nothflare/claude-agent-sdk-docs` or the claude-api skill) — a stale id folds to a typed `CompletionError` (safe) but confirm.
2. **ARM** = a CONTROLLED boot with `config.subscriptionArm = { enabled:true, model:<confirmed>, checkReachable: () => probeSubscriptionReachability({ detectLogin: detectClaudeKeychainLogin }) }` + the default real `createClaudeSubscriptionCompletion` + a BENIGN NON-EMPLOYER workspace + a benign parked source. (Shipped default stays unset — controlled arm boot, not a prod flip.)
3. **CP2 (spend-free — NO job runs):** verify the 4 legs — (a) `assertSubscriptionAuthEnv(armed)` fires+PASSES; (b) HEALTH AVAILABLE (memoized probe → `detectClaudeKeychainLogin` present ✓ AND `resolveAgentSdk` resolvable → healthy, NOT UNAVAILABLE); (c) route LIVE (`source.process` = cloud `{runtime}` via `withSubscriptionExtractionArming`); (d) rule-5 fail-closed vs the LIVE armed route (employer-raw + ackOFF ⇒ DENY). **HALT + report on ANY fail.**
4. **CP2 → orchestrator → HARD PAUSE** for the owner-acked run-release.
5. **RUN** = ONE real `source.process` extraction (benign non-employer ws) → GATE-1 candidate gate (`validateNoInference`/REQ-F-017) → real note via KnowledgeWriter → capture the REAL metered `$` + eval. ⚠ a one-time owner **"Allow"** macOS Keychain prompt at the SDK's first token READ is EXPECTED (owner pre-warned) — NOT a failure (CP2 presence stays prompt-free; the prompt is the SDK's value read at the run). **ONE run only.**
6. **CP3 → orchestrator:** the note + the REAL metered `$` + the eval verdict.

**If the worker-process Keychain presence-access ever false-negatives** (it did NOT in the mimic): loop the orchestrator → lead → owner drives a Keychain ACL grant / authorized-helper path (an owner+lead action).

### Step-9 flags (already routed hot; captured for the orchestrator's §19.5 arch note + Lesson candidates at the crossing-round seal)
- **Arch note (§19.5):** the arm mechanics = subscription-only runner (no registry) + reader-holder late-bind (solves `backends.ts:809` eager consumption) + `config.subscriptionArm` opt-in + the spend-free `detectClaudeKeychainLogin` login detector.
- **Worker Lesson candidates:** (a) the single-signal arm + degrade-not-crash + AND-locked co-gate (18.24); (b) the eager-consumption reader-holder late-bind + subscription-only runner (18.25); (c) the spend-free presence-only Keychain login probe (no `-w`, mirrors Lesson 10).
- **Future TODOs (#13 ENABLE):** a boot-wiring parity assertion for the fill guard (L58); a future `ProviderTransportGate`-shape change updates BOTH gate builders; the memoize TTL / model-id re-confirm at flip.
- **Deferred lows:** `Date.now()` ms clock at the composition root (config.now is ISO — wrong type); the both-transports-set precedence (now warned).

## How to use what was built

The successor arms via `config.subscriptionArm` (see the 6-step handoff). Everything is DORMANT until then — the shipped worker is byte-equivalent (`config.subscriptionArm` unset ⇒ no gate, no holder fill, no cloud route, zero egress/spend; `ANTHROPIC_API_KEY` UNSET).
