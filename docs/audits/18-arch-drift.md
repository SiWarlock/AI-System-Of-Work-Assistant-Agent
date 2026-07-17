# Phase-18 — Architecture-drift audit (`/phase-exit 18`)

- **Phase:** 18 (§19.5 — Real Model Transport & Intelligence Legs; safe-build / dormant)
- **Auditor:** arch-drift-auditor (read-only)
- **Date:** 2026-07-17
- **Anchors audited:** §19.5 (primary, BUILD-LANDED block), §7, §5, §9, §6, §16 + Appendix A rows
  (ProviderMatrix, ProviderRoute, AgentJob, ProposedAction, BrokerOutcome, Capability)
- **Slice commits:** `99cae521 d4c2a9a0 3af7e58d 0bbb281c 2068039f 8d9c6507 f1318db2 55f0a33a 29555821`
  (all 9 present; subjects match the §19.5 per-slice descriptions).
- **Verdict:** **CLEAR** — 0 DRIFT findings. 1 STALE-DOC note, 0 ambiguous.

Everything Phase-18 shipped is SAFE-BUILD / dormant behind default-OFF seams (crossing #13 owner-gated).
A documented dormant-till-arming seam is not drift. Scope: the cited anchors + their Appendix-A rows only.

---

## Verified-by-test shortcut — Appendix A frozen models

Phase-18 touched **no** `packages/contracts/src/models` file (`git diff --name-only 99cae521~1 29555821`
⇒ zero model files). The frozen models the anchors name are therefore unchanged, and their
schema-snapshot tests are **GREEN**:

- `packages/contracts/test/models/{provider-matrix,provider-route,proposed-action,agent-job,capability}.test.ts`
  ⇒ **PASS (65) FAIL (0)**. → ProviderMatrix, ProviderRoute, ProposedAction, AgentJob, Capability = verified-by-test, re-derivation skipped.
- **BrokerOutcome** is **not** an Appendix-A frozen model (no row, no `.snap`); it is a providers-internal
  type (`packages/providers/src/broker/broker.ts:223` `Result<BrokerAccepted, BrokerRejection>`). Its consumed
  shape (`outcome.value.candidate`) is read correctly by `mapAcceptedMeetingExtraction`. No frozen-contract obligation.

---

## Per-anchor statement table

### §19.5 BUILD-LANDED block (primary) — per slice

| # | Stated behavior | Verdict | Evidence |
|---|---|---|---|
| 18.1 | stub run leg → real `ProviderRunner` via AND-composed default-OFF gate (`enabled===true && typeof make==="function"` ⇒ real; else byte-identical stub) | ✅ match | `provider-runner.ts:78-86` `selectProviderRunner`; `backends.ts:779` wires `createStubProviderRunner(extraction)` as stub |
| 18.1 | `createRealProviderRunner` selects ModelProviderPort adapter by `route.provider`, `.complete()`, maps `ProviderOutput→AgentResult`; `runtime`-branch (AgentRuntimePort) fail-closed | ✅ match | `provider-runner.ts:189-256` (5-provider registry; `runtime` route ⇒ `denyUnavailable`) |
| 18.1 | `ProviderError→GateDeny`, **never throwing** (§16); rogue throw folds typed (totality) | ⚠ STALE-DOC (label only) | `denyFromProviderError` `:131-148`; catch `:257-261` → `denyUnavailable` reason **`provider_unavailable`**, not `route_failed` as the prose/Lesson-43 say. Totality + typed-deny + redaction hold; only the reason-code NAME in the doc is wrong. See note S-1. |
| 18.1 | key via §19.4 degraded `getSecret`; missing/locked ⇒ retryable HOLD via never-reject controller, no plaintext | ✅ match | `:197-198` `createLockRoutingSecretsAccessor`; `:249-255` `controller.holdJob` on `auth_unavailable` |
| 18.1 | egress veto PRECEDES the run leg; local routes on loopback allowlist (rule 5) | ✅ match | broker fixed-order pipeline; local adapters carry `allowedEndpoints`; `http-transport.ts:410 assertLocalEndpointAllowed` |
| 18.2 | 3 stub gates → real `@sow/providers` gates | ✅ match | `backends.ts:771/773/783` `createHealthGate`/`createLedgeredBudgetGate`/`createSchemaGate` |
| 18.2 | deny-only policing ⇒ ACTIVE by default, no dormancy knob | ✅ match | gates wired unconditionally (no flag) |
| 18.2 | NEW `BudgetLedgerPort` wraps `createBudgetGate`; single-run in-boot; durable §19.6 plugs in BACKWARD; `.record` try/caught | ✅ match | `budget-ledger.ts` (`createLedgeredBudgetGate` `:94-119`, `.record` try/catch `:106-115`, `createSingleRunBudgetLedger`) |
| 18.2 | `meeting.close` candidate = KMP stand-in under registered KMP schema | ✅ match | `backends.ts:575-578` `CANDIDATE_MODEL_SCHEMAS` = {KMP, ProposedAction} |
| 18.5/18.6 | bind `{ws,projectId}` ONLY from registry ENTRY on ≥0.7; else park (REQ-F-017); source `routingHints.projectRef`/ws never authoritative (WS-8) | ✅ match | `content-project-resolver.ts` DEFAULT_THRESHOLD `:34`=0.7; bind from `entry` `:99`; park `:141` |
| 18.5/18.6 | threshold single-sourced (`===threshold` ⇒ bind); byte-equivalent boot default (never parks) | ✅ match | `DEFAULT_THRESHOLD` exported + `>=` boundary `:137/191`; `createBootWorkspaceContentResolver` `confidence:1` `:110-115` |
| 18.3 | `mapAcceptedMeetingExtraction` narrows `outcome.ok`+candidate; non-accepted ⇒ EMPTY, never echo `params` | ✅ match | `meeting-extraction.ts:35-46`; `buildActivities.ts:455` |
| 18.3 | real structural `createMeetingExtractionSchemaGate` (non-empty; `{value: primitive\|TBD, evidenceRef?}`; malformed ⇒ `schema_rejected`; never coerce/throw) | ✅ match | `meeting-extraction.ts:65-99` |
| 18.3 | division of labor (structural gate + `validateNoInference`); evidence-bearing recon DEFERRED (KMP stand-in discards `evidenceRef`) | ✅ match | `buildActivities.ts:464`; `meeting-extraction.ts:42-44` |
| 18.4 | source bypass → `createSourceAgentBrokerRouting`; job `source.process`/read_only/untrusted/carriesRawContent; `admitJob` (ING-7) BEFORE `broker.runJob`; gate-on-outcome | ✅ match | `source-extraction.ts:136-210`; `buildActivities.ts:782` `capability:"source.process"`; admit `:181` before runJob `:197` |
| 18.4 | mutating toolPolicy ⇒ `admission_rejected`; ws from routing-bound `ctx.workspaceId`, never `ctx.source.workspaceId`; unbound fails closed | ✅ match | `source-extraction.ts:148-161,181-187` |
| 18.7 | `externalActionProposals` from `produceProposedActions` (pure, no gateway dep) + meeting mirror; keys from BINDING + §8 builders, never content; non-concrete intent ⇒ `[]` | ✅ match | `proposed-action-producer.ts` (`buildCanonicalObjectKey`/`buildIdempotencyKey`); `buildOutputs.ts:198-246` |
| 18.7 | rule-3 `payloadHash = payload:<targetSystem>:sha256(payload)` (digests payload, not identity key); `auto_private` only auto-eligible | ✅ match | `proposed-action-producer.ts` (`payload:${targetSystem}:${sha256hex(JSON.stringify(payload))}`; policy `requires_approval`) |
| 18.8 | SOURCE-note frontmatter carries validated owner/dueDate over FIXED `["owner","dueDate"]`; TBD-when-absent + `neutralizeFrontmatterValue`; reuses meeting helpers | ✅ match | `buildActivities.ts:867-879` (`SOURCE_FRONTMATTER_FIELDS`, `frontmatterValue`, `neutralizeFrontmatterValue`) |
| 18.8 | reaches note ONLY via validated KMP → `createCommitActivity → applyPlan` (rule 1); ws routing-bound; path identity-derived | ✅ match | `buildActivities.ts:858-907` (KMP `creates[].frontmatter`, `workspaceId: ws`) |
| 18.9 | assembled broker + raw employer + cloud + ack-OFF ⇒ DENY `EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED`, no cloud fallback; veto precedes allowlist; tunneled-`local` DENIES | ✅ match | `egress.ts:74-158` (veto step 2 `:119-134` before allowlist step 3 `:137-153`); test `egress-veto-assembled.test.ts` |
| 18.9 | OpenRouter classified CLOUD (own processor, never OpenAI alias / laundered local) | ✅ verified-by-test | veto keys on `proc = processorOfRoute(route)` (`egress.ts:107`); OpenRouter-own-processor asserted by the 18.9 assembled test + Lesson 50 (I did not re-read `processorOfRoute` — verify+pin slice, no prod change) |
| 18.10 | `gateAutoIngest` strict `opts.autoIngest !== true` is SOLE chokepoint; worker-host passes `config.autoIngest` raw; truthy-not-`true` guarded | ✅ match | `boot.ts:627` `if (opts.autoIngest !== true || vaultRoot === undefined) return undefined`; `worker-host/index.ts:219`; test `29555821` |

### Supporting anchors

| Anchor | Checkable statement | Verdict | Evidence |
|---|---|---|---|
| §7 | two ports; broker order matrix route → egress veto → health → budget → schema/tool; run leg produces candidate schema validates | ✅ match | `provider-runner.ts` binds ModelProviderPort, `runtime` route fail-closed; `backends.ts:766-784` gate wiring; egress precedes run |
| §7 | BudgetLedgerPort seam, single-run in-phase, upgradable to §19.6 durable ledger | ✅ match | `budget-ledger.ts` (comment + `createLedgeredBudgetGate` backward-plug) |
| §5 | Employer-Work raw + ack-OFF ⇒ loopback-local only, else fail closed, no cloud fallback | ✅ match | `egress.ts:119-135` |
| §9 | extraction legs hold REQ-F-017 (no-inference / park; never invent owner/date) | ✅ match | meeting (`meeting-extraction.ts`), source (`source-extraction.ts`), routing park (`content-project-resolver.ts:141/198`); TBD sentinel `buildActivities.ts:873-879` |
| §6 | KnowledgeWriter commit callers carry real content (task 18.8) via KMP, not direct fs write | ✅ match | `buildActivities.ts:866,881-907` (real body 15.3 + validated frontmatter into KMP → `applyPlan`) |
| §16 | never-throw / redaction | ✅ match | `provider-runner.ts` totality catch `:257-261`; `denyFromProviderError` kind-only (never provider message); `budget-ledger.ts:106-115` try/catch; `egress.ts` pure fail-closed guard `:83-105` |

---

## Mismatch lists

### DRIFT (code ≠ spec, spec is right) — escalates as a Finding
**None.** No code contradicts a right spec statement. Verdict CLEAR.

### STALE-DOC (code is right, doc lags) — Architecture-doc notes for the orchestrator

**S-1 (low severity).** §19.5 slice-18.1 narrative and worker **Lesson 43** state a rogue-collaborator
throw in the run leg "folds to a typed **`route_failed`** (totality)". The shipped run leg folds it to
**`provider_unavailable`** (`provider-runner.ts:257-261` catch → `denyUnavailable` → `reason:"provider_unavailable"`,
`branch:"failed_terminal"`). The **load-bearing property is satisfied** — the run leg is total (never throws),
returns a typed `GateDeny`, and is redaction-safe. `route_failed` is actually the *classifier's* fault code
(18.5/18.6 `content-project-resolver.ts:147/204`), not the run leg's — the doc conflated the two legs.
**Code is correct + safe; only the reason-code label in the §19.5 18.1 prose (and Lesson 43's one-liner)
is inaccurate.** Suggest: correct the label to `provider_unavailable` in the §19.5 18.1 bullet + Lesson 43.
Not a gate blocker.

### AMBIGUOUS (can't tell which side is right)
**None.**

---

## Notes / method
- Appendix-A frozen models confirmed unchanged (no `packages/contracts` model touched) + snapshot suite green →
  verified-by-test shortcut applied; not re-derived.
- Did not re-run the broker/composition test suites (out of scope for arch-drift; `/preflight` is a separate row).
  The only tests executed were the frozen-model schema-snapshot tests (the verified-by-test shortcut) — PASS 65/0.
- The 18.9 OpenRouter-CLOUD-classification is asserted by the 18.9 assembled-broker test (verify+pin slice, no
  production change); `processorOfRoute` itself was not re-read.
