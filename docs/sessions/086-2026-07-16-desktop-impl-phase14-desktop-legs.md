# Session 086 — Phase-14 desktop legs (onboarding · connectors · health · cross-workspace links · local-Temporal supervision)

- **Date:** 2026-07-16
- **Role/agent:** desktop-impl (implementer, desktop track) — team `session-734f946b`
- **Orchestrators (cycled across the session):** orch22 → orch23 → orch24
- **Branch:** `main` (single-track)
- **Phase:** 14 (Onboarding, Config Surfaces & Runtime Substrate — §19.1). This doc is the Phase-14 desktop close-out (the `/phase-exit 14` checklist notes it lands at desktop-impl's cycle).
- **Scope:** ALL the Phase-14 desktop-track legs, built on top of the shipped worker-foundation round (workspace onboarding + the 3 registries + preset profiles + System-Health read-path).

## What was built

Six commits, each strict-TDD + mandatory dual review (security-reviewer = `invariant` on every safety-relevant slice; code-quality every-slice), all `apps/desktop/`-only, no hard line crossed.

| Leg | Commit | Summary |
|---|---|---|
| 14.1 + 14.5 — onboarding UI + preset picker | `ad624a16` | The first-run onboarding surface (stepped: name+type → vault root + gbrainBrainId → preset pick with live `presetProfiles.preview`) driving `onboarding.createWorkspace`; **the real onboarded-id scope model** replacing the `scope.ts` placeholder ids. |
| 14.2 + 14.3 — connectors surface + System Health panel | `7d141528` | Per-workspace connectors settings (register/enable/pause/set-cadence over `connectorConfig`, tokenRef reference-only) + the System-Health panel. |
| 14.7 — cross-workspace-links approval UI | `31a0a0d3` | The rule-4 owner-approval surface (the single sanctioned WS-8 cross-read authorization) over `crossWorkspaceLink.create/approve/revoke`. |
| 14.4 — app-managed local Temporal supervision | `98696cea` | The worker-host spawns/supervises a loopback-only local Temporal dev-server, mirroring the gbrain-serve supervisor. **G62 hard-line→substrate downgrade — OWNER RATIFIED 2026-07-15.** |
| 14.4-durability — Temporal `--db-filename` | `3270a7d6` | Persist the managed Temporal (§13 "never in-memory" / LIFE-3); closes a `/phase-exit 14` arch-drift Finding. |
| 14 design review (task 52) | — (report only) | Static/code-level design pass (no app-up env); routed the visual-polish debt. |

Desktop suite grew 244 → **311 tests** across the arc (all green); repo-wide typecheck + esbuild worker-host bundle + prettier clean throughout.

### 14.1 + 14.5 — onboarding UI + preset picker + the real scope model (`ad624a16`)
- New `surfaces/onboarding/` — a 3-step flow calling the shipped worker procedures via fail-closed command-callers (`lib/onboard-workspace.ts`, `lib/preset-preview.ts`); a `createWorkspace` failure surfaces a safe error state (`role="alert"`), never a raw cause.
- **The scope-model re-point (the load-bearing WS-8 change):** the 3 scope buckets == the 3 `WorkspaceType`s. Dropped the `scope.ts` provisioning-placeholder `workspaceId`s for a new `onboarded` store slice (the source of real minted ids); `ScopeMeta.workspaceId` → a stable `isGlobal` flag; fail-closed selectors (`resolveOnboardedWorkspaceId` / `hasAnyOnboardedWorkspace` / `scopeForType` / `scopeForWorkspaceId`). Six read-sites re-pointed off the static resolver (App×2, live×3, scope-refresh); the Copilot ask-gate threaded via AppShell. **`isWorkspaceScope` (the push-fold isolation predicate) re-keyed to `isGlobal`** so an un-onboarded/unknown scope stays isolated — the plausible critical of leaving `workspaceId !== null` was avoided.
- First-run gate: App renders Onboarding when `!hasAnyOnboardedWorkspace(state)`, else the app.

### 14.2 + 14.3 — connectors surface + System Health panel (`7d141528`)
- `surfaces/connectors/` — per selected onboarded workspace (WS-8): register + enable/pause + set-cadence over `connectorConfig`, tracked **optimistically** from mutation returns in a new `connectors` store slice (no cold-load list read exists yet). **tokenRef is reference-only** (rule 7): forwarded on register but `foldInstance` reconstructs the return from an allowlist (no tokenRef round-trips/stores/renders), and the input is cleared post-submit. Per-row cadence input (fixed a shared-form-value UX surprise in review).
- `surfaces/system-health/` — renders the **existing `state.health` slice** (already hydrated from `systemHealth.items` by `hydrate()` + the health stream). A Step-1 discovery: I started a redundant `systemHealth` slice/caller, then **reverted it** on finding the data path already existed — no duplicate read path.

### 14.7 — cross-workspace-links approval UI (`31a0a0d3`)
- `surfaces/cross-workspace-links/` — the rule-4 surface: create a directional+scoped PENDING link → **deliberate per-link approve** (renders the full `from → to` + projType/visLevel; aria-label restates it) → terminal revoke. Renders only the 9 UI-safe link fields (no raw content). WS-8 from/to pickers offer only onboarded workspaces; self-link blocked client-side. **No pre-approval smuggling** — create sends exactly the 5 whitelisted fields.
- **Deterministic collision-free `linkId`** (`from~to~projType~visLevel`, `~`-delimiter percent-escaped) — idempotent per authorization; a scope change → a new link needing its own approval (aligns with worker Lesson 32).

### 14.4 + 14.4-durability — app-managed local Temporal supervision (`98696cea`, `3270a7d6`)
- New `worker-host/temporal-supervisor.ts` mirroring `gbrainServeSupervisor`: a pure `createTemporalSupervisor` state machine (spawn→ready→bounded-restart→dispose) over injected spawn/probe/sleep; loopback-guard-first via the authoritative `@sow/policy.isLoopbackHost` (Lesson 4); `temporalServerArgs` forces every listener loopback (`--ip` + `--ui-ip`, Context7-grounded). Real `createTemporalSpawner` (args-array/no-shell, `stdio:"ignore"`, injected `spawnImpl`) + probe are integration-gated — **the suite spawns no real Temporal** (the owner condition). Env-gated OFF by default (`SOW_MANAGE_TEMPORAL === "true"`) → byte-equivalent.
- Durability (`3270a7d6`): `--db-filename <userData>/temporal/dev.db` — a **typed-required** param so a `start-dev` without persistent storage is structurally un-buildable (§13, LIFE-3). Path derived `main app.getPath → config.dbPath → dirname → temporalDbPathUnder`; `createTemporalSpawner` mkdir-recursive's the parent via an injected `mkdirImpl` (best-effort). `temporalManagementPlan` fail-safe gate: skips on flag-off OR absent dbPath — never an in-memory fallback.

## Decisions made (load-bearing, orchestrator-signed)
1. **3-bucket scope model** — the 3 scope buckets are the 3 workspace types; the `onboarded` slice is the real-id source; `isGlobal` flag over a nullable placeholder id (preserves the isolation predicate). (orch22 APPROVED.)
2. **Optimistic lists** for connectors + cross-workspace-links — no cold-load list query exists on the worker; track from mutation returns + flag `listByWorkspace` Future-TODOs. (orch22/orch23 APPROVED.)
3. **14.3 reuses `state.health`** — not a new slice/query (reverted the redundant one). (Step-1 discovery.)
4. **linkId = deterministic collision-free anchor-id** over `crypto.randomUUID` — idempotent, scope-change=new link, test-deterministic, collision-free by construction (percent-escaped delimiter). (orch23 APPROVED the deviation.)
5. **Temporal env-gate `SOW_MANAGE_TEMPORAL` default-OFF** — diverges from gbrain's `const=true` because the byte-equivalent-OFF acceptance demands a default-OFF gate. (orch23 APPROVED.)
6. **`--db-filename` typed-REQUIRED** — a structural (Lesson-31-style) no-in-memory pin; userData derived from `dirname(config.dbPath)`; `temporalManagementPlan` fail-safe. (orch23 APPROVED, incl. the fail-safe-edge pin.)
7. **`@sow/policy` added as a desktop devDep** to reuse the authoritative `isLoopbackHost` (Lesson 4 — never re-implement a security predicate); already transitively bundled + imported in worker-host.

## Decisions explicitly NOT made (deferred, by design)
- **Visual / Liquid-Glass styling** — the `/tdd` briefs deferred visual polish to `/design-review`; task 52's static pass confirms the surfaces render unstyled (the styling-slice debt below). Functional completion is NOT blocked by this.
- **Real connector/Temporal transports** — everything stays dormant; no arming, no real external write/fetch/spend/credential, no hard line crossed. Approving a cross-workspace link crosses zero data today (the read gate's consumers are dormant, 25.2/25.4).
- **The cold-load list queries** (`connectorConfig.listByWorkspace`, `crossWorkspaceLink.listByWorkspace`) — worker Future-TODOs, not built in the desktop slices.
- **The `scopeProjectionType` taxonomy formalization** — an open arch_gap; the surface offers a curated set (calendar_busy/busy_free_window/deadlines/task_rollup/summary) + a Future-TODO.
- **Worker-side tokenRef reference-shape enforcement + a shared `127.0.0.1:7233` const + a branded non-empty-path type** — flagged as follow-ups (not this track / optional hardening).

## Open follow-ups
1. **Phase-14 desktop STYLING slice** (task-52 findings) — Liquid Glass CSS for the 5 surfaces + adopt the shared `sow-content` / `sow-page-head` page-shell + per-row button variants (`sow-*-btn--<variant>`) + loading/step affordances. Mostly CSS + minor JSX, no logic change. desktop-impl can take it on dispatch.
2. **Live `/design-review`** when an app-up environment exists (this cycle was static/code-level only — no app-up env per `/phase-exit 14`).
3. **Worker Future-TODOs** (routed to worker-impl2 by the orchestrators): `connectorConfig.listByWorkspace` + `crossWorkspaceLink.listByWorkspace` (WS-8-scoped) · tokenRef reference-shape enforcement (14.7 worker) · share the `127.0.0.1:7233` default const between desktop `TEMPORAL_DEV_ADDRESS` and worker `boot.ts` · formalize the cross-workspace-allowed projection taxonomy.
4. **Deferred review nits** (all non-blocking, flagged in the respective Step-9s): onboarding `from`-default stale on scope-switch-while-mounted; connectors no in-flight busy-gate on toggle/cadence (Lesson-6-deferred); the Temporal `dirname(config.dbPath)` userData coupling; the unreachable spawner fallback omitting `--ip`.
5. **15.8 desktop leg** (human routing-resolution loop) — desktop-impl picks it up on orch24's dispatch.

## Review posture (for the record)
Every safety-relevant slice was dual-reviewed with **security-reviewer = invariant** and returned **CLEAR** (0 findings): the WS-8 isolation re-point (14.1), tokenRef-reference-only + WS-8 scope + health redaction (14.2/14.3), the rule-4 deliberate-approve + no-smuggling + UI-safe-only + collision-free-mint (14.7), and the loopback-bind + args-array/no-shell + no-orphan + byte-equivalent-OFF + §13-persistent-storage legs (14.4 + durability). Code-quality reviews were SHIP with only low/medium nits, the load-bearing ones fixed in-slice.
