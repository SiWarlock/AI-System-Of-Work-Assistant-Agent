# Session 008 — Phase 7: Temporal Workflows & Automation (`@sow/workflows` + `@sow/worker`)

- **Date:** 2026-07-01 → 2026-07-02
- **Predecessor:** `007-2026-07-01-phase6-gateways.md` (Phase 6 §8, CERTIFIED)
- **Operating model:** single-operator, Workflow-driven (Claude Code, ultracode). A SEQUENCE of Workflow fan-outs (foundation → proof spine → workflows A → workflows B), each with its own adversarial-verify + targeted repair passes; two `/phase-exit` reviewer sub-agents.
- **Outcome:** **Phase 7 BUILT + adversarially verified + FIXED + CERTIFIED.** `/phase-exit 7`: **CLEAR** (both reviewer sub-agents CLEAR). **PHASES 0–7 CERTIFIED — the integration spine is complete.**

> **Cold-start note:** self-contained. Resuming → read this doc + `IMPLEMENTATION_PLAN.md` (Currently-in-progress + Carry-forward + Phase 8 / Phase 10), memory `system-of-work-prd` + `solo-session-full-closeout` + `workflow-concurrency-rate-limits`, then use the **Resume prompt** at the bottom.

---

## Headline

Phase 7 (§9) is the integration spine — a forced-serial bottleneck every prior track converges into. Built the durable **`@sow/workflows`** (pure orchestration + lifecycle core) + **`@sow/worker`** (thin Temporal binding) on Temporal 1.19.0, as four sequenced Workflow waves. **The adversarial-verify pass earned its keep at every single wave** — 1 CRITICAL + 8 HIGH across the phase, all fixed + regression-tested + independently re-verified CLEAR. The recurring bug-class it caught (and then prevented in later waves): *a guard reads a field/flag that is not what actually flows to the side effect.*

## Architecture (established this phase)

