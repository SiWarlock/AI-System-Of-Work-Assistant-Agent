# Phase 5 — §7 Provider & Runtime Broker — Security Review

- **Package:** `@sow/providers` (`packages/providers`)
- **Commit reviewed:** HEAD `84c3c7e` (retry after a transient API error on the prior run)
- **Policy:** `phase-boundary` (whole-phase security pass; review surface = accumulated `packages/providers/src` + tests)
- **Reviewer:** security-reviewer subagent
- **Verification:** `pnpm --filter @sow/providers exec vitest run` → **232 passed / 20 files**; `pnpm --filter @sow/providers exec tsc --noEmit` → **clean (exit 0)**
- **Test posture note:** adapters are transport-mocked (injected `HttpTransport` / `HermesTransport` / `ClaudeAgentTransport`); real network conformance is the §12/5.10 eval path, not a unit test. Intended.

## Verdict: **CLEAR**

Both prior adversarial-verify findings independently RE-DERIVED as **closed**. No NEW critical/high found. Two low-severity observations recorded (defer / no action) — neither is a safety-invariant breach.

---

## Re-derivation of the 2 prior findings

### Finding 1 (HIGH, prior) — egress veto must bind the EXECUTED egress target — **CLOSED**

Root cause (prior): the pipeline resolved + egress-vetoed the matrix `route`, but the runtime adapters + budget read the job's OWN `job.providerRoute`. If a job DECLARED a route divergent from the matrix-resolved+vetoed one, the veto vetted `route` while execution/billing used the un-vetted `job.providerRoute` — the veto did not bind the executed egress target.

Independent re-derivation of the fix (`broker.ts`):

- After the veto narrows/clears the route (`route = vetoed.value`, line 285), the broker constructs `effectiveJob = routesEqual(job.providerRoute, route) ? job : { ...job, providerRoute: route }` (lines 310-311) and threads `effectiveJob` (NOT the raw `job`) into every downstream consumer:
  - `deps.budget.pre(effectiveJob)` (line 323)
  - `deps.run(route, effectiveJob, budget, signal)` (line 337) — passes BOTH the explicit vetted `route` param AND the vetted `effectiveJob`
  - `deps.budget.post(effectiveJob, result.usage, budget)` (line 365)
  - `deps.schema(effectiveJob, result)` (line 382)
- The two route-consuming families both now resolve to the vetted route:
  - **Runtime adapters** — `hermes-runtime.ts:127` and `claude-agent-sdk-runtime.ts:139` read `job.providerRoute`; production dispatch hands them `effectiveJob`, whose `providerRoute === route`.
  - **Budget enforcer** — `budget-enforcer.ts:114` (`job.providerRoute.egressClass === "local"` local-multiplier gate) and `:126` (`pricingFor` reads `job.providerRoute.provider`) both read `effectiveJob.providerRoute` = the vetted route.
- **No remaining divergent path.** Searched all of `src` for route reads (`job.providerRoute` / `req.route`): every runtime read is on the threaded `effectiveJob`; every model-adapter read is `req.route.endpoint` (http-transport.ts:46 and siblings) where `ProviderRequest.route` is built by the injected production runner from the `route` param the broker hands it. No `packages/providers` code reconstructs a request from the raw `job.providerRoute` after the veto.
- **Belt-and-suspenders.** The explicit `route` param to `deps.run` is the PRIMARY binding — a correct runner uses its first argument (the vetted route) unconditionally. The `effectiveJob` rebuild is the secondary guard for a runner that instead reads `job.providerRoute`. `routesEqual` (broker.ts:501-507) compares exactly the egress-target-determining fields (port key + model + endpoint + egressClass), so it cannot false-positive across a divergent egress target and leave a stale route in place.
- **Regression pinned:** `test/adversarial-regressions.test.ts` — a job declaring `DIVERGENT_ROUTE` (`https://exfil.example.com`) while the matrix resolves `MATRIX_ROUTE` asserts `runRoute` and `budgetRoute` both equal the matrix route and the exfil endpoint is never seen.

### Finding 2 (MED, prior) — COST-1/2 must meter the EXECUTED route — **CLOSED**

Same root cause + fix. `budget.pre`/`budget.post` receive `effectiveJob`; `resolveEnforcedBudget` (local-runtime multiplier) and `pricingFor` (per-provider token pricing) both read `effectiveJob.providerRoute`. The regression test asserts `budgetRoute` equals the vetted matrix route, not the divergent declared route. COST-1/2 meters the executed route.

---

## Project safety-invariant pass (invariant-touching phase)

1. **STRICT SIDE-EFFECT RULE — PASS.** The broker emits only a `BrokerCandidate` (`knowledge_mutation_plan` | `proposed_action`); it imports/calls no write adapter (broker.ts header + code). The composed candidate-data gate is fixed-order and **never ajv alone** (schema-gate.ts:84-146): ajv structural → model Zod `.safeParse` (fails closed if no parser registered for the schema id, :100-109) → optional no-inference (REQ-F-017, reject-never-coerce, :118-127) → normalize → §3 universal rules (scoped-mutation + external-write-keys, :136-140) → tool-policy (:142-146). `output-normalizer.ts` and `schema-gate.ts` are DATA-ONLY (zero write-adapter import; pinned by the architectural import test). Provider/runtime outputs are candidate data (`ProviderOutput.candidateOutput`, `AgentResult.candidateOutput`) — never applied.

