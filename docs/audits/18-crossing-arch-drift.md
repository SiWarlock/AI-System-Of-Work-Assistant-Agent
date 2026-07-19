# Phase-18 SUBSCRIPTION ENABLE crossing — architecture drift audit

- **Gate:** `/phase-exit 18` (crossing surface only — the safe-build 18.1–18.10 passed `/phase-exit 18` CLEAR on 2026-07-17; see `docs/audits/18-arch-drift.md`).
- **Audit surface:** `6d6d94bd..HEAD` (HEAD `7180a49a`) — tasks 18.11–18.27 + the maiden real extraction (CP3). 8352 insertions / 104 files.
- **Anchors read (cited sections only):** §19.5 (primary), §7, §5, §9 (workflows 1 & 4), §6, §16; Appendix A rows ProviderMatrix, ProviderRoute, AgentJob, ProposedAction, BrokerOutcome, Capability, AgentExtractionCandidate.
- **Verdict:** **CLEAR** — 0 DRIFT, 1 minor STALE-DOC note, 0 ambiguous.
- **Method:** graphify/codegraph orientation → targeted reads → verified-by-test shortcut for the snapshot/schema. The `sow:agent-extraction` contract + snapshot tests were run and are **GREEN (24 pass / 0 fail)**; the rule-5, GATE-1/REQ-F-017, and COST-1/Finding-F assertions were confirmed present by inspection.

---

## §19.5 — Real Model Transport & Intelligence Legs (PRIMARY)

