# Session 007 — Phase 6: Connector & Tool Gateways (`@sow/integrations`)

- **Date:** 2026-07-01
- **Predecessor:** `006-2026-07-01-phase4-5-knowledge-broker.md` (Phases 4 + 5, CERTIFIED)
- **Operating model:** single-operator, Workflow-driven (Claude Code, ultracode). One build Workflow (11 agents) + two `/phase-exit` reviewer sub-agents.
- **Outcome:** **Phase 6 BUILT + adversarially verified + FIXED + CERTIFIED (same session).** `/phase-exit 6`: **CLEAR** (both reviewer sub-agents CLEAR). **PHASES 0–6 CERTIFIED.** Phase 7 (§9 Temporal Workflows) is the sole next phase.

> **Cold-start note:** self-contained. Resuming → read this doc + `IMPLEMENTATION_PLAN.md` (Currently-in-progress + Carry-forward + Phase 7), memory `system-of-work-prd` + `solo-session-full-closeout` + `workflow-concurrency-rate-limits`, then use the **Resume prompt** at the bottom.

---

## Headline

Phase 6 (§8 Connector & Tool Gateways) was built as a single `@sow/integrations` package via ONE single-operator Workflow fan-out (foundation → invariant cores → adapters+outbox → NotebookPort → synthesis → a 3-lens adversarial verify), then all findings fixed + both `/phase-exit` reviewers run — all in one session. **The adversarial-verify pass again earned its keep: 3 real findings, one HIGH (a duplicate-external-write race the 20 unit tests missed).** All fixed + regression-tested. **Repo-wide 1941 tests green + 2 todo; typecheck clean (8/8); audit clean.**

## What was built (`@sow/integrations`, 150 tests)

- **Foundation (shared):** gateway-log redaction (§16), payload-hash, OBS-2 health-signal builders, persistence ports (re-exported `@sow/db` `OutboxRepository`/`ConnectorCursorRepository` + a gateway-owned `ReceiptStore`), the §8 candidate-data gate composition (`admitProposedAction`/`admitExternalWriteEnvelope`, ajv+Zod+§3, LESSONS §3), in-memory fakes.
- **6.1 Connector Gateway core:** per-connector cursor (advances ONLY after the consumer succeeds — no silent drop, REQ-I-005), bounded-exponential backoff, typed reachability, auth-locked → held-retryable, reconnect `contentHash` dedupe.
- **6.2 Tool Gateway core (the ONLY external-write path):** the external-write envelope pipeline — candidate-gate + `envelopeMatchesAction` linkage → approval-before-dispatch → **mandatory pre-write existence check** (replay → prior-receipt → live vendor probe; a probe fault → hold, never create) → **atomic reserve** → create → receipt + AuditRecord (payloadHash/refs/summaries only) + redacted log. Conflict/unreachable/rejected are typed (never a blind overwrite / silent drop).
- **6.3 / 6.4 adapters:** 9 connector read adapters (Calendar/Todoist/Linear/Asana/Granola/Drive/GitHub/Telegram-capture/URL-source) + 7 tool write adapters (Calendar/Todoist/Linear/Asana/Drive/GitHub/Telegram), transport-mocked; SourceEnvelope register (gate-then-dedupe, no inference).
- **6.5 Write outbox:** hold-through-outage (held → non-terminal state, never silently expires) + replay-safe drain (re-drives via the SAME dispatch pipeline → zero duplicate external writes) + OBS-2 depth signal.
- **6.6 NotebookPort:** `notebooklm.sync` Drive-backed 00–04 managed-doc upsert with a stable per-slot canonical key; missing/unlinked → `reattach_required`; direct NotebookLM API out of scope (§15).

## The 3 adversarial-verify findings — all FIXED + regression-tested

