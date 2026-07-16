# Reachability Audit — apps/desktop · Phase 14

**Auditor:** reachability-auditor (automated `/wired` fan-out)
**Date:** 2026-07-15
**Area:** `apps/desktop` (Electron desktop — renderer UI + worker-host boot)
**Scope:** Phase-14 shipped surfaces (14.1/14.5 onboarding + preset picker · 14.2 connectors · 14.3 System Health · 14.4 temporal-supervisor · 14.7 cross-workspace-links)
**Commits in scope:** `ad624a16` (14.1+14.5) · `7d141528` (14.2+14.3) · `31a0a0d3` (14.7) · `98696cea` (14.4)
**Verdict: CLEAR** — 0 non-waivered unreachable production surfaces.

---

## Production entry points enumerated

This is a frontend/UI + Electron-main area, so entry points are (a) the renderer route store + AppShell nav/mount, and (b) the Electron-main → worker-host boot chain.

1. **Renderer mount chain:** `renderer/main.tsx` → `App()` (`renderer/App.tsx`) → `<AppShell>` (`renderer/chrome/AppShell.tsx`). The surface mounted in the content pane is selected by `state.route.surface` (route model `renderer/store/route.ts`), driven by the left-rail `NavLink`s in AppShell via `onNavigate` → `navigate()` reducer.
2. **Worker-host boot chain:** `main/index.ts` → `createWorkerSupervisor({ fork: () => fork("out/worker/desktop-host.mjs", …) })` → `supervisor.start()`. Build map: `worker-host.build.mjs` `entryPoints: [worker-host/index.ts]` → `outfile: out/worker/desktop-host.mjs`. The forked host runs `worker-host/index.ts start()`.

Both are REAL production entries (not test harnesses): the fork is issued from `main/index.ts` at app launch; the renderer mount is `main.tsx`.

---

## Surface-level routing/mount proof (the 5 requested surfaces)

| Surface (task) | Route variant | AppShell NavLink | App.tsx mount | Real entry? | Verdict |
|---|---|---|---|---|---|
| Onboarding first-run + preset picker (14.1+14.5) | first-run gate (precedes AppShell; not a `Route` variant) | n/a — shown before the shell | `App.tsx` L153 `if (!hasAnyOnboardedWorkspace(state)) → <Onboarding …>` | yes — first render when no workspace onboarded | **REACHABLE** |
| Connectors surface (14.2) | `connectors` — `route.ts` L18 | `AppShell.tsx` L438 `NavLink surface="connectors"` | `App.tsx` L255-262 `route.surface === "connectors" → <Connectors …>` | yes | **REACHABLE** |
| System Health panel (14.3) | `system-health` — `route.ts` L19 | `AppShell.tsx` L445 `NavLink surface="system-health"` | `App.tsx` L263-264 `route.surface === "system-health" → <SystemHealth items={[...state.health.values()]}/>` | yes | **REACHABLE** |
| Cross-workspace-links approval UI (14.7) | `cross-workspace-links` — `route.ts` L20 | `AppShell.tsx` L452 `NavLink surface="cross-workspace-links"` | `App.tsx` L265-273 `route.surface === "cross-workspace-links" → <CrossWorkspaceLinks …>` | yes | **REACHABLE** |
| Worker-host temporal-supervisor (14.4) | n/a — boot substrate, env-gated | n/a | `worker-host/index.ts` `start()`: L118 `if (shouldManageTemporal(process.env))` → `createTemporalSupervisor(...).start()` (L120-127) BEFORE `boot.bootWorker` (L130); dispose in catch-reap (L254-262) + `shutdown()` (L285-287) | yes — reachable-when-enabled | **REACHABLE (env-gated, off-by-default)** |

**Onboarding note:** the onboarding surface is deliberately NOT a `Route` variant — it is the fail-closed first-run gate in `App.tsx` that renders *before* AppShell mounts whenever `hasAnyOnboardedWorkspace(state) === false`. It is reachable on every cold first run; once a workspace is onboarded, the gate falls through to AppShell. The preset picker is internal to `surfaces/onboarding/index.tsx` (`pickPreset` → `onPreviewPreset` → live-handle `previewPreset`), reachable through the same mount.

**14.4 env gate:** `shouldManageTemporal` (`temporal-supervisor.ts` L70-72) returns `env["SOW_MANAGE_TEMPORAL"] === "true"`. Off-by-default is expected and correct — the create+start-before-bootWorker call and both dispose sites (reap + shutdown) are all present and wired into the boot path. `main/index.ts` L87-89 forwards `SOW_TEMPORAL_ADDRESS → config.temporalAddress`, consumed at `worker-host/index.ts` L119. This is a genuine reachable-when-enabled substrate entry, not dead code.

---

## Exported-symbol inventory & classification

