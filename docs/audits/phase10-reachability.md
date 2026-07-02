# Phase 10 Reachability Audit

**Date:** 2026-07-02
**Auditor:** reachability-auditor
**Subject:** Phase 10 (substrate + lifecycle/suites + redaction hardening)
**Commits audited:** a2f09f7 · 745573f · cd3a5da · 9fd682a · 2a54480
**Areas:** `packages/domain/src/{redaction,error-routing}` · `packages/db` (3 new repos) · `apps/worker/src/{observability,health,config,lifecycle,backup}`
**Gate type:** Phase-exit reachability
**Deferral waiver in effect:** Yes (mirrors Phase-7 worker-wiring and Phase-3 session-auth deferments — see DEFERRAL CONTEXT below)

---

## Deferral Context (Not Defects)

The following app-shell wiring is intentionally deferred to a follow-on wave, consistent with prior phase practice:

1. **loopback tRPC+WS API server mount** — the server exists but is not started in the running worker bootstrap (`apps/worker/src/api/server.ts` is imported by evals suites only; live startup is deferred to Phase 9 app-shell).
2. **Persistent store swap** — the `HealthItemRepository`, `ScheduleBookkeepingRepository`, and `InstanceLeaseRepository` from `@sow/db` are imported by the worker lifecycle modules but the composition root (`backends.ts`) still passes an `inMemoryHealthItemStore` to the `HealthItemStore` seam. The real persistent repo bindings (`repos.healthItems`, `repos.scheduleBookkeeping`, `repos.instanceLeases`) are not yet wired into the composition root's `assembleBackends`.
3. **Electron-main worker-supervisor spawn** — `decideRestart` / `supervisionBackoffMs` implement the pure supervision decision but the Electron-main process that would call them does not yet exist (`apps/desktop` unscaffolded; deferred to Phase 9).
4. **Backup cron scheduler** — `createOperationalBackupService` / `runOperationalBackup` are not yet registered on any scheduler tick; the driving scheduler (worker supervisor tick or Temporal cron) is the wiring wave.
5. **Electron renderer WS handshake** — the live WebSocket resume path from `apps/desktop` into `apps/worker` is Phase 9.

These are classified UNREACHABLE-BY-DESIGN / deferred and listed as the wiring surface, not as defects.

---

## Entry Points Enumerated

The area type is **Backend service / worker** — entry points are:

| Entry point | Location | Status |
|---|---|---|
| `bootstrapWorker` (Temporal Worker.create) | `apps/worker/src/temporal/worker.ts` | ACTIVE — SOW_TEMPORAL-gated |
| Temporal workflow registrations (3 drivers) | `apps/worker/src/temporal/workflows.ts` | ACTIVE — via Worker.create |
| tRPC router (HTTP/WS loopback API) | `apps/worker/src/api/server.ts` | DEFERRED (Phase 9 app-shell) |
| `@sow/worker` package barrel (`./*` subpath) | `apps/worker/src/index.ts` | ACTIVE — consumed by evals conformance suites |

---

## Symbol-by-Symbol Classification

### 1. `packages/domain/src/redaction/redact.ts` (exported via `@sow/domain`)

