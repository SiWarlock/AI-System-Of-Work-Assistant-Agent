# Session 099 — Phase-18 subscription crossing: the three providers legs

- **Date:** 2026-07-18
- **Phase:** 18 (§19.5 real ModelProvider & Intelligence Legs — the Option-B Claude-subscription crossing)
- **Role:** `providers-impl` (implementer, `packages/providers/`) — single-track `main`, team `session-4f4687dd`
- **Predecessor session:** [098-2026-07-18-phase18-subscription-enable-golive-worker-impl.md](098-2026-07-18-phase18-subscription-enable-golive-worker-impl.md)
- **Successor session:** _(next providers session; backlink to be added there)_

## Why this session existed
The Phase-18 owner ENABLE crossing (Option B — real extraction on the Claude **subscription**, `ANTHROPIC_API_KEY` UNSET) needed three **providers-layer** primitives that earlier safe-build slices had stubbed/injected but never built. All three are pure/dormant (no model call, no hard line) and feed worker-side consumers that wire them into the live path at the arm. The maiden real subscription extraction succeeded after these landed (origin/main `7180a49a`, per the lead).

## What was built

### Files created
- `packages/providers/src/model/extraction-completion-request.ts` (**18.19**) — pure `buildExtractionCompletionRequest(req, content, opts)` mapping a built `AgentExtractionRequest` (CP-2/CP-3) + resolved content → a Claude-subscription `CompletionRequest` (prompt→systemPrompt, content→userPrompt, inline `sow:agent-extraction` schema→outputSchema, model→model); enforced `maxCostUsd` threaded by **presence** (`!== undefined`) → the SDK-native `maxBudgetUsd` (COST-1 re-point for the runtime route). Exports `DEFAULT_EXTRACTION_BETAS = ["context-1m-2025-08-07"]`.
- `packages/providers/src/model/subscription-health-probe.ts` (**18.22**) — pure/total/fail-closed `probeClaudeSubscriptionHealth({checkReachable})` → `SubscriptionHealthVerdict {reachable, reason?}`; strict `=== true` on every dimension, whole fold in one `try` (a hostile result-getter can't break totality); closed reason set `{login_absent, unreachable, check_ambiguous, check_threw}` (rule-7 code-only).
- `packages/providers/src/model/subscription-reachability-probe.ts` (**18.26**) — spend-free `probeSubscriptionReachability(deps?)` → `SubscriptionReachability {loginPresent, sdkReachable}` + concrete primitives `detectClaudeLogin(path?, exists?)` (fs **existence only**, rule-7) and `resolveAgentSdk(resolve?)` (module resolution ≠ import), plus `DEFAULT_CLAUDE_LOGIN_PATH` (dated L55 fail-closed placeholder). No SDK import, no `query()`/completion.
- Test files (one per slice): `test/model/extraction-completion-request.test.ts` (7), `test/model/subscription-health-probe.test.ts` (10), `test/model/subscription-reachability-probe.test.ts` (16).

### Files modified
- `packages/providers/src/index.ts` — three additive barrel re-exports (extraction-request + extraction-completion-request; subscription-health-probe; subscription-reachability-probe). These are the reachability mechanism so the worker consumers (18.20/18.23/18.25) can import the legs.

### Commits (all local at session close; pushed into `7180a49a` per lead)
- 18.19 `199758f9653cde704479ba4b08b269bba9dcc7fa`
- 18.22 `083c8e0e02279f4ba026dad2ce81f60373221016`
- 18.26 `42a7af14f2eaa9ef8111627e314924a7fe9b15a2`

## Decisions made
- **COST-1 re-point via presence not truthiness (18.19).** `maxCostUsd` threaded verbatim (`!== undefined`), so a `$0` cap carries (a truthy check would fail-OPEN, Lessons 54/55). The budget enforcer (`resolveEnforcedBudget`) is the positive-finite cap authority; the assembler does not re-police (an omit-on-non-finite guard would fail-OPEN to the SDK default budget). Context7-verified the SDK option name `maxBudgetUsd` is intact.
- **Sync fail-closed health verdict (18.22).** The downstream `HealthGateSources.health` is synchronous, so a sync `{reachable, reason?}` verdict composes directly in the 18.23 wrap (no resolve-at-boot). Strict `=== true` on both dimensions = the L52 false-green defense; the whole fold in one `try` closes the totality residual.
- **Spend-free reachability = presence + resolvability, NOT `accountInfo()`/`query()` (18.26).** Context7 (`/nothflare/claude-agent-sdk-docs`) does not confirm `accountInfo()` is spend-free and it needs a live `query()` session (spawns the CLI) → a possible CP2 spend before the gated run (L55/L56). Chose fs credential **existence** (rule-7, never contents) + module **resolvability** (resolve ≠ import). `resolveAgentSdk` requires a **non-empty resolved-path string** (not merely "didn't throw") for strict L52 parity.
- **Login path is a dated L55 placeholder (18.26).** `DEFAULT_CLAUDE_LOGIN_PATH` is a candidate, explicitly flagged "verify at the arm"; on macOS (Keychain login → no file) it fails CLOSED ⇒ HEALTH UNAVAILABLE ⇒ arm HALTs — safe, never a false-green. The orchestrator confirmed this is the sanctioned placeholder convention, not the L56 falsify-authority anti-pattern.
- **Layer-clean verdicts.** Both probes stay minimal reachability/health verdicts; the worker wraps map them to `HealthGateSources` (never coupling the providers primitive to the worker shape).

## Decisions explicitly NOT made (deferred)
- **The live login detector** — deferred to the arm (18.25). On macOS this must be a **Keychain-presence** probe (not the file placeholder), and per the security-reviewer note it should validate the login is **usable, not merely present** (existence ≠ validity; spend-safe today since an invalid login auth-fails without billing).
- **Async live reachability ping** — deferred; the RUN itself is the true reachability test. Sync readiness is sufficient and keeps the memoize/`HealthGateSources` seam sync.
- **`accountInfo()`/`tokenSource` readiness** — deferred pending a live-source confirmation that it is spend-free; not used now.

## TDD compliance
- **18.19, 18.22:** clean — RED written + **confirmed failing for the right reason** (import-absent), then GREEN, full suite, reviewers. Post-review regression pins (0-cap; null/truthy/partial fail-closed) added in-slice — each pins already-correct behavior against a future weakening, verified non-vacuous.
- **18.26:** test-first (the full test file, incl. the ADD'd primitive tests, existed **before** the impl file), but the explicit intermediate *confirm-RED run* was compressed (wrote tests → wrote impl → confirmed GREEN). Not a test-after-impl violation; the load-bearing safety assertions (strict `=== true`, throw-folds-to-false) were verified non-vacuous by reasoning and by both reviewers. **Minor process note**, no safety impact.

## Reachability
All three legs were reachability-**waivered (L11)** at their slice (no production call-site in-slice); the barrel exports are the mechanism. The consumers landed in the same crossing round and the **maiden real extraction succeeded**, confirming end-to-end wiring:
- 18.19 → worker subscription-extraction runner (18.20, `provider-runner.ts`).
- 18.22 → worker `createSubscriptionHealthSources` (18.23) → `gate.healthSource`.
- 18.26 → arm `config.subscriptionArm.checkReachable` (18.25) → 18.22 → 18.23 → `gate.healthSource`.
No tested-but-unwired gap remains in providers.

## Open follow-ups (Step-9 categorized — already routed hot to the orchestrator; orchestrator writes the docs)
- **Convention candidates (providers LESSONS):** §8 COST-1→`maxBudgetUsd` chokepoint (thread by presence; enforcer is authority) · §9 fail-closed subscription health probe · §10 spend-free readiness probe (presence + resolvability, reject `accountInfo()`/`query()`, dated fail-closed login placeholder). _(Orchestrator confirmed §8/§9 written; §10 rides the crossing-round seal.)_
- **Architecture doc notes (§19.5):** the subscription request-assembly + health + reachability seam splits (providers primitives ↔ worker wraps). Ride the round-close commit.
- **Future TODO — belongs-to-phase (18.25 arm, worker territory):** inject the **live macOS Keychain-presence login detector** that validates the login is **usable, not just present** (not the `DEFAULT_CLAUDE_LOGIN_PATH` file placeholder). Relayed by the lead to worker-impl.
- **Cross-doc invariant change:** **NONE.** All new/changed types are internal `@sow/providers` types (`CompletionRequest`, `AgentExtractionRequest`, `ExtractionCompletionOptions`, `SubscriptionHealthVerdict`/`Reachability`/`Reason`, `SubscriptionReachabilityProbeDeps`, `PathExists`, `ModuleResolver`) — no Appendix-A / frozen seam model; `git diff -- ARCHITECTURE.md` empty. Audit clean.

## Reviews
- 18.19: security CLEAR; code-quality 2 low, both fixed in-slice.
- 18.22: security CLEAR; code-quality 1 med + 2 low, all folded in-slice.
- 18.26: security **CLEAR (0 findings)** — spend-free / rule-7 / fail-closed / placeholder-honesty all pass; code-quality 4 low → #1 (resolveAgentSdk fail-open-on-falsy) fixed in-slice + pinned, #2/#3/#4 deferred.

## How to use what was built
The arm (18.25) wires: `config.subscriptionArm.checkReachable = probeSubscriptionReachability` (override `detectLogin` with the live Keychain detector) → `probeClaudeSubscriptionHealth({checkReachable})` → memoize → `createSubscriptionHealthSources` → `gate.healthSource`. The runner (18.20) uses `buildExtractionCompletionRequest(req, content, {model, maxCostUsd, betas})` to assemble the subscription `CompletionRequest`. Worker runs with `ANTHROPIC_API_KEY` UNSET (ambient subscription auth).
