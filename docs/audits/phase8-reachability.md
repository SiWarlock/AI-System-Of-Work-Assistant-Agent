# Phase 8 + 10 Reachability Audit
**Auditor:** reachability-auditor  
**Phase commits:** a2f09f7 · 745573f · cd3a5da · 9fd682a · 2a54480  
**Date:** 2026-07-02  
**Scope:** `apps/worker/src/api/**` · `packages/contracts/src/api/**` · `packages/evals/src/worker-api-auth/**` · Phase 10 substrate (`apps/worker/src/{observability,health,lifecycle,backup}/**` · `packages/domain/src/redaction/**`)

---

## Enumeration summary

| Area | Exported symbols (non-test) | Status |
|---|---|---|
| `apps/worker/src/api/auth/` | 8 types/functions | UNREACHABLE-BY-DESIGN |
| `apps/worker/src/api/procedures/` | 14 types/functions | UNREACHABLE-BY-DESIGN |
| `apps/worker/src/api/projections/` | 6 functions | UNREACHABLE-BY-DESIGN |
| `apps/worker/src/api/stream/` | 20+ types/functions | UNREACHABLE-BY-DESIGN |
| `apps/worker/src/api/server.ts` | `createApiServer`, `ApiServer`, `AppRouter`, `ApiCaller`, `ApiServerDeps` | UNREACHABLE-BY-DESIGN |
| `apps/worker/src/api/router.ts` | `healthRouter`, `router`, `publicProcedure`, `authedResolver`, `HealthPingResult` | UNREACHABLE-BY-DESIGN (sibling-imported by server.ts; not mounted) |
| `apps/worker/src/api/trpc.ts` | `ApiContext`, `router`, `createCallerFactory`, `publicProcedure`, `middleware`, `authedResolver`, `ok`, `err`, `failure`, `isErr` | UNREACHABLE-BY-DESIGN |
| `packages/contracts/src/api/ui-safe.ts` | `UiSafeApproval`, `UiSafeHealthItem`, `UiSafeWorkflowRunRef`, `UiSafeDashboardCard`, 4 Zod schemas, `UI_SAFE_ALLOWLIST` | REACHABLE via `@sow/contracts` barrel (consumed by `eventClasses.ts` + leakage suite) |
| `packages/contracts/src/api/events.ts` | `StreamEvent`, `streamEventSchema`, 4 event interfaces, `STREAM_EVENT_NAMES` | REACHABLE via `@sow/contracts` barrel (consumed by `eventClasses.ts` + leakage suite) |
| `packages/evals/src/worker-api-auth/` | `runAuthSuite`, `runLeakageSuite`, `runExactlyOnceSuite` + constants | TEST-HARNESS REACHABLE (invoked by `packages/evals/test/worker-api-auth/*.test.ts`) |
| Phase 10: `apps/worker/src/observability/logger.ts` | `createLogger`, `LogSink`, `LogMeta`, `Logger` | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/health/surface.ts` | `createHealthSurface`, `HealthSurface`, `HealthSurfaceStore`, et al. | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/lifecycle/supervision-policy.ts` | `decideRestart`, `SupervisionConfig`, `SupervisionInput`, `SupervisionDecision` | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/lifecycle/lease-reacquire.ts` | `reacquireLease`, `createLeaseStoreAdapter`, `ReacquireInput`, `ReacquireOutcome` | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/lifecycle/recovery.ts` | `recoverRun`, `RecoverDeps`, `RecoverInput`, `RecoverOutcome` | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/lifecycle/last-run.ts` | `createLastRunService`, `createScheduleStoreAdapter`, `LastRunService` | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/lifecycle/degraded/temporal-unavailable.ts` | `createTemporalUnavailabilityController`, `DEFAULT_TEMPORAL_UNAVAILABLE_CONFIG`, et al. | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/lifecycle/degraded/keychain-locked.ts` | `createKeychainLockController`, `KeychainLockedInput`, et al. | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/backup/operational-backup.ts` | `createOperationalBackupService`, `NON_REBUILDABLE_BACKUP_DOMAINS`, et al. | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/backup/restore.ts` | `createOperationalRestoreService`, port interfaces, et al. | UNREACHABLE-BY-DESIGN |
| Phase 10: `apps/worker/src/backup/doctor.ts` | `createBackupDoctor`, `runVaultRemoteDoctor`, `checkKeychainReachable`, et al. | UNREACHABLE-BY-DESIGN |
| Phase 10: `packages/domain/src/redaction/redact.ts` | `redactString`, `redactRecord`, `redactError`, et al. | REACHABLE via `@sow/domain` barrel → consumed by `packages/integrations` + `packages/providers` production code |

---

## Production entry points (worker)

The worker's production entry point is `apps/worker/src/index.ts`, which exports exactly two modules:

- `./lease/instanceLease` — the LIFE-1 single-active-instance lease (REACHABLE; exercised by `temporal/worker.ts` decision logic)
- `./temporal/worker` — the Temporal bootstrap + degraded-mode decision (REACHABLE; the live entry point under `SOW_TEMPORAL=1`)

The `apps/desktop/` shell is unscaffolded (Phase 9 gate), so no Electron main process production entry point exists yet. No cron scheduler or CLI script mounts the API layer. No HTTP/WS transport is bound.

---

## Reachability classification

### REACHABLE (production path)

| Symbol | Evidence |
|---|---|
| `packages/contracts/src/api/ui-safe.ts` — `UiSafeApproval`, `UiSafeHealthItem`, `UiSafeWorkflowRunRef`, `UiSafeDashboardCard`, `UiSafe*Schema`, `UI_SAFE_ALLOWLIST` | Re-exported from `packages/contracts/src/index.ts:65`. Consumed in production by `apps/worker/src/api/stream/eventClasses.ts` (the production `createStreamPublisher` factory imports and applies the projectors) and `packages/evals/src/worker-api-auth/leakage-suite.ts`. |
| `packages/contracts/src/api/events.ts` — `StreamEvent`, `streamEventSchema`, event interfaces, `STREAM_EVENT_NAMES` | Re-exported from `packages/contracts/src/index.ts:66`. Consumed in production by `apps/worker/src/api/stream/eventClasses.ts` (the `streamEventSchema` PUBLISH gate). |
| `packages/domain/src/redaction/redact.ts` — `redactString`, `redactRecord`, `redactError` | Re-exported from `packages/domain/src/index.ts:11`. Consumed by `packages/integrations/src/connectors/gateway.ts`, `packages/integrations/src/tools/gateway.ts`, `packages/providers/src/model/http-transport.ts`, `packages/providers/src/runtime/runtime-support.ts` — all production code. |

### UNREACHABLE-BY-DESIGN / deferred (app-shell wiring wave)

All symbols in `apps/worker/src/api/**` are unreachable from any production entry point. The worker's `src/index.ts` barrel does **not** export any `api/` module. No production bootstrap file (`temporal/worker.ts`, any composition root) calls `createApiServer`, `createPushStream`, `buildCommandRouter`, `buildQueryRouter`, `buildSystemHealthRouter`, `makeAuthInterceptor`, `assertLoopbackBind`, or `runStreamHandshake`. No HTTP/WS server binds these.

This is the **intentional deferred app-shell wiring** documented in the Phase 7 waiver and mirrored here for Phase 8: mounting the loopback tRPC+WS API server into the running worker bootstrap is deferred to Phase 9 (Electron main session-token mint + worker-supervisor spawn + renderer WS handshake).

All Phase 10 substrate modules (`observability/logger.ts`, `health/surface.ts`, `lifecycle/**`, `backup/**`) are similarly unreachable from production entry points. The worker `src/index.ts` does not export them. The composition root that wires them into the live bootstrap is the deferred Phase 11 `apps/worker/src/boot/orchestrator.ts`. Within Phase 10, the lifecycle degraded-mode modules (`temporal-unavailable.ts`, `keychain-locked.ts`, `recovery.ts`) DO import `HealthSurface` from `health/surface.ts` as peer sibling-layer wiring — this is correct internal composition, not a reachability defect.

### Wiring wave surface (Phase 9 entry point targets)

The following symbols constitute the loopback mount surface to wire in Phase 9:

| Symbol | File | Recommended entry point |
|---|---|---|
| `createApiServer` | `apps/worker/src/api/server.ts:88` | `apps/worker/src/boot/orchestrator.ts` (Phase 11) or directly in Phase 9's worker supervisor spawn that starts the HTTP transport |
| `createPushStream` | `apps/worker/src/api/stream/pushStream.ts:262` | Same composition root as `createApiServer` |
| `assertLoopbackBind` | `apps/worker/src/api/auth/loopbackBind.ts:31` | Transport startup in the API server mount (per-bind, not per-call) |
| `buildQueryRouter` | `apps/worker/src/api/procedures/queries.ts:205` | Passed into `appRouter` composition inside `server.ts` (placeholder comment already at line 49) |
| `buildSystemHealthRouter` | `apps/worker/src/api/procedures/systemHealth.ts:141` | Same as above |
| `buildCommandRouter` | `apps/worker/src/api/procedures/commands.ts:179` | Same as above (placeholder comment at line 50) |

Phase 10 lifecycle substrate wiring entry point: `apps/worker/src/boot/orchestrator.ts` (Phase 11), which composes `createLogger`, `createHealthSurface`, `createTemporalUnavailabilityController`, `createKeychainLockController`, `reacquireLease`, `createLastRunService`, `createOperationalBackupService`, `createBackupDoctor`.

---

## Leaf-module internal consistency check

All factories are called by their designated unit tests and/or conformance suites. No exported symbol was found to be entirely unreferenced by any test, suite, or sibling-layer import:

- `createApiServer` — called by `apps/worker/test/api/uiSafe.test.ts` and `packages/evals/src/worker-api-auth/auth-suite.ts`
- `createPushStream` — called by `apps/worker/test/api/stream/pushStream.test.ts`
- `makeAuthInterceptor` — called by `apps/worker/test/api/auth/authInterceptor.test.ts`, `pushStream.test.ts`, and `packages/evals/src/worker-api-auth/auth-suite.ts` + `exactly-once-suite.ts`
- `buildCommandRouter` — called by `apps/worker/test/api/commands.test.ts` and `packages/evals/src/worker-api-auth/exactly-once-suite.ts`
- `buildQueryRouter` — called by `apps/worker/test/api/procedures/queries.test.ts` and `packages/evals/src/benchmarks/dashboard-warmload.bench.ts`
- `buildSystemHealthRouter` — called by `apps/worker/test/api/procedures/systemHealth.test.ts`
- `assertLoopbackBind` — called by `packages/evals/src/worker-api-auth/auth-suite.ts`
- `runStreamHandshake` — called by `packages/evals/src/worker-api-auth/auth-suite.ts`
- `createHealthSurface` — called by `apps/worker/test/health/surface.test.ts` and `packages/evals/test/observability/system-health-conformance.test.ts`
- `createLogger` — called by `apps/worker/test/observability/logger.test.ts` and `packages/evals/test/observability/redaction-conformance.test.ts`
- `createBackupDoctor` / `runVaultRemoteDoctor` / `createOperationalRestoreService` — called by `apps/worker/test/backup/*.test.ts` and `packages/evals/test/lifecycle/backup-restore-conformance.test.ts`
- `createTemporalUnavailabilityController` / `createKeychainLockController` — called by `apps/worker/test/degraded-modes.test.ts` and `packages/evals/test/lifecycle/supervision-degraded-conformance.test.ts`
- `createScheduleStoreAdapter` — called by `apps/worker/test/last-run.test.ts` (**note**: only test-referenced; production wiring is deferred to Phase 11 scheduler composition)
- `toUiSafeApproval` / `toUiSafeHealthItem` / `toUiSafeWorkflowRunRef` / `toUiSafeDashboardCard` — production-imported by `apps/worker/src/api/stream/eventClasses.ts` and `apps/worker/src/api/procedures/queries.ts` + `systemHealth.ts`

---

## Genuine dead-code check

No exported symbol in the Phase 8 or Phase 10 area was found to be unreferenced by ANY test, suite, or sibling-layer import. All symbols have at least one test/conformance-suite reference. The only symbols that lack a production-path reference are those in the intentionally deferred wiring wave — classified UNREACHABLE-BY-DESIGN above.

One observation worth noting (not a defect): `createScheduleStoreAdapter` (in `lifecycle/last-run.ts`) is currently referenced only from its unit test. Its production wiring to `@sow/db`'s `ScheduleLastRunRepository` belongs to the Phase 11 `boot/orchestrator.ts` composition root (the same deferred wiring wave). Classified UNREACHABLE-BY-DESIGN / Phase 11.

---

## Waiver record

This audit applies the same waiver structure as Phase 7's `worker-wiring-reachability.md`:

> **UNREACHABLE-BY-DESIGN waiver (Phase 8 + 10):** Mounting the loopback tRPC+WS API server into the running worker bootstrap; swapping the Phase 10 health/lifecycle/backup substrate into the live composition root; the Electron-main worker-supervisor spawn (apps/desktop unscaffolded → Phase 9); the backup cron scheduler; the live Electron renderer WS handshake — all deferred to Phase 9 (desktop shell) and Phase 11 (install/boot orchestration). Leaf modules are unit-tested and importable via the `@sow/worker/**` subpath export map.

---

## Summary for orchestrator

- **Phase 8 API layer:** 0 genuine dead exports. All Phase 8 exports referenced from tests/suites. App-shell mount deferred to Phase 9 (entry point: Electron main + worker supervisor spawn + loopback HTTP bind).
- **Phase 10 substrate:** 0 genuine dead exports. All Phase 10 exports referenced from unit tests and/or `packages/evals/test/lifecycle` + `test/observability` conformance suites. Live composition root wiring deferred to Phase 11 (`apps/worker/src/boot/orchestrator.ts`).
- **Contracts api/:** `ui-safe.ts` and `events.ts` are REACHABLE — barrel-exported from `@sow/contracts` and consumed by production `eventClasses.ts`.
- **Domain redaction:** REACHABLE — barrel-exported from `@sow/domain` and wired into production integrations + providers packages.
- **Evals worker-api-auth:** `runAuthSuite`, `runLeakageSuite`, `runExactlyOnceSuite` are test-harness reachable (invoked by Vitest conformance tests). Not re-exported from the `@sow/evals` root barrel (`src/index.ts`) — accessible only via the `@sow/evals/worker-api-auth` subpath.
- **Wiring tasks recommended:** 1 wiring wave (Phase 9: loopback API server mount + Phase 11: substrate composition root). No immediate wiring tasks block this phase exit.
- **Phase-exit gate: CLEAR** — 0 unreachable symbols that are not covered by the approved deferred-wiring waiver.