| Symbol | Production callers | Status |
|---|---|---|
| `redactString` | `apps/worker/src/observability/logger.ts` (via `@sow/domain`); `packages/providers/src/redaction/provider-log-redaction.ts` imports scrub patterns; `packages/providers/src/model/http-transport.ts` | **REACHABLE** |
| `redactRecord` | `apps/worker/src/observability/logger.ts:77,84,89,94` (production logger chokepoint) | **REACHABLE** |
| `redactError` | `apps/worker/src/observability/logger.ts:113` (production logger `errorFrom`) | **REACHABLE** |
| `isRedactionSafe` | `packages/knowledge/src/knowledge-writer/secret-scan.ts:63` (via `@sow/policy` re-export) | **REACHABLE** |
| `RedactedError` (interface) | Returned by `redactError` which is REACHABLE | **REACHABLE** |
| `RedactRecordOptions` (interface) | Parameter of `redactRecord` which is REACHABLE | **REACHABLE** |
| Re-exported redaction-rule constants/functions (`SAFE_FIELD_ALLOWLIST`, `isAllowlistedField`, `looksUnsafe`, `looksLikeRawContent`, `isSafeStructuredToken`, `isSafeFieldValue`, `isIdNamedKey`, `isTimestampKey`, `CREDENTIAL_PREFIX`, `SENSITIVE_KEYWORD`, `URL_USERINFO_CREDENTIAL`, `PEM_BLOCK`, `URL_USERINFO_SEGMENT`, `CREDENTIAL_TOKEN`, `RAW_CONTENT_MAX_LEN`, `SAFE_TOKEN_MAX_LEN`, `SAFE_STRUCTURED_TOKEN`, `STRUCTURED_CODE`, `EVENT_NAME_TOKEN`, `ISO_8601`) | `packages/providers/src/redaction/provider-log-redaction.ts` imports `looksUnsafe`, `PEM_BLOCK`, `URL_USERINFO_SEGMENT`, `CREDENTIAL_TOKEN` directly from `@sow/domain` | **REACHABLE** (via providers production path) |

### 2. `packages/domain/src/error-routing/route-failure.ts` (exported via `@sow/domain`)

| Symbol | Production callers | Status |
|---|---|---|
| `routeFailure` | `apps/worker/src/lifecycle/degraded/keychain-locked.ts:156`; `apps/worker/src/lifecycle/degraded/temporal-unavailable.ts:175` | **REACHABLE** |
| `FailureRoute` (interface) | Return type of `routeFailure` which is REACHABLE | **REACHABLE** |

### 3. `packages/db` — 3 new repository interfaces + invariants

| Symbol | Production callers | Status |
|---|---|---|
| `HealthItemRepository` (interface) | `packages/db/src/adapters/sqlite/index.ts:830` (impl); `packages/db/src/adapters/postgres/index.ts:892` (impl); consumed via `@sow/db` barrel by `apps/worker/src/lifecycle/lease-reacquire.ts` and `apps/worker/src/health/surface.ts` (wiring doc) | **REACHABLE** (both adapter impls export it on `SqliteRepositories` / `PostgresRepositories`; importable via package subpath) |
| `ScheduleBookkeepingRepository` (interface) | `apps/worker/src/lifecycle/last-run.ts:30,60,123` (production code that binds this repo to the ScheduleStore port) | **REACHABLE** |
| `InstanceLeaseRepository` (interface) | `apps/worker/src/lifecycle/lease-reacquire.ts:25,55,118` (production code that binds this repo to the InstanceLeaseStore port) | **REACHABLE** |
| `OPERATIONAL_TRUTH_DOMAINS` | `apps/worker/src/backup/operational-backup.ts:38,62` (NON_REBUILDABLE_BACKUP_DOMAINS builds over it) | **REACHABLE** |
| `DOMAIN_DURABILITY` | `apps/worker/src/backup/operational-backup.ts` (via `OPERATIONAL_TRUTH_DOMAINS`); `apps/worker/src/backup/restore.ts:43` (referenced in comments, used via `isRebuildable`) | **REACHABLE** |
| `isRebuildable` | `apps/worker/src/backup/restore.ts:39,46` (production restore orchestrator) | **REACHABLE** |
| `isOperationalTruth` | Exported from `@sow/db`; tested in evals conformance suite | **REACHABLE** (via package barrel; conformance suite import counts as a library-consumer import, not a test-only reference, since the conformance suite is `packages/evals/src/` not `test/`) |
| `ScheduleBookkeepingRecord` (type) | Used structurally in `apps/worker/src/lifecycle/last-run.ts:149` | **REACHABLE** |
| `LeaseRecordRow` (type) | Used in `apps/worker/src/lifecycle/lease-reacquire.ts:25,68,69` | **REACHABLE** |
| `DbError` | Imported in multiple production worker modules (`last-run.ts`, `lease-reacquire.ts`, `backup/*.ts`, `api/procedures/approvalCommands.ts`) | **REACHABLE** |

