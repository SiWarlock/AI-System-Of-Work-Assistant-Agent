# Phase-14 Reachability Audit — WORKER track

**Area:** worker track (`apps/worker` + `packages/db` + `packages/workflows`) — plus the
14.4 `worker-host` Temporal-supervisor wiring in `apps/desktop/worker-host/`.
**Auditor:** reachability-auditor (automated `/wired` across the phase's shipped surfaces).
**Date:** 2026-07-15 · **HEAD:** `98696cea`
**Gate:** phase-exit reachability gate for Phase-14 (Onboarding, Config Surfaces & Runtime Substrate).

## Method

Enumerated Phase-14's shipped exported symbols from the commit set
(`e1e4cfdc` 14.1, `b9dc03b3`/`21ee9065` 14.6, `bda2c911`/`6f639a63` 14.2,
`a81040e7` 14.5+14.3, `4d36b9b2`/`06ba3d3a` 14.7, `98696cea` 14.4).
Production entry point for the worker API surface = the tRPC root router `composeAppRouter`
(`apps/worker/src/api/server.ts`), reached from the real process entry:

```
Electron main ──forks──▶ apps/desktop/worker-host/index.ts  (child-process host entry)
   └─ start(config) ─▶ boot.bootWorker({...})                 apps/worker/src/boot.ts
        └─ binds REAL @sow/db ports from backends.repos.*  (createSqliteRepositories / Postgres)
        └─ startApiServer({ onboarding, projectRegistry, connectorConfig, crossWorkspaceLink, ... })
             └─ createApiServer ─▶ composeAppRouter  ─ mounts all 5 Phase-14 routers
```

`backends.repos = createSqliteRepositories(db)` (backends.ts:244) exposes the four Phase-14
Drizzle-backed repos; boot.ts binds each real command port (lines 1172–1202) and passes them into
`startApiServer` (lines 1567–1570); `composeAppRouter` mounts them (server.ts:126–130). Every
symbol below was traced from that entry, counting production-path references only (test/fixture
references excluded).

## Result

**reachability-auditor: worker (Phase-14) — 11 production surfaces audited**
- REACHABLE: 11
- UNREACHABLE (non-waivered): 0
- UNREACHABLE (documented waivers, EXPECTED — not gaps): 2

### REACHABLE (production entry traced)

| # | Symbol | File | Entry path |
|--:|---|---|---|
| 1 | `provisionWorkspace` | `apps/worker/src/composition/provisionWorkspace.ts:88` | `createProvisionWorkspacePort` → `onboarding` port → `onboarding.createWorkspace` mutation (server.ts:126) |
| 2 | `createProvisionWorkspacePort` / `buildOnboardingRouter` | `apps/worker/src/api/procedures/onboarding.ts` | boot.ts:1172 → server.ts:126 |
| 3 | `registerWorkspace` (WS-8 registry union) | `apps/worker/src/composition/workspaceRegistry.ts:49` | called by `provisionWorkspace` (prod) + `provisionDev` |
| 4 | `createProjectRegistryEntry` / `createProjectRegistryCommandPort` / `buildProjectRegistryRouter` | `apps/worker/src/composition/projectRegistry.ts`, `.../api/procedures/projectRegistry.ts` | boot.ts:1182 → `projectRegistry.createProject` mutation (server.ts:127) |
| 5 | `project_registry` store (`ProjectRegistryRepository`) | `packages/db` (sqlite+pg adapters) | reached by createProject via `backends.repos.projectRegistry` |
| 6 | `createConnectorConfigCommandPort` / `buildConnectorConfigRouter` (`register`/`setState`/`setCadence`) | `apps/worker/src/composition/connectorConfig.ts`, `.../api/procedures/connectorConfig.ts` | boot.ts:1190 → server.ts:128 |
| 7 | `connector_instance` store (`ConnectorInstanceRepository`) | `packages/db` | reached via `backends.repos.connectorInstance` |
| 8 | `createCrossWorkspaceLinkCommandPort` / `buildCrossWorkspaceLinkRouter` (`create`/`approve`/`revoke`) | `apps/worker/src/composition/crossWorkspaceLink.ts`, `.../api/procedures/crossWorkspaceLink.ts` | boot.ts:1198 → server.ts:129 |
| 9 | `cross_workspace_link` store (`CrossWorkspaceLinkRepository`) | `packages/db` | reached via `backends.repos.crossWorkspaceLink` |
| 10 | `presetProfiles` / `buildPresetProfilesRouter` (`preview` query) | `apps/worker/src/composition/presetProfiles.ts`, `.../api/procedures/presetProfiles.ts` | server.ts:130; `preview` query calls `presetProfiles(input)` |
| 11 | 14.4 `temporal-supervisor` (`createTemporalSupervisor`, `shouldManageTemporal`, spawner/probe) | `apps/desktop/worker-host/temporal-supervisor.ts` | wired into `worker-host/index.ts` `start()` at lines 118/127, behind `shouldManageTemporal(process.env)` (env-gated, default-OFF) |

Note on #11: env-gated (default-OFF) ≠ unreachable — the supervisor is imported and `.start()`-ed
on the real host start path; the gate is an owner/env activation switch (Lesson 2/11 pattern),
not a missing production reference. `WorkspaceConfigRepository` (14.1) is likewise real and reached
via the onboarding port (`backends.repos.workspaceConfig`, boot.ts:1173).

### UNREACHABLE — documented waivers (EXPECTED; NOT gaps)

| Symbol | File | Only referenced from | Waiver |
|---|---|---|---|
| `resolveApprovedCrossWorkspaceSlice` (14.7 read gate) | `apps/worker/src/composition/crossWorkspaceRead.ts:38` | own test + a boot.ts *comment* (no call) | Prod consumers = 25.2/25.4 coordination/global briefs (dormant). Dispatcher-listed waiver; Lesson 11/32. |
| `createProjectRegistryResolvePort` (production `ResolveRegistryPort` binder) | `apps/worker/src/composition/projectRegistry.ts:65` | `projectRegistry.test.ts` only | Binding into dormant `runProjectSync` deferred — dormant-on-dormant avoided (Lesson 11). Dispatcher-listed waiver. |

Phase-15 store bindings (`seenContentHash` / `SourceDisposition`) are out of Phase-14 scope
(Phase-16 binding) and were not audited here — dispatcher-listed waiver.

## Summary for orchestrator

- Wiring tasks recommended: **0**.
- Every Phase-14 worker-track production surface (onboarding/`provisionWorkspace` + WS-8 registry,
  `projectRegistry` create + store, `connectorConfig` register/setState/setCadence + store,
  `crossWorkspaceLink` create/approve/revoke + store, `presetProfiles` + `preview`, and the 14.4
  `temporal-supervisor` host wiring) traces to the tRPC root router or the worker-host start path
  from a real process entry point.
- The only two unreachable Phase-14 symbols are the exact dispatcher-listed waivers
  (`resolveApprovedCrossWorkspaceSlice`, `createProjectRegistryResolvePort`) — dormant-consumer
  gate + deferred resolve-port binding per Lesson 11. No dangling non-waivered surface.
- **Phase-exit gate: CLEAR** (0 non-waivered unreachable).
