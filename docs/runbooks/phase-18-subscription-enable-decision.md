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

## ✅ CHECKPOINT-1 FLIP-VERIFY CANDIDATES — RESOLVED IN-CODE (18.28, 2026-07-18)

The `/phase-exit 18` crossing-gate security audit (`docs/audits/18-crossing-security.md`) rated the incomplete guard a MEDIUM; **18.28** (`fix(worker)`, brief `142`) extended `SUBSCRIPTION_SHADOWING_ENV_KEYS` 8→13 — the flip-verify candidates above are now ENUMERATED IN-CODE: lowercase `http_proxy`/`https_proxy`, `ALL_PROXY` + `all_proxy`, and `ANTHROPIC_CUSTOM_HEADERS`. `NO_PROXY`/`no_proxy` deliberately EXCLUDED (a bypass allowlist, not a redirect — watching it would false-positive-degrade a legit config). **Residual flip preconditions (NOT closed by 18.28):** (a) the final live-Agent-SDK-docs re-verify of the full set immediately before the flip (never memory — L56); (b) reconsider TLS-interception ENABLERS (`NODE_EXTRA_CA_CERTS` — captured as an in-code re-verify note, not a watched var, since it redirects nothing without an already-watched proxy); (c) the `apiKeyHelper` settings-injection out-of-band owner-deployment check (not an env var the guard can see). worker Lesson 65.

## ✅✅ CROSSING COMPLETE — GO-LIVE 2026-07-18

The owner ran the controlled maiden extraction. **CP2 (arm verify, spend-free) + CP3 (maiden run) both GREEN; SAFETY PASS on real model output.** Real cost **$0.044772 metered (~$0 actual on the flat subscription)**. GATE-1/REQ-F-017 proven LIVE: the absent datum (a task's unstated due date) returned `TBD` with NO evidenceRef — not invented. The one gap the pre-spend fake-completion dry-run caught (18.27 / #13 Finding C — agent_extraction not reachable in the worker schema-gate) was fixed test-first BEFORE any spend. Sealed + PUSHED (owner-authorized). Quality follow-up (Carry-forward, orthogonal to safety): the note frontmatter under-populates owner/dueDate (L49 bare-key vs the model's task-prefixed multi-task extraction — the fail-safe held). NEXT = `/phase-exit 18` (formal gate over the live path) + the note-projection alignment. **Posture (owner):** subscription extractions on benign/non-employer content are ROUTINE ops (no marginal cost) — keep the genuine rails (rule-5 veto · fail-closed gates · one-writer) but no per-run owner-gate/multi-confirm; reserve heavy gating for real external writes / employer-egress / paid API keys.

_(Historical — the pre-crossing plan below is retained for the audit trail.)_

## Remaining step-6/7 plan — ⭐ ARM CODE-COMPLETE 2026-07-18; only the CONTROLLED ARM BOOT + ONE run remain (successor handoff)

The step-6 WIRING + the deferred eager-consumption FINDING piece + the macOS login detector are ALL BUILT + dormant + committed (NOT pushed; worker 1793/0):
- **18.24** `65dd9e5f` (A helpers) + `c9361092` (B wiring) — the `config.subscriptionArm` opt-in; 8-var `assertSubscriptionAuthEnv` DEGRADE-not-crash (L52); `withSubscriptionExtractionArming` co-gates the cloud route + the `{refKind:"source"}` ContextRef; `LOCAL_EXTRACTION_ROUTE` single-sourced; `checkReachable` memoized.
- **18.25 STEP-1** `7e892be3` — the eager-consumption resolution: `createSubscriptionOnlyProviderRunner` (serves cloud `{runtime}` ONLY, fails closed on `provider` routes — never touches the KeychainLockController/secrets path) + the reader-holder late-bind (holder filled with `createDurableParkedReader` POST-`assembleBackends`).
- **detectLogin** `dd347b3c` — `detectClaudeKeychainLogin`: spend-free, value-free macOS Keychain-PRESENCE check (`security find-generic-password -s "Claude Code-credentials"`, NO `-w`, Phase-17 CLI pattern) — the real `detectLogin` for the arm's health leg.
- **18.26 (providers)** `42a7af14` — `probeSubscriptionReachability({detectLogin, resolveSdk})`: spend-free fold; `resolveAgentSdk` (module resolvability) shipped concrete.

**CONFIRMED pre-arm gates (owner+lead+impl):** 11 shadowing vars UNSET (incl. lowercase proxies + `ANTHROPIC_CUSTOM_HEADERS`; owner-live + impl-shell) · no `apiKeyHelper` in any Claude Code settings · shell profiles clean, no shadowing export (lead item-3) · the stray `anthropic_api_key` Keychain item is BENIGN (`ClaudeClipboardCleaner`, not Claude Code — a Keychain item ≠ a set env var) · `claude` /login refreshed + on the subscription · worker-process Keychain ACL = exit-0 (Node prompt-free presence read).

**REMAINING = the CONTROLLED ARM BOOT + ONE run (the successor worker-impl executes; lead+owner-authorized; the run-go is relayed to the successor VERBATIM via the orchestrator):**
1. **Re-verify the model-id** — `DEFAULT_EXTRACTION_MODEL` (`claude-sonnet-5`) vs the LIVE Agent-SDK catalog (Context7 `/nothflare/claude-agent-sdk-docs` or claude-api) IMMEDIATELY before the run (a stale id folds to a typed CompletionError — safe — but confirm).
2. **ARM = a CONTROLLED boot** with `config.subscriptionArm = { enabled:true, model:<confirmed>, checkReachable: () => probeSubscriptionReachability({ detectLogin: detectClaudeKeychainLogin }) }` + the default real `createClaudeSubscriptionCompletion` + a BENIGN NON-EMPLOYER workspace + a benign parked source. (Shipped default stays unset — a controlled arm boot, NOT a prod flip.) The armed-boot `assertSubscriptionAuthEnv` MUST fire + PASS (degrade/deny ⇒ HALT).
3. **CP2 (spend-free — NO job runs) → orchestrator:** verify the 4 legs — (a) `assertSubscriptionAuthEnv(armed)` fires+PASSES; (b) health AVAILABLE (memoized probe: `detectClaudeKeychainLogin` present ✓ AND `resolveAgentSdk` resolvable ⇒ healthy, NOT UNAVAILABLE); (c) route live (`source.process` = cloud `{runtime}`); (d) rule-5 fail-closed vs the LIVE armed route (employer-raw+ackOFF ⇒ DENY). HALT+report on ANY fail.
4. **HARD PAUSE at CP2** — the orchestrator verifies + relays CP2 + evidence to the lead → the lead brings the owner → the owner-acked run-release returns to the successor VERBATIM via the orchestrator. Run ONLY on that (never on the orch's relay/go alone).
5. **RUN = ONE real `source.process` extraction** (benign non-employer ws) → GATE-1 candidate gate (validateNoInference/REQ-F-017) → real note via the sole KnowledgeWriter → capture the REAL metered $ + eval. ⚠ a ONE-TIME macOS "Allow" Keychain prompt at the SDK's first token READ is EXPECTED (owner pre-warned) — NOT a failure. HALT-not-force at every gate; ONE run only.
6. **CP3 → orchestrator:** the note + the REAL metered $ + the eval verdict.

**HARD LINES: real egress (arm) + real spend (first run) — explicit per-crossing owner confirm.** Sealed locally through the 18.25 / detectLogin / 18.26 commits (do NOT push mid-crossing; origin/main stays `f2bb8cca` until the crossing pushes).
