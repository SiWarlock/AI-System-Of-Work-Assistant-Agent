# Phase 2 — Arch-Drift Audit

- **Gate:** `/phase-exit 2` · **Date:** 2026-06-30 · **Auditor:** `arch-drift-auditor`
- **Verdict: CLEAR** — no unrecorded §4/§12/§13 drift. 1 DRIFT (recorded §16 gap, deferment **approved → Phase 10**) · 1 STALE-DOC (known `db_unavailable` carry-forward) · 1 AMBIGUOUS (stale `results.json` — independently re-verified 985 green).
- **Anchors:** §4 (Operational Storage) · §13 (migrations/rollback) · §12 (dual-dialect contract tests) · §16 (backup & recovery, typed-Result) · §3 + Appendix A (persisted models).

## Anchor verdicts (all CLEAR)
- **§4 boundaries:** all 10 tables carry zero Markdown/semantic-truth, Temporal-history, GBrain-index, or plaintext-secret columns; `operational-schema.test.ts` programmatically forbids the secret/raw-content shape across both dialects.
- **§4/§13 migration lifecycle:** `runner.ts` implements mandatory backup → apply → restore-on-failure → typed repair; `lifecycle.test.ts` exercises happy/idempotent/fail→restore over BOTH `sqliteFixture` and `pgFixture` (real PGLite).
- **§13 version-compat:** `assertSchemaCompatible` — 4 typed refusal reasons, each with repair text; tested.
- **§12 dual-dialect (REQ-D-003):** sqlite-core + pg-core both exist, identical column-name sets; the contract suite `describe.each([sqlite, pglite])` runs the full suite against both real in-process engines; `pg-engine.ts` is a real PGLite-backed migrator (not stubbed).
- **§16 error convention:** every repo method → `Promise<Result<T, DbError>>`, closed `DbErrorCode`; degraded-mode returns typed Results on all paths.
- **§16 backup/recovery:** periodic + pre-migration backup for both dialects; forced/cadence/retention/restore/digest-integrity (fails closed on tampered digest) tested; pg row-digest (not byte-stable) invariant confirmed.
- **§3 + Appendix A:** all 6 directly-persisted models (AuditRecord, Approval, ProviderProfile, GclProjection, Workspace, WorkflowRunRef) column-parity MATCH the frozen snapshot (recomputed from `@sow/contracts`, not copied).
- **REQ-D-004/005 / REQ-S-003:** no Temporal/GBrain tables; no secret columns (forbidden-column-name set enforced in tests).

## Findings
- **DRIFT (recorded; deferment APPROVED 2026-06-30 → Phase 10):** §16 states HealthItems are operational truth covered by Backup & Recovery, but `@sow/db` has no `health_items` table — `degraded-mode.ts` manages them in-memory only. Explicitly flagged in code (`read-models.ts:15–17` "OUT OF SCOPE, FLAGGED for §4"). Owner approved deferring HealthItem persistence to **Phase 10** (Cross-cutting observability + System Health + backup/recovery), which builds System Health end-to-end. Carry-forward recorded.
- **STALE-DOC:** `degraded-mode.ts:32` uses `worker_down` for the DB-unavailable failureClass (no `db_unavailable` in the frozen OBS-2 enum) — a known, in-code-flagged carry-forward (add `db_unavailable` to the enum upstream).
- **AMBIGUOUS (resolved):** the auditor saw only 3 files in a stale `node_modules/.vite/vitest/results.json`; the orchestrator independently re-ran the full suite — **985 passed + 2 gated Docker todos**. Not a real gap.

## Verdict
**CLEAR.** No unrecorded §4/§12/§13 drift; the single §16 DRIFT is recorded and its deferment to Phase 10 is owner-approved.