### Surface components (renderer/surfaces)
| Symbol | File | Referenced from (production) | Verdict |
|---|---|---|---|
| `Onboarding`, `OnboardingProps` | `surfaces/onboarding/index.tsx` | `App.tsx` (first-run gate) | REACHABLE |
| `Connectors` (+ props) | `surfaces/connectors/index.tsx` | `App.tsx` L256 | REACHABLE |
| `SystemHealth` (+ props) | `surfaces/system-health/index.tsx` | `App.tsx` L264 | REACHABLE |
| `CrossWorkspaceLinks`, `CrossWorkspaceLinksProps`, `WorkspaceOption` | `surfaces/cross-workspace-links/index.tsx` | `App.tsx` L266 | REACHABLE |

Each surface's ONLY non-test referrer is `renderer/App.tsx` (verified: no `.test.`/`.spec.`/fixtures/mocks referrer is the sole path). Not test-only.

### Store slices (renderer/store)
| Symbol | File | Referenced from | Verdict |
|---|---|---|---|
| `Route` variants `connectors` / `system-health` / `cross-workspace-links` | `store/route.ts` | `App.tsx` mount switch + `AppShell` NavLinks | REACHABLE |
| `UiSafeConnectorInstanceView` (+ slice) | `store/connectors.ts` | `store/index.ts`, `projections.ts`, `App.tsx` | REACHABLE |
| `UiSafeCrossWorkspaceLinkView`, `mintCrossWorkspaceLinkId` | `store/cross-workspace-links.ts` | surface `index.tsx`, `store/index.ts`, `projections.ts` | REACHABLE |
| `OnboardedWorkspace`, `WorkspaceBucketScope`, `scopeForType` (+ onboarding slice) | `store/onboarding.ts` | `App.tsx`, `store/index.ts`, `projections.ts` | REACHABLE |
| `connectors` / `crossWorkspaceLinks` / `onboarded` fields on `UiSafeStoreState` | `store/index.ts` | `App.tsx` via `useSyncExternalStore` | REACHABLE |

### Projection reducers (renderer/store/projections.ts — Phase-14)
`recordOnboardedWorkspace`, `resolveOnboardedWorkspaceId`, `scopeForWorkspaceId`, `hasAnyOnboardedWorkspace`, `upsertConnectorInstance`, `connectorsForWorkspace`, `upsertCrossWorkspaceLink`, `crossWorkspaceLinksList` — ALL imported and called by `App.tsx` (L8-21 import block; used in the mount/handler bodies). **REACHABLE.**

### Lib command-callers (renderer/lib — Phase-14)
| Symbol | File | Wired at | Verdict |
|---|---|---|---|
| `createOnboardWorkspace` (+ types) | `lib/onboard-workspace.ts` | `live.ts` L129 → handle.onboardWorkspace → `App.tsx` L157 | REACHABLE |
| `createPresetPreview` (+ types) | `lib/preset-preview.ts` | `live.ts` L130 → handle.previewPreset → `App.tsx` L160 + onboarding surface | REACHABLE |
| `createRegisterConnector`, `createSetConnectorState`, `createSetConnectorCadence` (+ types) | `lib/connector-config.ts` | `live.ts` L131-133 → `App.tsx` L201-206 | REACHABLE |
| `createCrossWorkspaceLink`, `approveCrossWorkspaceLink`, `revokeCrossWorkspaceLink` (+ types) | `lib/cross-workspace-link.ts` | `live.ts` L134-136 → `App.tsx` L217-222 | REACHABLE |

Every lib caller is constructed inside `live.ts`'s `StartLiveHandle` (the real tRPC client path), which `App` binds via `liveRef.current`. Not test-only.

### Worker-host temporal-supervisor (worker-host/temporal-supervisor.ts — 14.4)
Exports: `createTemporalSupervisor`, `createTemporalSpawner`, `createTemporalProbe`, `realTemporalSleep`, `shouldManageTemporal`, `TemporalSupervisor`, `TemporalHandle`, `TemporalSpawner`, `TemporalProbe`, `Sleep`, `TemporalSupervisorDeps`, `parseTemporalHostPort`, `temporalServerArgs`, `SpawnImpl`, `TemporalSpawnerOptions`, `createTemporalSupervisor`.
- The 6 entry symbols (`createTemporalSupervisor`, `createTemporalSpawner`, `createTemporalProbe`, `realTemporalSleep`, `shouldManageTemporal`, `TemporalSupervisor`) are imported by `worker-host/index.ts` L16-23 and invoked in the boot path. **REACHABLE (env-gated).**
- `parseTemporalHostPort` / `temporalServerArgs` are called internally by `createTemporalSpawner`/`createTemporalSupervisor` (production path, not just tests). **REACHABLE.**
- Remaining exports are the DI types/aliases consumed by those constructors. **REACHABLE.**

---

## Result

- **Exports audited:** 5 production surfaces/entries + ~44 supporting exported symbols across 12 Phase-14 modules.
- **REACHABLE:** all.
- **UNREACHABLE (non-waivered):** 0.
- **Waivered:** none needed — the one env-gated substrate (14.4 temporal-supervisor) is genuinely wired into the boot path and reachable-when-`SOW_MANAGE_TEMPORAL=true`; off-by-default is the intended posture, not unreachability.

**Phase-exit reachability gate: CLEAR.** No wiring tasks recommended.