- **Two-layer split:** `@sow/workflows` = PURE, deterministic orchestration drivers over the Phase-1 `@sow/domain` state machines + injected activity ports + `resolveRun` idempotency + the 7.5 health sink — Vitest-tested with fakes, **no Temporal server needed**. Drivers are sandbox-safe (no `@temporalio`, no `node:crypto`, no `Date.now()`); activities do the I/O + wire the real adapters. `@sow/worker` = the thin Temporal binding (bootstrap + lease).
- **Gated Temporal testing:** live-Temporal / time-skipping tests are gated behind `SOW_TEMPORAL=1` (default-skipped, mirroring Phase-2's `SOW_PG_DOCKER`), so a missing dev server never blocks the suite.
- **Governance patterns mandated in every wave's brief** (so the 7.6 CRITICAL never recurred): DERIVE-committed-outputs-from-validated-data + bound-workspace; KnowledgeWriter-and-Tool-Gateway-only; any leakage guard runs over the ACTUALLY-DISPATCHED artifact; GCL Visibility Gate for cross-workspace; `resolveRun` idempotency; a distinct OBS-2 health item on every failure.

## What was built (18 tasks)

- **Durability foundation (7.1–7.5):** LIFE-1 fenced single-active lease + worker bootstrap + Temporal-unavailable degraded mode · LIFE-2 collapsed catch-up + LIFE-5 clock-jump-safe (monotonic epoch-guarded) · LIFE-3 in-flight resume + §8 external-write-envelope reuse · WorkflowRun registry + idempotency seam · OBS-2 System Health surfacing + materializer.
- **The 13 workflows (7.6–7.18):** 7.6 meeting-closeout proof spine · 7.7 source ingestion · 7.8 inbox triage · 7.9 approval flow (deferred snooze/expiry) · 7.10 daily brief · 7.11 weekly/monthly review · 7.12 cross-calendar scheduling · 7.13 project sync (deterministic progress) · 7.14 cross-store deletion saga · 7.15 connector sync/health · 7.16 NotebookLM sync · 7.17 Copilot Q&A (read-path) · 7.18 Hermes gateway-routing.

## Findings fixed (per wave; all re-verified CLEAR)

- **Foundation — 9 (1 CRITICAL + 4 HIGH + 2 MED + 2 LOW):** CRITICAL — the clock compared a *persisted monotonic reading across process/boot epochs* (cross-restart starve/double-fire) → epoch-guarded + wall fallback. HIGH — catch-up ignored the jump-safe clock; the lease had no fencing token (Mac-sleep split-brain); resume keyed committed work by `stepId` not idempotencyKey (KW re-commit); `resolveRun` was a non-atomic read-then-create (duplicate run).
- **7.6 — CRITICAL + HIGH:** the no-inference gate validated the agent extraction but committed a *caller-supplied plan decoupled from it* → an inferred owner/date reached KnowledgeWriter. Fixed by DERIVING the committed plan + actions from the validated extraction (`BuildOutputsPort`) + stamping the correlation-bound workspace.
- **7.7–7.12 — 2 HIGH + 1 MED:** approval exactly-once — the activity misread the shipped `decideApprovalCas` `idempotent_noop` (`ok(current)`) as `applied:true`, so a second-channel/replay approve re-dispatched; fixed at the ROOT by widening `@sow/db ApprovalRepository.applyTransition` to surface `ApprovalTransitionOutcome { approval, applied }` (both dialects + Phase-2 contract tests updated). Cross-calendar leakage — the guard ran on a decoy `genericExplanation` field, not the dispatched payload; fixed with a key-name-independent raw-content check over the actual payload.
- **7.13–7.18 — 1 HIGH (2 cycles):** deletion-saga per-step idempotency keys were content-blind — first fix scoped them to the region set, the deeper fix folds each deleted region's **live-content hash** so a re-materialized subject (same region id, new content) re-tombstones + re-purges (no un-tombstoned survivor, no resurrected GBrain entry), while identical content stays idempotent.

## Certification

- **`/phase-exit 7`: CLEAR.** Preflight green (`@sow/workflows` 438 + `@sow/worker` 13 [1 gated skip] + `@sow/db` 275 both-dialects; repo-wide **2392** green + 2 todo; typecheck 10/10; `pnpm audit --prod` clean — a NEW moderate `protobufjs` transitive from the Temporal deps was FIXED via a `pnpm-workspace.yaml` override to `^7.6.3`; `spec-lint tests 7` PASS, §2.5 waived).
  - **arch-drift-auditor CLEAR** — 9 anchors, 0 DRIFT / 2 STALE-DOC (doc-annotation notes) / 0 AMBIGUOUS; all LIFE invariants + all 18 tasks + every fix confirmed in code.
  - **security-reviewer CLEAR** — 0 critical/high/medium; 7/7 invariant passes PASS; all fixed findings independently re-derived closed; 2 LOW (heuristic leakage-allowlist; redact error `cause`) → Phase-10.
  - Reachability judgment-WAIVED (no production Temporal entrypoint yet — the worker-wiring wave is deferred).
- Reports: `docs/audits/phase7-{arch-drift,security}.md`.

## Decisions (this session)

- **`@sow/db` ApprovalRepository return widened** to `ApprovalTransitionOutcome { approval, applied }` — the atomic CAS-kind is the correct exactly-once signal (a replay/second-channel no-op reports `applied:false`; only the genuine transitioner dispatches). Not a frozen Appendix-A seam.
- **protobufjs override** in `pnpm-workspace.yaml` (`^7.6.3`) to clear the Temporal-transitive moderate advisory; the two ignored build scripts (`@swc/core`, `protobufjs`) set to `false` (prebuilt/fallback artifacts suffice).
- **Two Workflow "failures" were cosmetic** — a synth/foundation agent hit the StructuredOutput retry cap *while returning its result*; the work always landed on disk. Later waves wrapped synth/verify in `parallel()` so a report-format hiccup can't fail the run.

## Commit map

| Commit | What |
|---|---|
| `9a61db5` | feat(workflows): durability foundation (LIFE-1/2/3/5 + registry + health) |
| `7fed14c` | feat(workflows): 7.6 meeting-closeout proof spine |
| `ba893c2` | feat(workflows): 7.7–7.12 workflows A (+ @sow/db CAS-kind) |
| `ea2a342` | feat(workflows): 7.13–7.18 workflows B |
| _(this doc + plan/audits/memory + protobufjs override)_ | close-out |

---

## Resume prompt (cold start → Phase 8 ∥ Phase 10)

> Resume the System of Work Assistant build (repo: SoW-build, `main`, pushed to origin). **Phases 0–7 are COMPLETE and CERTIFIED** — the integration spine (§9 Temporal Workflows) is done: `/phase-exit 7`-CLEAR, both reviewer sub-agents CLEAR, 1 CRITICAL + 8 HIGH adversarial-verify findings across the phase all fixed + re-verified. Read `docs/sessions/008-…` (this handoff) + `007-…`, memory `system-of-work-prd` + `solo-session-full-closeout` + `workflow-concurrency-rate-limits` + `workflow-fanout-burst-stall-repair`, and `IMPLEMENTATION_PLAN.md` (Currently-in-progress + Carry-forward + Phase 8 + Phase 10). **Repo-wide 2392 tests green + 2 todo; typecheck 10/10; audit clean.**
>
> **The DAG widened again after the Phase-7 bottleneck — two phases now fork (different tracks):**
> - **Phase 8 — §10 Local App API** (`apps/worker`, worker track; depends on 7). The tRPC local API + event stream the desktop renderer consumes; per-launch session-token auth (the Phase-3 session-auth primitive wired to the real `apps/worker` shell); read models + System Health surface for §11.
> - **Phase 10 — Cross-cutting** (eval-security track; depends on 2, 7). Non-bypassable structured logging + mandatory redaction sink, the typed persistent System Health surface (the `health_items` table + repo — the Phase-2/7 HealthItem-persistence deferment lands here), worker-supervision lifecycle, Temporal-unavailable + Keychain-locked degraded modes, backup/recovery, config/time conventions.
>
> These are different tracks and may run **2 concurrent Workflows** (rate-limit-conservative — memory `workflow-concurrency-rate-limits`).
>
> **FIRST / prerequisite — the deferred WORKER-WIRING wave** (see plan Carry-forward "PHASE-7 carry-forward"): the Phase-7 workflow *drivers* are pure + fully fake-tested, but nothing runs them yet. Wire the thin @temporalio workflow wrappers + `Worker.create` registration and bind every activity port to the REAL adapters (@sow/integrations Tool/Connector Gateways + NotebookPort, @sow/knowledge KnowledgeWriter + GBrain, @sow/providers Broker, @sow/policy) + the concrete meeting.close/source/project output projections + the `SOW_TEMPORAL`-gated integration tests. This wave also SUBSUMES the Phase-6 gateway-seams (DB-backed `ReceiptStore.reserve` via a unique-constraint insert; bind `@sow/policy requiresApproval` + the Approval store; real transports + `IdentityDeriver`s), the §7-broker `localConfig`, and the `apps/worker` session-auth wiring. Do this before (or as the first slice of) Phase 8, since the App API + the live system depend on the worker actually executing workflows.
>
> **Other carry-forward:** `ProvenanceOrigin` has no `project_sync`/deletion member (7.13→`ingestion`, 7.14→`human`; frozen-contract round if §6 wants distinct); Phase-7 security LOWs → Phase 10 (heuristic leakage-allowlist for calendar payloads; redact error `cause` in the log sink); the OBS-2 `FailureClass` named-constant cluster (`policy_denial`/`egress_status`/`provider_routing_unavailable`/`outbox_blocked`/`db_unavailable`) — pin as distinct enum members in one round if §16 wants them distinct; ESLint+Prettier still placeholders.
>
> **Method:** single-operator + Workflow fan-outs (≤2 concurrent, narrow batches ~≤3–4, retry only failed agents; wrap synth/verify stages in `parallel()` so a StructuredOutput report hiccup can't fail a run); TDD (deterministic code test-first) + the eval path for LLM generation; a strong adversarial-verify stage on every safety-critical wave (it has caught a CRITICAL/HIGH in every phase — the recurring class is "a guard reads a field/flag that is not what flows to the side effect"; re-verify each fix); Zod-as-source for any new contract; commit per batch (explicit `git add`, never `-A`; Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; allowlist TDD-fixture secrets by fingerprint in `.gitleaksignore` with full-line comments); push origin/main. **Run the FULL solo close-out** per memory `solo-session-full-closeout` (session doc, hot-routing, `/orchestrate-end` incl. Step-5.5 Carry-forward triage, formal `/phase-exit` with arch-drift + security + reachability sub-agents). Effort: ultracode. Don't touch `.env`/`scaffold/`.
