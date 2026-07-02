# Phase 7 — Arch-Drift Audit

- **Gate:** `/phase-exit 7` · **Date:** 2026-07-02 · **Auditor:** `arch-drift-auditor`
- **Subject:** `packages/workflows` (`@sow/workflows`) + `apps/worker` (`@sow/worker`) + the Phase-2 `packages/db` `ApprovalRepository` change (commits `9a61db5`/`7fed14c`/`ba893c2`/`ea2a342`).
- **Verdict: CLEAR** — 9 anchor groups audited (§9 primary + §16, Appendix A, and the 13 workflows' sub-claims) · **0 DRIFT · 2 STALE-DOC · 0 AMBIGUOUS**.
- **Gates:** 438/438 `@sow/workflows` tests green; 13/13 `@sow/worker` green (1 `SOW_TEMPORAL`-gated skip, expected); `tsc --noEmit` clean (10/10 packages).

## Anchor verdicts — all VERIFIED

- **§9 lifecycle (LIFE-1/2/3/5)** — LIFE-1 single-active lease with a fencing token (`instanceLease.ts`: `decideLease` CAS + `isFencedStale`; generation bumps on fresh-acquire, preserved on reacquire); LIFE-2 collapsed catch-up (`catchUpWindow.ts`: N due → one `nextRun`, older dropped+recorded, capped); LIFE-3 resume reuses the §8 envelope (`resume.ts` skips committed / re-drives keyed steps; a mutating step without an idempotencyKey is `unrecoverable`; `envelopeReuse.ts` re-drives through the Phase-6 gateway → `reused`); LIFE-5 monotonic epoch-guarded across restarts (`clock.ts` uses monotonic only when epochs match, else clamped wall; `collapsedNextRunFromClock` feeds the epoch-guarded elapsed).
- **§9 every workflow** — `resolveRun` idempotency (seen key → existing run) + workspace bound before any durable write (`createWorkflowRun` `isScoped` guard, REQ-F-002); semantic writes ONLY via KnowledgeWriter ports, external writes ONLY via the Tool Gateway envelope (no driver imports `@sow/knowledge`/`@sow/integrations` directly); every failure class → a distinct OBS-2 health item (`systemHealthSurfacing.ts`).
- **7.6 / 7.7 / 7.10 / 7.11 / 7.13 / 7.18** — committed plans DERIVED from validated data (BuildOutputsPort), never caller-supplied, `plan.workspaceId` stamped from the bound workspace; 7.13 numeric progress from the DETERMINISTIC parser, never model-supplied (REQ-F-011).
- **7.9 approval** — states pending→approved|edited|rejected|deferred|expired; deferred non-terminal (snooze 24h / expiry 7d); exactly-once across Mac+Telegram via `ApprovalRepository.applyTransition` surfacing `ApprovalTransitionOutcome { approval, applied }` (`casVerdictToOutcome`) so the activity reports `applied` from the atomic verdict; approved dispatches through the envelope, rejected/edited/deferred perform no external write.
- **7.14 deletion saga** — ordered Markdown-tombstone(commit point)→GBrain-purge→event-tombstone(history preserved, not hard-deleted)→reconcile; per-step keys fold each deleted region's live-content discriminator; human-owned regions refused (`human_owned_only`); crash-safe idempotent re-drive; post-commit partial → `compensating` (never a rollback).
- **7.15 / 7.16** — no-silent-drop unreachable branch (queue/degrade/drain via the Connector Gateway + health sink); idempotent Drive upsert via the Tool Gateway/NotebookPort.
- **7.17 Copilot / 7.18 Hermes** — read-path has NO commit/dispatch port (zero side effects; act → a proposal to approval); Hermes pins `trigger='hermes_automation'`, has no direct Markdown/GBrain path, and derives-from-validated (reuses 7.6's BuildOutputsPort).
- **§16 supervision** — Temporal-unavailable is a first-class degraded mode (`decideBootstrap` → dispatch blocked, `worker_down` health item, bounded ≤60s reconnect); worker restart re-acquires the LIFE-1 lease.
- **Appendix A** — WorkflowRunRef (5 fields, no workspaceId), Approval (6 statuses incl. deferred/expired + snoozeUntil/expiresAt), HealthItem (10 failureClass values incl. worker_down/sync_lagging/rebuild_divergence), and the new `@sow/db` `ApprovalTransitionOutcome { approval, applied }` — all frozen + snapshot-pinned.

## Findings

- **DRIFT / AMBIGUOUS: none.**
- **STALE-DOC 1** — the §9 prose does not describe the port-local `ApplyTransitionResult.noopReason` field (`ports/approvalFlow.ts`); this is a package-local port type (not the frozen `@sow/contracts` model), so it is not a contract-freeze concern — code is more precise than the spec. Architecture-doc note only.
- **STALE-DOC 2** — `HealthItem.severity` is an open string (documented as an arch_gap in `health-item.ts` + the `contracts/CLAUDE.md` cross-doc table) but the Appendix-A HealthItem row does not annotate `severity` as open. Code correct; Appendix-A row could annotate it. Architecture-doc note only.

## Verdict

**CLEAR.** No §9/§16/Appendix-A drift; the LIFE-1/2/3/5 lifecycle invariants, the derive-from-validated + governance-routing patterns, the approval exactly-once CAS-kind fix, the deletion-saga content-discriminated keys, read-path purity, and Hermes gateway-routing all hold in code; every adversarial-verify fix across the phase is confirmed. 2 STALE-DOC are doc-annotation notes (carry-forward).