2. **Rule 5 — Employer-Work egress veto binds the EXECUTED route — PASS.** `egress-veto.ts` composes the §5 `@sow/policy egressVeto` AFTER selection as a pure pass-or-deny: DENY fails closed with NO cloud fallback (Employer-raw + ack=false ⇒ `EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED`); ALLOW is narrow-only — a widened/substituted route ⇒ fail closed `MALFORMED_POLICY_INPUT` (:102-117). The vetted route binds execution+budget via `effectiveJob` (Finding 1). OpenRouter is its OWN processor (`openrouter-provider.ts` `PROVIDER_ID = "openrouter"`, distinct path `/api/v1/chat/completions`, never an OpenAI alias). Tunneled-`local` (remote endpoint claiming `egressClass: "local"`) is denied by the §5 predicate (egress-veto.test.ts:121). Audit refs are host-only (no scheme/path/userinfo leak — test asserts no `https://` in the AuditSignal).

3. **Rule 6 — ING-7 admission — PASS.** Admission is stage 1 via `@sow/policy admitJob`; an untrusted+mutating-tool job short-circuits (`UNTRUSTED_CONTENT_MUTATING_TOOL`, no downstream gate runs — broker.test.ts:176). Defense-in-depth at BOTH runtime adapters: `buildHermesCommand`/`buildClaudeAgentInvocation` re-reject an untrusted job that is not read-only / tool-consistent, and launch `--safe-mode` on untrusted or raw-content runs (Hermes strips injected AGENTS.md/memory/MCP).

4. **Hermes empty-toolset invariant (LESSONS §1) — PASS.** `buildHermesCommand` refuses to produce a command when `effectiveAllowedTools(job.toolPolicy)` is empty (empty `-t` silently falls back to the full mutating toolset) → typed `tool_policy_violation`; the subprocess is never spawned with an empty `-t` (hermes-runtime.ts:148-159).

5. **Rule 7 — provider-boundary redaction — PASS.** `redaction/provider-log-redaction.ts` DROPS raw prompt/rawContent/response (structurally absent from `SafeProviderLog`) and scrubs credential shapes (API-key prefixes, PEM blocks, URL basic-auth) with a fail-safe whole-field drop when a residual sensitive keyword/credential survives. Every adapter log path routes through the redactor before any sink (`executeCompletion` `emitLog`/`redactLogs`; `completedResult` in runtime-support.ts; transport-throw messages via `classifyTransportThrow` → `redactString`, http-transport.ts:203-224). IDs/status are defensively re-redacted (:165-180).

6. **COST-1/2 — budget breach cancels with NO partial side effect — PASS.** `budget-enforcer.ts` `pre` fails closed if no bounded positive runtime cap can be derived (COST-2); `post` breach ⇒ deny → broker advances to `cancelled_budget` and discards output BEFORE the schema gate — no candidate emitted (broker.ts:364-374; broker.test.ts:217). A cooperatively-cancelled result (`status: "cancelled"`) is force-discarded (`candidateOutput: undefined`) before the gate (runtime-support.ts `cancelledResult`; broker.ts:349-362). Pre-dispatch abort returns `Err(cancelled)` before the transport is touched (COST-1). Unmeasurable cost never breaches (the always-present runtime cap is the net).

7. **Replay / no-duplicate — PASS.** An already-accepted `idempotencyKey` is served from the ledger and re-runs NO gate (broker.ts:246-250; broker.test.ts:300) — no duplicate audit/candidate.

---

## General security pass

- **Input validation** — every boundary output is candidate data behind the composed gate; malformed matrix / cross-workspace matrix ⇒ `MALFORMED_POLICY_INPUT` (route-resolution.ts:42). Local adapters reject any endpoint not on the explicit allowlist (http-transport.ts:410). PASS.
- **Injection / SSRF** — no string-concat-to-shell; Hermes args are an argv array (no shell). Endpoints are allowlist-gated (local) or vetted-route-derived (cloud). PASS.
- **Secrets** — resolved only via the injected SecretsPort-shaped accessor (Keychain ref, never inline); sent as `Authorization: Bearer`, never logged; a missing/locked key degrades the provider (retryable auth_unavailable), never throws. PASS.
- **Information disclosure** — audit/denial messages carry codes/ids/host-refs and numeric bounds only; no raw content, no full URL, no secret. PASS.
- **Unbounded loops / resource exhaustion** — no unbounded loops over provider-controlled length; per-request output ceiling (`DEFAULT_MAX_OUTPUT_TOKENS`) + broker runtime/cost caps bound a run. PASS.
- **Throw-safety (§16)** — every module returns typed `Result`; no throw crosses a boundary. PASS.

---

## Low-severity observations (defer / no action — NOT invariant breaches)

- **[low] broker.ts:337 + injected `ProviderRunner`** — the executed-route binding is belt-and-suspenders (explicit `route` param + `effectiveJob`), but there is NO production `ProviderRunner`/request-builder in `packages/providers` — `deps.run` is injected by the downstream worker wiring (out of this phase's scope). The whole binding holds ONLY IF that injected runner builds `ProviderRequest.route` from the `route` param (or from `effectiveJob.providerRoute`), never from a separately-captured raw `job.providerRoute`. Recommend the worker-track wiring slice carry a regression asserting the constructed `ProviderRequest.route` equals the broker's `route` param. Action: **defer** to the worker/integration wiring phase (flag to that track).
- **[low] provider-log-redaction.ts SENSITIVE_KEYWORD** — deliberately omits the bare word "token" (to avoid false hits on structured status codes like `AUTH_TOKEN_INVALID`); credential-SHAPED tokens (`sk-…`, `eyJ…`, `xox…`) are still caught by CREDENTIAL_PREFIX/CREDENTIAL_TOKEN, and raw prompt/response are dropped wholesale, so this is not a leak surface. Documented tradeoff. Action: **no action**.

---

## Escalation

No NEW critical/high findings. Nothing to escalate as a Step-9 `Finding`. The two prior adversarial-verify findings are independently confirmed closed with regression coverage.