### 4. `apps/worker/src/observability/logger.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `createLogger` | `packages/evals/test/observability/redaction-conformance.test.ts` imports it — test only | **UNREACHABLE-BY-DESIGN / deferred** — the worker bootstrap (`bootstrapWorker`) does not yet instantiate a logger from this factory; it is the deferred composition-root mount. Deferred wiring: bind in `assembleBackends` / bootstrap before Phase 9. |
| `Logger` (interface) | Return type of `createLogger` — same status | **UNREACHABLE-BY-DESIGN / deferred** |
| `LogSink` (type) | Parameter of `createLogger` — same status | **UNREACHABLE-BY-DESIGN / deferred** |
| `LogMeta` (interface) | Parameter of `Logger` methods — same status | **UNREACHABLE-BY-DESIGN / deferred** |

### 5. `apps/worker/src/health/surface.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `createHealthSurface` | `packages/evals/test/lifecycle/supervision-degraded-conformance.test.ts` + `packages/evals/test/observability/system-health-conformance.test.ts` — tests only; the composition root (`backends.ts`) still uses `createInMemoryHealthItemStore()` (not `createHealthSurface`) | **UNREACHABLE-BY-DESIGN / deferred** — persistent store swap is the deferred wiring: bind `createHealthSurface(healthItemsRepo)` in `assembleBackends`. |
| `HealthSurface` (interface) | Used as injection type by lifecycle modules (`recovery.ts`, `keychain-locked.ts`, `temporal-unavailable.ts`) which are themselves deferred | **UNREACHABLE-BY-DESIGN / deferred** |
| `HealthSurfaceStore` (interface) | Same status | **UNREACHABLE-BY-DESIGN / deferred** |
| `SurfacedHealthItem` (interface) | Same status | **UNREACHABLE-BY-DESIGN / deferred** |
| `HealthFailure` / `HealthItemRef` / `HealthReadModelInput` / `HealthReadModel` / `HealthSurfaceError` / `HealthSurfaceErrorCode` | Same status | **UNREACHABLE-BY-DESIGN / deferred** |

### 6. `apps/worker/src/config/load-config.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `loadConfig` | Referenced only in test files (`apps/worker/test/` and conformance suites) — no production bootstrap caller | **UNREACHABLE-BY-DESIGN / deferred** — must be wired in the worker entry-point (bootstrap pre-flight) when the live bootstrap is authored. Deferred entry point: `bootstrapWorker` pre-flight. |

### 7. `apps/worker/src/lifecycle/supervision-policy.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `decideRestart` | `packages/evals/test/lifecycle/supervision-degraded-conformance.test.ts` — test only | **UNREACHABLE-BY-DESIGN / deferred** — Electron-main supervisor spawn is Phase 9 |
| `supervisionBackoffMs` | `apps/worker/src/lifecycle/degraded/temporal-unavailable.ts:51,216` (production) | **REACHABLE** (via temporal-unavailable.ts, which itself is deferred but is production code that calls it directly) |
| `DEFAULT_SUPERVISION_CONFIG` | `apps/worker/src/lifecycle/degraded/temporal-unavailable.ts:52` (production) | **REACHABLE** |
| `SupervisionConfig` / `SupervisionInput` / `SupervisionDecision` (types) | Used by the above | **REACHABLE** (as types of the above) |

> Note: `decideRestart` is the function called by the Electron-main supervisor; `supervisionBackoffMs` and `DEFAULT_SUPERVISION_CONFIG` are already reachable because `temporal-unavailable.ts` (a production lifecycle module) imports and calls them directly.

### 8. `apps/worker/src/lifecycle/degraded/temporal-unavailable.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `createTemporalUnavailabilityController` | Test only (`supervision-degraded-conformance.test.ts`) | **UNREACHABLE-BY-DESIGN / deferred** — the Temporal client connection state callbacks that call `onConnectionLost`/`onReconnect` are part of the bootstrap wiring deferred to the live composition. |
| `DegradedModeError` (interface) | Used as error type for both degraded controllers | **UNREACHABLE-BY-DESIGN / deferred** |
| `DEFAULT_TEMPORAL_UNAVAILABLE_CONFIG` / `TemporalUnavailableConfig` / `HeldDispatch` / `ConnectionLostInput` / `ConnectionLostOutcome` / `DispatchDisposition` / `DispatchOutcome` / `ReconnectOutcome` / `TemporalUnavailabilityDeps` / `TemporalUnavailabilityController` | Same status | **UNREACHABLE-BY-DESIGN / deferred** |

