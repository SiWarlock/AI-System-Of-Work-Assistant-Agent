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

---

## ⛔ CHECKPOINT 1 RESULT (2026-07-18) — shadowing-env grounded + dev-env all-unset (BEFORE arming)

**`SUBSCRIPTION_SHADOWING_ENV_KEYS` — the full grounded set** (Context7 `/nothflare/claude-agent-sdk-docs`; the Agent SDK `query()` runs on Claude Code, so Claude Code's auth/egress env vars apply). The armed-boot `assertSubscriptionAuthEnv` guard MUST enumerate ALL of these and refuse (fail-closed) if ANY is set:

**Class A — auth-shadowing (change WHICH auth/provider ⇒ NOT the subscription / wrong billing):**
- `ANTHROPIC_API_KEY` — raw API key; shadows the ambient `claude` login (Context7-confirmed). THE primary.
- `ANTHROPIC_AUTH_TOKEN` — custom bearer auth-token override.
- `CLAUDE_CODE_USE_BEDROCK` — switch to AWS Bedrock (different provider/auth/egress).
- `CLAUDE_CODE_USE_VERTEX` — switch to GCP Vertex.

**Class B — egress-redirect (content could go elsewhere / be intercepted):**
- `ANTHROPIC_BASE_URL` — proxy redirect; the proxy can inspect/inject creds (Context7-confirmed).
- `ANTHROPIC_API_URL` — base-url alias (defensive).
- `HTTP_PROXY` / `HTTPS_PROXY` — route ALL traffic through a proxy (Context7-confirmed). ✅ IN the 8-var guard (18.24).
- `http_proxy` / `https_proxy` — **FLIP-VERIFY CANDIDATE (18.24, security LOW):** Node honors LOWERCASE proxy vars too, so a lowercase-only proxy would NOT trip the uppercase-only guard (a Class-B fail-OPEN). Add to `SUBSCRIPTION_SHADOWING_ENV_KEYS` at the flip once confirmed the Agent-SDK path honors them.
- `ANTHROPIC_CUSTOM_HEADERS` — **FLIP-VERIFY CANDIDATE (18.24):** can inject headers (creds/routing); unconfirmed vs live SDK docs — verify + add at the flip.

**⚠ NOT a plain env var — the `apiKeyHelper` caveat:** Claude Code's `apiKeyHelper` **settings** entry can inject an API key (bypassing the env check). The owner MUST confirm the deployment's Claude Code settings (`~/.claude/settings.json` / project settings) carry no `apiKeyHelper` / API-key injection, not just the env.

**Dev-env presence check (presence only, no values — rule 7): all 8 UNSET.** ⚠ This was the orchestrator's dev shell — NOT authoritative for the deployment. The DEFINITIVE checks (owner-confirmed at the arm): (a) the armed-boot `assertSubscriptionAuthEnv` guard over the full set above; (b) the owner's actual deployment env + Claude Code settings clean; (c) the local `claude` login active + on the subscription (verify `Query.accountInfo().tokenSource`/`subscriptionType` if feasible).

## Remaining step-6/7 plan (step-6 WIRING LANDED 2026-07-18 — only the owner arm remains)

The staged round (steps 0–5) + the **step-6 WIRING (18.24 `65dd9e5f` A helpers + `c9361092` B wiring, dormant, security 6/6 PASS)** are BUILT. `bootWorker` now arms the whole bundle off ONE signal (`config.providerTransport` via `isProviderTransportArmed`): the full 8-var `assertSubscriptionAuthEnv` fires DEGRADE-not-crash on the armed path (L52); `withSubscriptionExtractionArming` co-gates the cloud route + the exactly-one `{refKind:"source"}` ContextRef; `LOCAL_EXTRACTION_ROUTE` single-sourced (3 copies unified); `checkReachable` memoized. Shipped default byte-equivalent (signal unset ⇒ nothing arms). **What remains = the owner arm:**

1. **⚠ The step-6 flip is NOT just "set a config value" (the eager-consumption FINDING).** `assembleBackends` consumes `config.providerTransport` EAGERLY (`backends.ts:809`) but the content-resolver's parked-reader (`createDurableParkedReader(backends.repos.sourceDisposition)`) exists only AFTER assembly. So the flip = set `config.providerTransport = gateSubscriptionExtraction(...)` (the pure step-6 builder, already landed + reachability-waivered) + a **reader-holder late-bind**: fill the resolver's reader POST-`assembleBackends`. Testable at the flip WITHOUT real spend (unit + SOW_TEMPORAL `-live` with a stubbed completion). In-code `#13 step-6` TODO in `boot.ts` marks the site.
2. **Re-verify at the flip (HARD preconditions):** the FULL `SUBSCRIPTION_SHADOWING_ENV_KEYS` set vs live SDK docs (add the lowercase `http_proxy`/`https_proxy` + `ANTHROPIC_CUSTOM_HEADERS` candidates above if confirmed — a missed var fails OPEN); the `$1.50`/`300s` cap + `DEFAULT_EXTRACTION_MODEL` id; no `apiKeyHelper` API-key injection in Claude Code settings.
3. **HOLD at the arm** for the owner to confirm: env + Claude Code settings clean (checkpoint 1 authoritative), local `claude` login active on the subscription.
4. **Checkpoint 2** — arm (set `config.providerTransport` + the reader-holder bind) → confirm gate armed + preconditions green (health available, route live, no shadowing-var degrade).
5. **Checkpoint 3** — one CONTROLLED real extraction → the note + the REAL cost + the eval verdict. Do NOT widen beyond one run. HALT + escalate at any fail-closed point.

**HARD LINES: real egress (arm) + real spend (first run) — explicit per-crossing owner confirm.** Sealed locally at the 18.24 round commit (do NOT push mid-crossing; origin/main stays `f2bb8cca` until the crossing pushes).
