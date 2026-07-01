# Session 006 — Phases 4 + 5: Knowledge (`@sow/knowledge`) + Provider/Runtime Broker (`@sow/providers`)

- **Date:** 2026-07-01
- **Predecessor:** `005-2026-07-01-phase3-policy-security-egress.md` (Phase 3 — §5 policy, CLEAR)
- **Operating model:** single-operator, Workflow-driven (Claude Code, ultracode). Two concurrent Workflows.
- **Outcome:** **Phases 4 + 5 BUILT + adversarially verified + FIXED + CERTIFIED (same session).** `/phase-exit 4`: CLEAR and `/phase-exit 5`: CLEAR — all 4 reviewer sub-agents CLEAR. Phase 5's 2 findings + Phase 4's 4 findings (+ a Phase-4-security NUL-separator auditability finding) all fixed + regression-tested. **PHASES 0–5 CERTIFIED.** Only **Phase 6 (§8 Gateways)** remains for a fresh session.

> **UPDATE (same session, later):** the initial plan deferred the fixes + certification to a fresh session, but the user chose to finish 4+5 exit in-session. All findings were fixed (incl. finding #3 as a proper frozen-contract change, and finding #4 secure-by-default), regression-tested (repo-wide 1790 green), and both phases certified via the 4 reviewer sub-agents (all CLEAR). See "Certification" below.

> **Cold-start note:** self-contained. Resuming → read this doc + `IMPLEMENTATION_PLAN.md` (Currently-in-progress + the PHASE-4 PRE-CERTIFICATION BLOCKERS in Carry-forward) + memory `system-of-work-prd`, then use the **Resume prompt** at the bottom.

---

## Headline

The user chose to fork **Phase 4 (§6 Knowledge)** and **Phase 5 (§7 Broker)** as **two concurrent Workflows** (rate-limit-conservative: narrow batches, ≤2 workflows). Both built against the certified `@sow/policy`. Each ended with a hard adversarial-verify pass. **Repo-wide 1781 tests green; typecheck clean.** Both committed + pushed. Formal certification (reviewer sub-agents) + the Phase-4 finding-fixes were **deliberately deferred to a fresh session** rather than rushed on deep context — per LESSONS §4 (don't rush safety-critical fixes) — because Phase 4 is the most safety-critical subsystem (safety rule 1).

## Phase 5 — §7 Provider/Runtime Broker (`@sow/providers`, commit `ac9f9b8`) — findings FIXED

- Two ports (`ModelProviderPort` + `AgentRuntimePort` + `AgentResult`); the fixed-order gate pipeline (admission→route-resolution→**egress-veto**→health→budget→schema/tool→normalize→emit-candidate); transport-mocked adapters (Claude/OpenAI/OpenRouter/Ollama/LM Studio + Claude Agent SDK/Hermes); the conformance harness (`packages/evals`) + a `ConformanceResult` contract (Zod-as-source). Strict side-effect rule enforced; COST-1/2 budget; Hermes empty-toolset invariant honored. **232 tests.**
- **Adversarial verify → 2 real findings (HIGH + MED, same root cause), FIXED + regression-tested:** the broker resolved + egress-vetoed the *matrix* `route`, but the budget/cost enforcer + the two runtime adapters read the job's OWN `providerRoute` — so the egress veto didn't bind the EXECUTED target and COST caps priced the wrong route. **Fix (single point):** after the veto, the matrix-resolved+vetoed route is threaded as the job's **effective route** (`effectiveJob = { ...job, providerRoute: route }`) into execution + budget. `test/adversarial-regressions.test.ts` pins it (run + budget receive the matrix route, never the divergent `providerRoute`). The budget-candidate-gate lens was CLEAR.

## Phase 4 — §6 Knowledge (`@sow/knowledge`, commit `aecb8f1`) — 4 findings OPEN

- KnowledgeWriter sole-writer (composed candidate-data gate → atomic commit → compare-revision → idempotent replay → exactly-one revision/audit) · human-owned section preservation (stable region IDs) · blocking secret scan · post-commit async GBrain sync + outbox · tombstone commit-point · fs-watch out-of-band reconciliation · GBrain read/query-only adapter + version-pin + index-sync + parity/quarantine/rebuild · GCL Visibility Gate + global-Markdown reconcile + Level-3 links · the **write-through/divergence layer (7 invariants):** gbrain-INDEPENDENT CanonicalFactDeriver, HMAC SignedProvenanceStamper, ParityReconciler + DivergenceClassifier, MarkdownRehydrationServingGate (bytes-from-Markdown, default-deny) + QuarantineLedger, RemediationRouter + propose-only GenerativeProposalIntake, GbrainWriteFence, WriteThroughEnableFlag (default OFF) + CrashRecoveryReconciler. **341 tests.**
- **Adversarial verify:** the safety-critical **serving/quarantine lens is CLEAR** (a fact serves only if Markdown-rehydrated+hash-matched AND signature-valid AND in-allow-set AND not-quarantined; forged/borrowed stamp rejected; quarantine keyed on content-independent factIdentity — no resurrection). **4 open findings (3 MED + 1 LOW) — documented as pre-certification blockers in `IMPLEMENTATION_PLAN.md` Carry-forward:**
  1. MED — fs-watch reconcile misattributes a rollback-to-a-prior-KW-state as a fresh KW write (lost-update).
  2. MED — GCL Level-3 link ignores the owner Approval's `expiresAt`/status (time-boxed grant leaks).
  3. MED — the `GclProjection` raw-content refine is a 3-key denylist (a **Phase-1 frozen-contract** weakness → contract-level fix).
  4. LOW — KnowledgeWriter `secret-scan`/`ownership` deps default to pass-through (fail-open; no production caller yet).

## Decisions (this session)

- **Fork 4 + 5 concurrently** (owner choice), run 2-at-a-time with narrow batches (memory `workflow-concurrency-rate-limits`).
- **Defer certification + Phase-4 fixes to a fresh session** (operator judgment): the operator was deep in context after Phase 3's full cycle + Phase 5's fix; Phase 4 is the most safety-critical subsystem and its 4 findings include a frozen-contract change + subtle attribution logic. Rushing safety-critical fixes on deep context is exactly what LESSONS §4 warns against. Both phases are committed as **honest verified-built checkpoints** (not certified), so no work is lost and the fixes get full context.
- **`.gitleaksignore`** — the secrets-guard hook (gitleaks) blocked commits on 3 TDD fixtures (fake keys that *test* the scanners/redaction). Allowlisted by fingerprint (full-line comments only — inline `#` breaks gitleaks' exact-match).

## Process note

Both Workflows ran concurrently and completed. **Phase 4 hit burst-stalls** (agents 4.2, 4.5, 4.16, 4.17 stalled + auto-retried; all self-recovered — see memory `workflow-fanout-burst-stall-repair`). Phase 5 ran clean. The `pnpm install` race I flagged did not materialize (the two foundation installs didn't collide). Adversarial verify again earned its keep on Phase 5 (a real egress-veto-doesn't-bind-execution gap that 232 unit tests missed).

## Certification (added same session)

The 6 findings were all fixed + regression-tested (repo-wide **1790** green; typecheck + audit clean), then both phases certified via 4 reviewer sub-agents — **all CLEAR**:

- **Phase-4 fixes (`84c3c7e`):** fs-watch rollback lost-update (HEAD-only KW attribution + `rollback_to_prior_kw_state` conflict) · GCL Level-3 link honors `Approval.expiresAt` (fail-closed via `req.at`) · **`GclProjection` raw-content gate → KEY-NAME-INDEPENDENT** (frozen-contract change: recursive scan rejecting a raw-content-shaped key OR any multi-line/>1024 string; ARCHITECTURE Appendix A + `contracts/CLAUDE.md` updated; schema + snapshot unchanged) · KnowledgeWriter secure-by-default (real ownership + secret-scan defaults).
- **Phase-5 fixes (`ac9f9b8`):** the vetted matrix route is threaded as the job's effective route into execution + budget (the veto now binds the executed target; COST-1/2 meters it).
- **`/phase-exit 4`: CLEAR** — arch-drift 13 anchors 0 DRIFT/0 STALE/0 AMBIGUOUS (the write-through 7 invariants all confirmed); security rules 1/2/4/7 PASS. **1 medium auditability finding fixed** (`944c76f`): three files (`revision.ts`, `canonical-fact-deriver.ts`, `cross-workspace-links.ts`) used a literal NUL byte separator → git binary → unreviewable diffs; swapped for `String.fromCharCode(0)` (the codebase's own convention), behavior-preserving.
- **`/phase-exit 5`: CLEAR** — arch-drift 0 DRIFT / 1 STALE-DOC (`provider_routing_unavailable` FailureClass → carry-forward) / 1 AMBIGUOUS (broker-vs-§9 budget-health); security strict-side-effect + rule 5/6/7 + COST-1/2 PASS. *(Phase-5 security run 1 hit a transient API error; the retry landed CLEAR.)*
- Reports: `docs/audits/phase{4,5}-{arch-drift,security}.md`.

## Commit map

| Commit | What |
|---|---|
| `aecb8f1` | feat(knowledge): Phase 4 §6 — `@sow/knowledge` (70 files) |
| `ac9f9b8` | feat(providers): Phase 5 §7 — `@sow/providers` + eval harness (74 files) |
| `84c3c7e` | fix(knowledge): the 4 Phase-4 adversarial-verify findings + regression tests |
| `944c76f` | fix(knowledge): literal NUL separators → `String.fromCharCode(0)` (auditability) |
| _(this doc + plan/DECISIONS/memory sync)_ | close-out |

---

## Resume prompt (cold start → Phase 6)

> Resume the System of Work Assistant build (repo: SoW-build, `main`, pushed to origin). **Phases 0–5 are COMPLETE and CERTIFIED** (Phase 4 §6 knowledge + Phase 5 §7 broker both `/phase-exit`-CLEAR, all 4 reviewer sub-agents CLEAR; all findings fixed + regression-tested). Read `docs/sessions/006-…` (this handoff, incl. the Certification section) + `005-…`, memory `system-of-work-prd` + `solo-session-full-closeout` + `workflow-concurrency-rate-limits` + `workflow-fanout-burst-stall-repair`, and `IMPLEMENTATION_PLAN.md` (Currently-in-progress + Carry-forward + Phase 6). **Repo-wide 1790 tests green; typecheck clean; audit clean.**
>
> **Do: Phase 6 — §8 Connector & Tool Gateways** (`packages/integrations`, on the critical path 3→6→7). The **Connector Gateway** (external READS: connector auth scoping, cursors, retry/backoff, health signals; connector-unreachable → queue + bounded-exponential-backoff + drain-on-reconnect, no silent drops) + the **Tool Gateway** (the ONLY external-write path — the external-write envelope: approval policy + `idempotencyKey` + `canonicalObjectKey` + **pre-write existence check** [vendor create-tools lack native idempotency → match-by-canonical-key-then-reuse-on-hit] + payload hash + **write receipt**; replay reuses the receipt/matched object → **zero duplicate external writes**; outbox holds during connector outage) + NotebookPort (`notebooklm.sync` managed-doc upsert). Depends on 1+3 (satisfied). Consumes `@sow/policy` (approval/tool policy) + the frozen `ProposedAction`/`ExternalWriteEnvelope`/`WriteReceipt`/`NotebookMapping`/`SourceEnvelope`. Spec: ARCHITECTURE §8 + IMPLEMENTATION_PLAN §6. **Reuse the Phase-3 candidate-data gate composition** (`admitCandidateJob` pattern — ajv + Zod + §3 rules) for any provider/agent output; never ajv alone.
>
> **Carry forward (see plan Carry-forward):** candidate-data gate composition still open for §9 (§5/§7 discharged); the OBS-2 `FailureClass` named-constant arch_gaps (`policy_denial`/`egress_status`/`provider_routing_unavailable`/`db_unavailable` — pin as enum members if §16 wants distinct items); the §7 broker (Phase 7) must supply `resolveRoute`'s `localConfig` + decide broker-vs-§9 budget-health attachment; session-auth apps/* wiring → Phase 7/9; HealthItem persistence → Phase 10 (approved); ESLint+Prettier still placeholders.
>
> **Method:** single-operator + Workflow fan-outs (≤2 concurrent, narrow batches, retry only failed agents — memory `workflow-concurrency-rate-limits`); TDD; a strong adversarial-verify stage on safety-critical phases (it has caught a CRITICAL or HIGH gate-bypass in every phase so far); Zod-as-source for new contracts; commit per batch (explicit `git add`, Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context)`; allowlist TDD-fixture secrets by fingerprint in `.gitleaksignore` with full-line comments); push origin/main. **Full close-out per memory `solo-session-full-closeout`.** Effort: ultracode. Don't touch `.env`/`scaffold/`.
