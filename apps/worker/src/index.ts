// @sow/worker — the package barrel.
//
// The proof-spine flat exports (lease + the Temporal worker bootstrap) stay flat
// for backward compatibility. The MOUNT-wave app-shell surface (api · observability
// · health · lifecycle · config · backup · boot · composition · temporal
// registration) is re-exported under NAMESPACES pointed at concrete modules.
//
// WHY NAMESPACES, NOT A FLAT `export *`: several symbols legitimately collide across
// these surfaces — a flat `export *` would be a duplicate-export error:
//   • `createScheduleStoreAdapter` is defined in BOTH `composition/store-adapters.ts`
//     (fold-a-read-fault-to-reject) AND `lifecycle/last-run.ts` (fold-a-read-fault-to-
//     undefined) — two genuinely different adapters;
//   • the port re-exports (`ReadModelQueryPort`, `DbError`, `DashboardCardSource`,
//     `AuthedContext`, `ApprovalRepository`) appear in multiple modules for
//     integrator convenience.
// Each namespace points at a CONCRETE module (not a directory barrel) so it stays
// collision-free AND discoverable, and the desktop renderer / Electron main import a
// clean, stable namespace per subsystem.

// ── proof-spine flat exports (unchanged) ──────────────────────────────────────

// The PURE single-active-instance lease decision (LIFE-1).
export * from "./lease/instanceLease";

// The worker bootstrap + degraded-mode decision (the pure `decideBootstrap` +
// the gated live `bootstrapWorker`).
export * from "./temporal/worker";

// ── MOUNT-wave app-shell surface (namespaced, per concrete module) ─────────────

/** The live-boot composition root: `bootWorker(config)` + the `BootedWorker` handle. */
export * as boot from "./boot";

/** Option A: the local `gbrain serve --http` supervisor (`createGbrainServeSupervisor` + the real spawn/probe seams). */
export * as gbrainServe from "./gbrainServeSupervisor";

/** The API server composition: `createApiServer`, the composed `AppRouter`, `ApiServerDeps`, `ApiCaller`. */
export * as apiServer from "./api/server";

// Flat TOP-LEVEL type re-export of the composed router shape (task 9-approuter-typing): the desktop
// renderer's typed tRPC client does `import type { AppRouter } from "@sow/worker"`. Needed for the
// SOURCE-resolution tiers (the desktop node tier, where `main/` also imports the worker's runtime) —
// the DOM tiers redirect `@sow/worker` at the built `api/server.d.ts` directly. A TYPE-only re-export
// can't collide with the `apiServer` namespace runtime values above (it binds no value).
export type { AppRouter, ApiCaller } from "./api/server";

/** The REAL loopback transport: `startApiServer`, `RunningApiServer`, the loopback-bind refusal. */
export * as apiMount from "./api/mount";

/** The composed 8.1 auth interceptor (`makeAuthInterceptor`) + its input/config shapes. */
export * as apiAuth from "./api/auth/interceptor";

/** The read-model query-port @sow/db binding (`createDbReadModelQueryPort`). */
export * as apiReadModelAdapter from "./api/adapters/readModel";

/** The command-port @sow/db binding (`createDbApprovalCommandPort`, `createDbTriagePort`). */
export * as apiCommandAdapter from "./api/adapters/commands";

/** The push-stream source (`createStreamPublisher`) + the subscription assembly (`createPushStream`). */
export * as apiStream from "./api/stream/pushStream";

/** The single redacting structured logger chokepoint (`createLogger`). */
export * as observability from "./observability/logger";

/** The System-Health SURFACE (OBS-1/OBS-2 materializer + read-model projection). */
export * as health from "./health/surface";

/** The Temporal-unavailable degraded-mode controller (`createTemporalUnavailabilityController`). */
export * as degradedTemporal from "./lifecycle/degraded/temporal-unavailable";

/** The persisted last-run bookkeeping service (LIFE-5) + its @sow/db ScheduleStore adapter. */
export * as lastRun from "./lifecycle/last-run";

/** The worker config loader (secrets-out-of-config guard). */
export * as config from "./config/load-config";

/** The operational-backup service (`createOperationalBackupService`) + its ports. */
export * as backup from "./backup/operational-backup";

/** The operational-restore service (`createOperationalRestoreService`). */
export * as restore from "./backup/restore";

/** The remote/keychain backup doctor (`createBackupDoctor`). */
export * as backupDoctor from "./backup/doctor";

/** The composition root: `assembleBackends` + the operational-truth store adapters. */
export * as composition from "./composition/backends";

/** The operational-truth store adapters (health · schedule · lease → @sow/workflows ports). */
export * as storeAdapters from "./composition/store-adapters";

/** The bound proof-spine activities (`buildProofSpineActivities`, `ProofSpineParams`). */
export * as activities from "./composition/buildActivities";

/** The Temporal worker registration wiring (`makeProofSpineRegisterHook`, `createProofSpineWorker`). */
export * as temporalRegister from "./temporal/registerWorker";