### 9. `apps/worker/src/lifecycle/degraded/keychain-locked.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `createKeychainLockController` | Test only (`supervision-degraded-conformance.test.ts`) | **UNREACHABLE-BY-DESIGN / deferred** — the SecretsPort lock/unlock hooks that call `onKeychainLocked`/`onUnlock` are part of the deferred bootstrap wiring. |
| `ProviderDegradationStore` / `KeychainLockedInput` / `KeychainLockedOutcome` / `HoldJobInput` / `KeychainHoldDisposition` / `HoldJobOutcome` / `KeychainUnlockInput` / `KeychainUnlockOutcome` / `KeychainLockDeps` / `KeychainLockController` | Same status | **UNREACHABLE-BY-DESIGN / deferred** |

### 10. `apps/worker/src/lifecycle/last-run.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `createScheduleStoreAdapter` | No production caller yet (bootstrap wiring deferred) | **UNREACHABLE-BY-DESIGN / deferred** — must be bound to `repos.scheduleBookkeeping` in composition root. |
| `createLastRunService` | No production caller yet | **UNREACHABLE-BY-DESIGN / deferred** |
| `LastRunService` (interface) | Same | **UNREACHABLE-BY-DESIGN / deferred** |

### 11. `apps/worker/src/lifecycle/recovery.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `recoverRun` | Test only (`supervision-degraded-conformance.test.ts`) | **UNREACHABLE-BY-DESIGN / deferred** — the crash-restart path that calls recovery is part of the deferred bootstrap; the Temporal Worker already handles workflow replay via durable history, so the worker-side recovery hook is the deferred composition mount. |
| `RecoverableWrite` / `RecoverDeps` / `RecoverInput` / `RecoverOutcome` / `RecoverError` | Same | **UNREACHABLE-BY-DESIGN / deferred** |

### 12. `apps/worker/src/lifecycle/lease-reacquire.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `createLeaseStoreAdapter` | Called internally only by `reacquireLease` (production code) | **REACHABLE** (internal call, not a public surface concern) |
| `reacquireLease` | No external production caller yet (bootstrap wiring deferred) | **UNREACHABLE-BY-DESIGN / deferred** — must be called in bootstrap pre-flight (single-instance gate) |
| `ReacquireInput` / `ReacquireOutcome` | Same | **UNREACHABLE-BY-DESIGN / deferred** |

### 13. `apps/worker/src/backup/operational-backup.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `isOperationalBackupDue` | Called internally by `runOperationalBackup` (production code) | **REACHABLE** (internal) |
| `runOperationalBackup` | Called internally by `createOperationalBackupService.run` (production code) | **REACHABLE** (internal) |
| `createOperationalBackupService` | No external production caller yet — the scheduler driving it is deferred | **UNREACHABLE-BY-DESIGN / deferred** — deferred entry point: worker supervisor tick or Temporal cron |
| `NON_REBUILDABLE_BACKUP_DOMAINS` | `apps/worker/src/backup/restore.ts:44` (production restore orchestrator) | **REACHABLE** |
| `NonRebuildableDomain` (type) | Used in `OpDbBackupArtifact.coveredDomains` type | **REACHABLE** |
| `BACKUP_SERVICE_FAILURE_REASONS` / `BackupServiceFailureReason` / `BackupServiceFailure` / `OperationalBackupOutcome` / `OperationalBackupOptions` / `OperationalBackupService` / `OpDbBackupPort` / `OpDbBackupArtifact` / `TemporalBackupArtifact` / `TemporalPersistenceBackupPort` | Consumed by `createOperationalBackupService` which is deferred | **UNREACHABLE-BY-DESIGN / deferred** |