1. **HIGH — duplicate external write under concurrency.** `dispatchExternalWrite` was check-then-create with no atomic reservation: two interleaved dispatches on the same object both passed the existence check and each fired `adapter.create` (a duplicate external write under a second scheduler — the exact §2.5/§20.1/REQ-NF-006 guarantee). The post-create guard only prevented double-*indexing*. **Fix:** a `ReceiptStore.reserve`/`release` object-identity claim (`(targetSystem, canonicalObjectKey)`) BETWEEN the existence check and the create — only the reservation winner creates; `in_progress` → held, `committed` → reused; a create fault releases. Keyed on object identity, so it also closes the distinct-idempotencyKey-same-object case. Regression: `test/tool-gateway-race.test.ts` (interleaved → exactly one create; fault → release → retry re-claims). **Cross-process atomicity is a Phase-7 carry-forward** (the DB-backed store must implement `reserve` via a unique-constraint insert).
2. **MED — redaction gaps.** The gateway redaction missed Google `AIza…` keys and secrets in URL/query params (`?key=`/`&access_token=`). **Fix:** broadened detection + scrubbing (keeps the URL path, drops the secret). The security review then found a further LOW (AWS/GCS SigV4 `X-Amz-*` signed-URL params) — also FIXED this round. Regression: `test/gateway-redaction-credentials.test.ts` (+ over-redaction guards).
3. **MED — hold-through-outage had no production caller.** The outbox hold machinery was built + tested but nothing wired it. **Fix:** `notebooklm.sync` now enqueues a held (unreachable) Drive write via `holdWrite` when an optional outbox is wired (`NotebookSyncResult.heldForRetry`), instead of failing the sync. Regression in `test/notebook-sync.test.ts`.

## Decisions (this session)

