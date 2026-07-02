# Phase 8 — Arch-Drift Audit (`/phase-exit 8`)

- **Date:** 2026-07-02 · **Auditor:** arch-drift-auditor (phase-exit fan-out) · **Verdict: CLEAR**
- **Anchors:** ARCHITECTURE.md §10 (Local App API), §5 (renderer↔worker auth + UI-safe boundary), §2.5 (import direction), §9 (Approval state machine), Appendix A (Approval / GclProjection / WorkflowRunRef / HealthItem).

## Result — 5 anchors × all checkable statements: **0 DRIFT / 0 STALE-DOC / 0 AMBIGUOUS**

Every stated §10/§5 behavior matches the shipped code; all 974 relevant tests green (119 evals · 268 worker · 587 contracts).

- **Auth (§5):** constant-time verify via `timingSafeEqual` (`packages/policy/src/session-auth.ts:138`); auth-before-handler (`api/auth/interceptor.ts:65-70`); auth-before-stream-subscription (`api/stream/pushStream.ts:163`); Origin/Host allowlist + loopback-only bind — verified by the green auth-suite + `authInterceptor.test.ts` (25 tests).
- **UI-safe projections (§10 / WS-8):** named-field-only copy (no spread) + `UI_SAFE_ALLOWLIST` + publish-boundary `.strict()` schema re-validation; `HealthItem.message/auditRef/parityReportRef/factIdentity`, `Approval.actor/payloadHash`, `WorkflowRunRef.auditRefs` all dropped — verified by the leakage-suite + `uiSafe.test.ts`.
- **Stream (§10 / spike 0.5):** `tracked()`/`lastEventId` + over-horizon fail-closed **resync control frame** (not a silent partial replay) confirmed in `pushStream.ts`/`resume.ts` — verified by `pushStream.test.ts` (33 tests).
- **Approval exactly-once (§9 / REQ-F-012):** dispatch only on `applied:true`; a second-channel contender returns `applied:false` — verified by the exactly-once-suite.
- **§2.5 import direction:** no upward imports. **Appendix A** field-sets all match code.

## Note (deferral, not drift)

The `deferred → pending` re-surface path lives in `packages/workflows` (Phase 10 territory) — correctly scoped per the app-shell wiring waiver. The API mount surface is UNREACHABLE-BY-DESIGN/deferred (see `phase8-reachability.md`), not a drift.

**Verdict: CLEAR** (2026-07-02).