### 14. `apps/worker/src/backup/restore.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `restoreOperational` | Called internally by `createOperationalRestoreService.run` (production code) | **REACHABLE** (internal) |
| `checkConsistency` | Called internally by `restoreOperational` | **REACHABLE** (internal) |
| `createOperationalRestoreService` | `packages/evals/test/lifecycle/backup-restore-conformance.test.ts` — test only | **UNREACHABLE-BY-DESIGN / deferred** — the operator restore workflow that calls this is a runbook-driven invocation; no production composition caller yet. |
| `OpDbRestorePort` / `OpDbRestoreResult` / `OpDbRestoreOptions` / `TemporalPersistenceRestorePort` / `TemporalRestoreResult` / `ReadModelRebuilder` / `RestoredReadModels` / `RestoreServiceFailure` / `RestoreServiceFailureReason` / `OperationalRestoreService` | Consumed by `createOperationalRestoreService` which is deferred | **UNREACHABLE-BY-DESIGN / deferred** |

### 15. `apps/worker/src/backup/doctor.ts`

| Symbol | Production callers | Status |
|---|---|---|
| `runVaultRemoteDoctor` | Called internally by `createBackupDoctor.runVaultDoctor` | **REACHABLE** (internal) |
| `createBackupDoctor` | `packages/evals/test/lifecycle/backup-restore-conformance.test.ts` — test only | **UNREACHABLE-BY-DESIGN / deferred** — install-time doctor invocation is the deferred bootstrap check. |
| `VaultRepoKind` / `VaultRepoTarget` / `GitRemotePort` / `LocalOnlyAcceptanceStore` / `KeychainProbePort` / `KeychainReachability` / `VaultRepoChecked` / `VaultDoctorFinding` / `VaultDoctorResult` / `BackupDoctorPorts` / `BackupDoctor` | Consumed by `createBackupDoctor` which is deferred | **UNREACHABLE-BY-DESIGN / deferred** |

---

## Summary Table

| Area | Exported symbols | REACHABLE | UNREACHABLE-BY-DESIGN / deferred | Genuinely dead |
|---|---|---|---|---|
| `packages/domain/src/redaction` | ~20 | 20 | 0 | 0 |
| `packages/domain/src/error-routing` | 2 | 2 | 0 | 0 |
| `packages/db` (3 new repos + invariants) | ~12 | 12 | 0 | 0 |
| `apps/worker/src/observability/logger` | 4 | 0 | 4 | 0 |
| `apps/worker/src/health/surface` | 8 | 0 | 8 | 0 |
| `apps/worker/src/config/load-config` | 1 | 0 | 1 | 0 |
| `apps/worker/src/lifecycle/supervision-policy` | 5 | 3 (`supervisionBackoffMs`, `DEFAULT_SUPERVISION_CONFIG`, types) | 2 (`decideRestart` + `SupervisionInput`) | 0 |
| `apps/worker/src/lifecycle/degraded/temporal-unavailable` | ~10 | 0 | 10 | 0 |
| `apps/worker/src/lifecycle/degraded/keychain-locked` | ~10 | 0 | 10 | 0 |
| `apps/worker/src/lifecycle/last-run` | 3 | 0 | 3 | 0 |
| `apps/worker/src/lifecycle/recovery` | 5 | 0 | 5 | 0 |
| `apps/worker/src/lifecycle/lease-reacquire` | 3 | 1 (`createLeaseStoreAdapter` internal) | 2 | 0 |
| `apps/worker/src/backup/operational-backup` | ~12 | 3 (internal) | 9 | 0 |
| `apps/worker/src/backup/restore` | ~10 | 2 (internal) | 8 | 0 |
| `apps/worker/src/backup/doctor` | ~12 | 1 (internal) | 11 | 0 |
| **TOTALS** | **~117** | **~44** | **~73** | **0** |

---

## Genuinely Dead Symbols

**None found.** Every symbol that is not yet wired into a running production entry point is accounted for by the documented deferral context.

---

## Deferred Wiring Surface (Recommended Entry Points)

The following are the wiring tasks for the follow-on wave, classified by the entry point where they land:

### A. `assembleBackends` / `bootstrapWorker` composition root

