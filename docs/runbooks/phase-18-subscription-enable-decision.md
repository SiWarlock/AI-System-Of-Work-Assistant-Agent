# Phase-18 Subscription ENABLE — Owner Go-Live Decision Brief

> **DECISION BRIEF for owner sign-off — provision/arm NOTHING until the owner confirms per crossing.** This is the ENABLE (#13, subscription path / Option B) after the fully-dormant subscription-routing round (18.19 `199758f9` + 18.20 `7ab16dcb`, sealed at origin/main `4b9747f3`). Real EGRESS + real SPEND are hard lines needing explicit per-crossing owner confirm. Lead+owner-run.

## What is already true (no action)
- **GATE-1 satisfied** — the real model's `agent_extraction` candidate (`ExtractionField.evidenceRef`) reaches `validateNoInference` faithfully (CP-1..CP-3); the candidate-data gate + no-inference (REQ-F-017) are the trust boundary, shape-agnostic across the subscription and raw-API paths.
- **GATE-2 deferred** — single-workspace crossing (no multi-workspace registry arming this crossing).
- The whole subscription path is **built + dormant + reachability-waivered**: nothing routes to the subscription, no content resolver is bound, no cost cap is set, the transport gate is OFF. Shipped default is byte-equivalent.

## The ENABLE ledger — what must flip, in ORDER (fail-closed piece FIRST, real egress/spend LAST)

| # | Step | What it arms | Fail-closed if UNMET |
|---|---|---|---|
| 0 | **Pre-flight invariants (no arming).** Confirm the worker runs with **`ANTHROPIC_API_KEY` UNSET** (a stale/empty key shadows the subscription profile by resolution precedence → auth failure); confirm the local `claude` login is active (the subscription auth). | — (verification only) | A set `ANTHROPIC_API_KEY` ⇒ `auth` CompletionError ⇒ terminal deny (never a silent wrong-provider run). |
| 1 | **Bind the real `ExtractionContentResolver`** (`contextRefs`/transcript/`SourceEnvelope.body` → inline `userPrompt` text). The ref path is marker-only; this is the content seam left unbound in 18.20. | Content reaching the model. NO egress yet — the route is still local. | Unbound ⇒ the runner denies (`content_resolution_err`), zero client dispatch, zero spend. |
| 2 | **Set the extraction cost cap** (the SDK-native `maxBudgetUsd`, via the enforced budget `maxCostUsd`). **Recommended first-run cap ≈ $1.50 metered** (~$0.45 real on Sonnet for a ~100k-tok transcript; the SDK meter over-counts ~3×). Owner sets the final value. | The in-flight dollar ceiling (the ONLY dollar cap for a runtime route — the token-priced broker POST gate can't meter it, Finding-F). | Unset ⇒ the SDK applies its own default budget (bounded, but ALWAYS set an explicit cap before real spend). A breach ⇒ `error_max_budget_usd` → `budget` deny, no partial side effect. |
| 3 | **Bind the real `healthSource`** (AND-locked to the transport arming; **never `config.healthSources`** — L52). | The provider-reachable HEALTH signal. | On an armed gate with no source ⇒ HEALTH gate denies `UNAVAILABLE` (never stub-green). |
| 4 | **Change `capabilityDefaults`** — `source.process` (and add `meeting.close`) from `{provider:"ollama",local}` / unrouted → a cloud `{runtime}` route (`{runtime:"claude-subscription", model, endpoint, egressClass:"cloud"}`). | Extraction ROUTING to the subscription. ⚠ This is what re-triggers the egress veto on a cloud route. | Unchanged ⇒ extraction stays local/ollama; no subscription, no cloud egress. |
| 5 | **⛔ HARD LINE — verify the rule-5 cloud-egress veto FAILS CLOSED** before any real employer-raw run: an Employer-Work source job with egress-ack OFF + only the cloud `{runtime}` route ⇒ **DENY, no cloud, NO local fallback**. Leakage-eval: zero raw employer content on any cloud egress. | Proves the employer-egress veto governs the cloud subscription route (safety rule 5). | If the veto doesn't fail closed here — **STOP**; this is a rule-5 Finding, do not arm the transport. |
| 6 | **⛔ HARD LINE — arm the `ProviderTransportGate`** `{enabled:true, make:()=>createRealProviderRunner(+ subscription deps {completion, content, model, betas}), healthSource}`. This is the flip that selects the real subscription runner. | **Real model call + real subscription spend.** | OFF (any of the 3 OFF-locks) ⇒ byte-equivalent stub, no real call. |
| 7 | **⛔ HARD LINE — first real extraction run** — a controlled meeting/source job → the subscription → a real `agent_extraction` candidate → the gate → a real note. Eval the extraction (evidenceRef faithfulness, no-inference). | First real metered spend against the subscription. | The candidate-data gate rejects a schema-invalid / inferred output BEFORE any Markdown or external side effect (rule 2 / REQ-F-017). |

## Hard lines (explicit per-crossing owner confirm required)
- **Step 5–6: real EGRESS** — the cloud `{runtime}` route sends content to Anthropic. The Employer-Work egress veto (rule 5) governs: **employer-raw content with ack OFF NEVER reaches the cloud subscription** (fail-closed, no local fallback); only ack'd-employer or personal content egresses.
- **Step 6–7: real SPEND** — metered against the subscription. The SDK `maxBudgetUsd` (Step 2) is the in-flight ceiling; the owner sets it before the flip.

## Recommended first-run posture (Option B / subscription lever)
- Set **`maxBudgetUsd` ≈ $1.50** metered for the first runs (conservative; the SDK hard-stops at it with no partial side effect). Re-verify the exact model id + any beta (`context-1m-…`) against the current Anthropic/Agent-SDK catalog at the flip (a stale id folds to a typed error, never a silent wrong answer).
- Arm the **dollar-capped subscription runtime route ONLY**; the agent-sdk `meeting.close` runtime route and the raw `x-api-key` `ModelProviderPort` path are NOT armed by this crossing (the raw path stays the fallback for isolated-billing / non-Claude providers).
- Single controlled first run (one transcript) → eval → then widen. Auto-ingest (autonomous recurring spend) stays OFF — a separate owner-gated arming.

## Fail-closed summary (the whole path degrades safe if any precondition is unmet)
Content resolver unbound → deny/no-dispatch. Cost cap unset → SDK default (set it anyway). healthSource unbound → UNAVAILABLE deny. Route unchanged → stays local. Employer-raw + ack OFF + cloud → fail-closed, no fallback. `ANTHROPIC_API_KEY` set → auth deny. Transport gate OFF → byte-equivalent stub. **No single omission produces a silent real spend or a raw-employer cloud leak.**