| # | Contract statement (doc) | Verdict | Evidence |
|---|---|---|---|
| 1 | `withSubscriptionExtractionArming` (mirrors `withDurableRevisions`) co-gates the armed cloud route + the exactly-one `{refKind:"source"}` ContextRef off the SAME `isProviderTransportArmed` signal | VERIFIED | `apps/worker/src/boot.ts:1192-1235` — `armed !== true ⇒ params unchanged`; armed ⇒ swaps ONLY `"source.process"` → `CLOUD_EXTRACTION_ROUTE` + stamps `[{refKind:SOURCE_CONTEXT_REF_KIND, ref:String(sourceRef.sourceId)}]` (never content). Comment "Mirrors {@link withDurableRevisions}." |
| 2 | One flip, no split-brain (transport + route + auth + ContextRef + outputSchemaId all off one signal) | VERIFIED | `boot.ts:1295-1310` derives `armWiring`/`effectiveArmed` from the single `isProviderTransportArmed` predicate `selectProviderRunner` reads; worker Lesson 62 |
| 3 | COST-1 `maxCostUsd` → SDK-native `maxBudgetUsd` is the SINGLE cost chokepoint for the runtime route (broker token gate can't meter it) | VERIFIED | `packages/providers/src/model/extraction-completion-request.ts:44-61` threads `maxCostUsd` by PRESENCE (`!== undefined`, `$0` carries — no fail-open); providers Lesson 8; `extraction-completion-request.test.ts` |
| 4 | **Finding-F:** `meeting.close` cloud arming DEFERRED / inert this crossing; only `source.process` armed | VERIFIED (faithful) | `boot.ts:1207-1218` — meeting.close `outputSchemaId` co-gated for parity but its cloud route is NOT swapped; shipped `capabilityDefaults` (boot.ts:1129-1131) has only `source.process: LOCAL_EXTRACTION_ROUTE`; meeting.close never resolved. Doc's "meeting.close cloud route (Finding-F)" listed as deferred |
| 5 | 18.27 / #13 Finding C — the worker `CANDIDATE_MODEL_SCHEMAS` registers the `agent_extraction` parser so an armed candidate clears the broker schema gate → note e2e | VERIFIED | `backends.ts` registers `AGENT_EXTRACTION_SCHEMA_ID → AgentExtractionCandidateSchema` (commit `a20f9e7d`); `agent-extraction-broker.test.ts:105/213/273`; worker Lesson 64 |
| 6 | GATE-1 REQ-F-017 payoff on a REAL-shaped model output — absent datum ⇒ `TBD` w/ no `evidenceRef`, `validateNoInference` accepts; inferred concrete value w/ no evidence REJECTED, no note | VERIFIED (test) | `agent-extraction-broker.test.ts` `inferred_candidate_rejected_no_note` (REQ-F-017) + `agent_extraction_reconstructs_and_commits` |
| 7 | rule-5 employer-egress veto fail-closed vs the LIVE armed cloud `{runtime}` route (CP2) | VERIFIED (test) | `egress-veto-assembled.test.ts:119` `assembled_broker_denies_employer_raw_cloud_runtime` ⇒ DENY `EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED` at `egress_veto`; positive control `assembled_broker_allows_employer_ack_on_cloud_runtime` (non-vacuity) |
| 8 | Health leg = spend-free login-presence + module-resolvability probe (18.26), fail-closed | VERIFIED | `packages/providers/src/model/subscription-health-probe.ts` STRICT `=== true` both dims, closed-set code reason; boot default `FAIL_CLOSED_REACHABILITY` (`boot.ts:1276`); providers Lessons 9/10 |
| 9 | Subscription runner serves the cloud `{runtime}` route ONLY, fails closed on `provider` routes; reader-holder late-bind fills the content resolver POST-`assembleBackends` | VERIFIED | `createSubscriptionOnlyProviderRunner → denyUnavailable`; `real-extraction-content-resolver.ts:39-80` late-bound reader fails CLOSED (`source_unavailable`) pre-fill; worker Lesson 63 |
| 10 | Note-projection↔extraction-schema field-name alignment DEFERRED (frontmatter under-populates on a task-prefixed multi-task extraction; L49 fail-safe holds, no invention) | VERIFIED (honest deferral) | Named as a future round in the §19.5 GO-LIVE note; L49 fail-safe (`frontmatterValue` TBD-sentinel) unchanged |

**Note (operational, out of code-drift scope):** the GO-LIVE claim "$0.044772 metered (~$0 actual), far under the $1.5-metered cap" is a runbook/session fact (sessions 097–099), not code-verifiable. The `$1.5` staged cost cap constant + config seed are code-present (18.23, worker Lesson 61/55 drift-guard). Auditable to the extent code allows: the path is reachable-on-arm and test-pinned.

## §7 — Provider & Runtime Broker

| # | Contract statement | Verdict | Evidence |
|---|---|---|---|
| 1 | Two ports; extraction runs on the Claude SUBSCRIPTION (Agent SDK `query()`, no key, worker `ANTHROPIC_API_KEY` UNSET); raw `x-api-key` `ModelProviderPort` is the FALLBACK | VERIFIED | Owner-decision block §7:253-255 mirrored by the subscription runner (mirrors `createClaudeCopilotSynthesis`); `extraction-completion-request.ts:4-9` restates the UNSET-key invariant |
| 2 | Pipeline order egress veto → health → budget → schema/tool preserved; runtime route COST via SDK `maxBudgetUsd` (broker token gate inert for it — Finding-F) | VERIFIED | `broker.ts` stage order unchanged; runner asserts `egressClass==="cloud"` defense-in-depth; primary veto precedes run leg |
| 3 | REQ-S-006 candidate-vs-schema gate — provider output is candidate data until the schema gate + validator | VERIFIED | Subscription runner passes `CompletionOutput.structuredOutput` UNVALIDATED → broker `bySchemaIdNormalizer` + `validateNoInference` own the gate (worker Lesson 59) |
| 4 | COST-1 conservative element-wise-MAX pricing projection; fail-closed on malformed (never under-caps) | VERIFIED | `packages/providers/src/broker/pricing.ts:34-54` `Math.max` over per-model rates; throws on empty/NaN/negative; worker Lesson 54 |
| 5 | `CompletionError → GateDeny` KIND-only (rule 7); `auth` ENFORCED TERMINAL (no keychain to HOLD) | VERIFIED | `subscription-extraction-runner.ts:113-155` — auth folds to terminal `provider_unavailable`, never derived from `cerr.retryable` |

## §5 — Employer-Work egress veto (fail-closed, local-only, no cloud fallback)

| # | Contract statement | Verdict | Evidence |
|---|---|---|---|
| 1 | Employer-raw + ack-OFF ⇒ loopback-local ONLY, else fail closed; NO cloud fallback; veto is route-shape-agnostic (a `{runtime}` route skips the provider allowlist and still reaches the veto) | VERIFIED (test) | `egress-veto-assembled.test.ts:119-144` DENY at `egress_veto`; shipped `source.process` stays `LOCAL_EXTRACTION_ROUTE` (ollama/127.0.0.1/`local`), cloud fails closed (boot.ts:1109-1132) |

## §9 — Workflows 1 (meeting closeout) & 4 (source ingestion)

| # | Contract statement | Verdict | Evidence |
|---|---|---|---|
| 1 | Source ingestion (wf 4) real extraction leg over the broker → validator → KnowledgeWriter | VERIFIED | Content resolver derefs the parked `SourceEnvelope.body`; `agent_extraction_reconstructs_and_commits` runs the production `runSourceIngestion` ordering |
| 2 | Meeting closeout (wf 1) real cloud leg — content resolver uniform across `meeting.close`/`source.process`, but the meeting cloud ROUTE is NOT armed this crossing (Finding-F) | VERIFIED (faithful) | `real-extraction-content-resolver.ts:99-101` uniform deref (no capability branch); meeting cloud route deferred (see §19.5 #4) |

## §6 — KnowledgeWriter commit callers carry real content; one-writer

| # | Contract statement | Verdict | Evidence |
|---|---|---|---|
| 1 | Accepted candidate → faithful value+`evidenceRef` reconstruction → `validateNoInference` → KnowledgeWriter note (rule 1; sole writer via `applyPlan`) | VERIFIED | `agent-extraction-broker.test.ts:244` commits via `acts.sourceCommit` (the KMP → `createCommitActivity/applyPlan` path); no direct fs write |

## §16 — Redaction / observability

| # | Contract statement | Verdict | Evidence |
|---|---|---|---|
| 1 | All faults code-only before any log sink (rule 7 — never raw content / prompt / SDK message) | VERIFIED | `ContentResolutionFault {code}` only; `denyFromCompletionError` names KIND only (never SDK message); `SubscriptionHealthReason` closed-set token; `runnerAudit` refs+marker only |

## Appendix A rows

| Row | Verdict | Evidence |
|---|---|---|
| AgentExtractionCandidate (`sow:agent-extraction`) | VERIFIED (snapshot GREEN) | `schemas/agent-extraction.schema.json` — strict outer+inner `additionalProperties:false`, `propertyNames` blocklist `^(?!(?:__proto__\|prototype\|constructor)$)`, `value` anyOf string/number/boolean (excludes null), `evidenceRef` optional. `agent-extraction.snap` = `["fields"]`. Contract tests 24/0 GREEN |
| ProviderRoute | VERIFIED (no drift) | `{runtime\|provider, model, endpoint, egressClass}` — the subscription route is a `{runtime}` route (no `provider`), matching the union; crossing added no field |
| AgentJob | VERIFIED (no drift) | Crossing uses `contextRefs` (source ref), `outputSchemaId`, `maxCostUsd` — all existing frozen fields. 18.27's `outputSchemaId?` was added to the worker-INTERNAL `SourceIngestionParams`, NOT the frozen `AgentJob` (explicitly noted "no frozen-model change") |
| ProviderMatrix / ProposedAction / BrokerOutcome / Capability | VERIFIED (no drift) | `BrokerOutcome = Result<BrokerAccepted, BrokerRejection>` (broker.ts:229) unchanged; no frozen-field add/remove/rename in the crossing ⇒ no cross-doc invariant to mirror |

---

## Mismatch lists

### DRIFT (code ≠ spec, spec is right) — a Finding
_None._

### STALE-DOC (code is right, spec lags) — Architecture-doc note (orchestrator)
1. **§19.5 "Symbols" bullet (`ARCHITECTURE.md:491`)** still names `packages/providers/src/model/http-transport.ts` ("real fetch-based OpenAI-compatible transport, currently zero call-sites") as the crossing's real-transport symbol. The crossing's real injected-`fetch` transport is the NEWER `packages/providers/src/model/real-http-transport.ts` (`createRealModelHttpTransport`, 18.18b) — correctly named in the 18.18b sub-note. The line-491 pointer list is a pre-crossing safe-build artifact; the fallback path is dormant either way (subscription chosen). **Severity: trivial** (a symbol-pointer staleness in a survey bullet, not a contract statement). Optional one-line refresh.

### AMBIGUOUS (can't tell which side is right)
_None._

---

## Bottom line
Every §19.5/§7/§5/§9/§6/§16 statement the crossing touches, plus all six Appendix-A rows, matches the code as built. The four safety-critical crossing mechanisms — the single-signal arming co-gate, COST-1→`maxBudgetUsd` (Finding-F), the `agent_extraction` worker-registry registration (#13 Finding C), and the rule-5 fail-closed veto over the LIVE armed route — are all present and test-pinned; the `sow:agent-extraction` snapshot is GREEN. No DRIFT. **VERDICT: CLEAR.**