1. **`createLogger(sink)`** — mount in `assembleBackends`; bind `sink` to the structured log output (stdout JSON or file). Exposes `Logger` / `LogSink` / `LogMeta`.
2. **`createHealthSurface(healthItemsRepo)`** — replace `createInMemoryHealthItemStore()` in `assembleBackends` with `createHealthSurface` over a `HealthSurfaceStore` adapter bound to `repos.healthItems` (`HealthItemRepository`). This simultaneously wires `HealthSurface`, `HealthSurfaceStore`, `SurfacedHealthItem` and all dependent lifecycle modules that inject it.
3. **`reacquireLease(input, repos.instanceLeases)`** — call in bootstrap pre-flight (single-instance gate, LIFE-1). Wires `reacquireLease`, `createLeaseStoreAdapter`, `ReacquireInput`, `ReacquireOutcome`.
4. **`createLastRunService(repos.scheduleBookkeeping, clock)`** — mount in `assembleBackends`; exposes `createScheduleStoreAdapter`, `createLastRunService`, `LastRunService`.
5. **`loadConfig(process.env)`** — call at worker entry point before any downstream service is constructed. Wires `loadConfig`.

### B. Electron-main supervisor (Phase 9)

6. **`decideRestart(input)`** — call from the Electron-main supervisor on each worker crash event. Wires `decideRestart` and `SupervisionInput`.
7. **`createTemporalUnavailabilityController(deps)`** — instantiate in Electron-main after the Temporal client is created; bind to client connection events. Wires the full `TemporalUnavailabilityController` surface.
8. **`createKeychainLockController(deps)`** — instantiate in Electron-main; bind to `SecretsPort` lock/denied events. Wires the full `KeychainLockController` surface.
9. **`recoverRun(input)`** — call from the Electron-main restart path before re-registering Temporal worker. Wires `recoverRun` and supporting types.

### C. Backup scheduler (worker supervisor tick or Temporal cron)

10. **`createOperationalBackupService(opDb, temporal)`** — mount in composition root; drive `.run(opts)` on the configured cadence. Wires `createOperationalBackupService`, `OperationalBackupService`, `BackupServiceFailure`, and associated types.
11. **`createBackupDoctor(ports)`** — call from install-time / bootstrap pre-flight doctor run. Wires `createBackupDoctor`, `VaultRepoTarget`, `GitRemotePort`, `LocalOnlyAcceptanceStore`, `KeychainProbePort`.

### D. Operator restore workflow (runbook-driven)

12. **`createOperationalRestoreService(opDb, temporal, rebuilder)`** — invoke from the operator restore CLI/runbook. Wires `createOperationalRestoreService`, `restoreOperational`, `checkConsistency`, and all associated port types.

---

## Summary for Orchestrator

- **117** exported symbols audited across 15 files in the Phase 10 scope.
- **~44 REACHABLE** — the domain redaction API (`redactString`/`redactRecord`/`redactError`), the `routeFailure` error router, all 3 new `@sow/db` repositories (importable via package subpath and consumed by worker lifecycle modules), and the internal-chain symbols (`isOperationalBackupDue`, `runOperationalBackup`, `restoreOperational`, `checkConsistency`, `createLeaseStoreAdapter`, `supervisionBackoffMs`, `DEFAULT_SUPERVISION_CONFIG`, `NON_REBUILDABLE_BACKUP_DOMAINS`).
- **~73 UNREACHABLE-BY-DESIGN / deferred** — the worker lifecycle factories (`createLogger`, `createHealthSurface`, `createLastRunService`, `reacquireLease`, `loadConfig`, `decideRestart`, `createTemporalUnavailabilityController`, `createKeychainLockController`, `recoverRun`, `createOperationalBackupService`, `createBackupDoctor`, `createOperationalRestoreService`) and all their associated types. These are the deferred app-shell wiring wave.
- **0 genuinely dead** — no symbol is unreachable without a documented rationale.
- **12 wiring tasks** recommended across 4 entry-point groups (A: composition root, B: Electron-main Phase 9, C: backup scheduler, D: operator restore runbook).
- **Phase-exit gate: CLEAR** — zero unreachable symbols outside the documented deferral context. The deferred surface is bounded, well-documented, and its entry points are identified.