- **`@sow/integrations` depends on `@sow/db` type-only** (the `OutboxRepository`/`ConnectorCursorRepository` interface types) — canonical P1 seams, no runtime/driver coupling.
- **No frozen-contract change needed for Phase-6 health** — `FailureClass` already has `connector_unreachable` + `write_through_failed`; `outbox_blocked` reuses `write_through_failed` (named constant, carry-forward).
- **`ReceiptStore` is a gateway-owned port** (not `@sow/db`); the `reserve`/`release` reservation is atomic in-process, and its cross-process guarantee is deferred to the Phase-7 DB adapter (unique-constraint insert).
- **UI/UX design docs authored this session** (out of the build track, at the owner's request): `docs/design/ui-ux/ui-ux-spec.md` + `design-system.md` — a self-contained spec for prototyping in Claude Design (aesthetic: calm governed control plane; first screen: Today / Command Center).

## Certification

- **`/phase-exit 6`: CLEAR.** `/preflight` green (150 package + 1941 repo-wide + 2 todo; typecheck 8/8; audit clean); `spec-lint tests 6` PASS (§20.1 tagged, §15 waived). Reviewer sub-agents:
  - **arch-drift-auditor CLEAR** — 9 anchors, 0 DRIFT / 2 STALE-DOC / 1 AMBIGUOUS (the STALE-DOC items: Appendix-A already carries `approvalId?`; `GatewayHealthSignal.severity` open string. AMBIGUOUS: per-target `canonicalObjectKey` identity — all carry-forward or doc-tightened). All 3 fixes confirmed real in code.
  - **security-reviewer CLEAR** — 0 critical/high; all 3 fixes independently re-derived as closed (could not construct a two-create interleaving); 1 LOW (AWS SigV4 params) FIXED this round.
- Reports: `docs/audits/phase6-{arch-drift,security}.md`.

## Commit map

| Commit | What |
|---|---|
| _(this round)_ | feat(integrations): Phase 6 §8 — `@sow/integrations` (gateways + envelope + adapters + outbox + NotebookPort) + the 3 adversarial-verify fixes + regression tests + close-out (plan/audits/session/memory) + UI/UX design docs |

---

## Resume prompt (cold start → Phase 7)

> Resume the System of Work Assistant build (repo: SoW-build, `main`, pushed to origin). **Phases 0–6 are COMPLETE and CERTIFIED** (Phase 6 §8 Connector & Tool Gateways `/phase-exit`-CLEAR; both reviewer sub-agents CLEAR; the 3 adversarial-verify findings — incl. a HIGH duplicate-write race — fixed + regression-tested). Read `docs/sessions/007-…` (this handoff) + `006-…`, memory `system-of-work-prd` + `solo-session-full-closeout` + `workflow-concurrency-rate-limits` + `workflow-fanout-burst-stall-repair`, and `IMPLEMENTATION_PLAN.md` (Currently-in-progress + Carry-forward + Phase 7). **Repo-wide 1941 tests green + 2 todo; typecheck clean (8/8); audit clean.**
>
> **Do: Phase 7 — §9 Temporal Workflows & Automation** (`apps/worker` + `packages/workflows`, the integration spine; critical path 3→6→7→8). **This is a forced-serial bottleneck — every feature track (storage/knowledge/providers/gateways) converges here; there is no phase-level parallelism until 7 certifies (then Phase 8 worker ∥ Phase 10 eval-security reopen).** Build lifecycle correctness FIRST (LIFE-1 single-active-instance lease · LIFE-2 durable schedules with collapsed catch-up · LIFE-3 idempotent in-flight resume reusing the §8 external-write envelope · LIFE-5 clock-jump-safe last-run), then the **meeting-closeout proof spine** (Flow 1) first among the 13 workflows, then the rest. Each workflow is a `WorkflowRun` (idempotencyKey + audit refs), enforces its DOMAIN_MODEL state machine, routes ALL semantic writes through KnowledgeWriter and ALL external writes through the Tool Gateway envelope, surfaces every failure class as a distinct persistent System Health item, and assigns a workspace before any durable processing. Hermes autonomous automation is gateway-routed (no duplicate/ungoverned/hidden-brain write). Depends on 2+4+5+6 (all satisfied). Spec: ARCHITECTURE §9 + IMPLEMENTATION_PLAN §7 (tasks 7.1–7.x). **Reuse the candidate-data gate composition** (ajv+Zod+§3, never ajv alone) for the §9 meeting validator (the last open consumer, LESSONS §3).
>
> **Phase-7 MUST discharge these carry-forwards (see plan Carry-forward):** (a) the §9 meeting validator gate composition (last open); (b) the **Phase-6 gateway seams** — supply the DB-backed `ReceiptStore` with `reserve` via a unique-constraint insert (cross-process no-duplicate-write), bind `@sow/policy requiresApproval(action, resolvedWorkspacePolicy)` + the Approval store into the Tool Gateway's injected `requireApproval`/`recordPendingApproval`/`isApproved` ports, and wire real `ConnectorTransport`/`AdapterTransport` vendor clients + per-target `IdentityDeriver`s; (c) the §7 broker must supply `resolveRoute`'s `localConfig` + decide broker-vs-§9 budget-health attachment; (d) `apps/worker` session-auth wiring (auth-guard, the Phase-3/7 deferment); (e) OBS-2 `FailureClass` named-constant cluster (`policy_denial`/`egress_status`/`provider_routing_unavailable`/`db_unavailable`/`outbox_blocked`) — pin as distinct enum members in one frozen-contract round if §9/§16 wants them distinct; (f) the §9 System-Health materializer owns the persisted `HealthItem` (+ closed severity) that `GatewayHealthSignal` feeds. HealthItem persistence → Phase 10 (approved). ESLint+Prettier still placeholders.
>
> **Method:** single-operator + Workflow fan-outs (≤2 concurrent, narrow batches ~≤3–4, retry only failed agents — memory `workflow-concurrency-rate-limits`); TDD (deterministic workflow/lifecycle control logic test-first) + the eval path for any LLM generation; **a strong adversarial-verify stage on the lifecycle invariants + the meeting-closeout write path** (LIFE-3 replay / no-duplicate-side-effect has caught a gate-bypass in every phase so far); Zod-as-source for any new contract; commit per batch (explicit `git add`, never `-A`; Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; allowlist TDD-fixture secrets by fingerprint in `.gitleaksignore` with full-line comments); push origin/main. **Run the FULL solo close-out** per memory `solo-session-full-closeout` (session doc, hot-routing, `/orchestrate-end` incl. Step-5.5 Carry-forward triage, formal `/phase-exit 7` with arch-drift + security + reachability sub-agents). Effort: ultracode. Don't touch `.env`/`scaffold/`.
