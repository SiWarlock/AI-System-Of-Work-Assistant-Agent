# Session 016 — Session-end handoff (degraded-health + §9.4 Global Today + §9.5 scope-aware reads)

- **Date:** 2026-07-03 · **Mode:** single-operator (build) · **Tracks:** contract · policy · worker · desktop
- **Session span:** `c609f75` (session-013 close) → **HEAD `9568616`** · **14 commits**, all LOCAL (no remote)
- **Gate at close:** contracts 594 · policy 211 · worker 335/18-skip · desktop 82 · all typecheck clean · api-live 11/11 · tree clean
- **Reviews this session:** 4 subagent review passes — degraded-health (security 0 + code-quality 2-med-fixed); §9.4 drill-down (security 0, could not refute 5 isolation properties); §9.4 renderer (code-quality 2-high+3-med fixed, 2-low deferred).

## What shipped this session (three work streams)

### 1. Degraded-health surfacing — System Health shows "Worker down" (session 014)
`41f0a93`→`9bccdd6` (+docs `32a7a8d`). Root cause: the Temporal-degraded controller's `HealthSurface` wrote to an **in-memory** store while the `systemHealth` query reads the **persistent** `health_items` table — disconnected. Fix: `createPersistentHealthSurfaceStore` bridges the surface onto the persistent bare `HealthItemStore` (no `@sow/db` change — the repo already owns OBS-2 dedupe/occurrenceCount); `reportInitialConnect` drives `onConnectionLost` on a degraded connect (+WARN on a persist fault); the worker-host awaits it before announcing ready (closes the hydrate race). Detail: `docs/sessions/014-…`.

### 2. §9.4 Global Today — GCL sanitized grouped results + policy-gated drill-down (session 015)
`93e44a9`→`84f9888` (6 feature + review + docs). **Owner-approved: built as the Global scope on the unified Today** (honoring the locked design over the plan's separate `global-today/` page). Backend (security-reviewed clean): `UiSafeGclProjection`, `permitsRawDrillDown` (full-only gate), `query.global` now UI-safe, and the **`globalDrillDown` safety core** (server-enforced, workspace-scoped, fail-closed, un-spoofable). Renderer: the scope switcher + grouped-GCL "Across your workspaces" section + the gated drill affordance. Detail: `docs/sessions/015-…`.

### 3. §9.5 scope-aware reads — the switcher is now functional (this session, `9568616`)
Switching scope re-queries the scope-appropriate read-model and **never blends** across scopes: Global → `query.dashboard` + `query.global`; a workspace → `query.workspace(workspaceId)` (single-workspace). `replaceCards` (replace, not upsert) + `hydrateScope` (clear-first, stale-scope-guarded) + the App wiring. Drill-down navigates via `onScopeChange` (the gated drill is the permission check).

## Current state — what RUNS

`pnpm --filter @sow/desktop dev` → Electron main spawns `@sow/worker` as a supervised `child_process.fork` child (system node, `--conditions=sow-built`); the renderer subscribes live over tRPC-WS; the locked Liquid-Glass Today renders with a green **Live** pill. The **scope switcher** (All (Global) / Employer-Work / Personal-Business / Personal-Life) works, re-colors the accent (Treatment 1: dot + scope line only), and re-queries per scope. Under Global, an **"Across your workspaces"** grouped-GCL section renders with a gated drill affordance. **System Health** shows "Worker down" on the Temporal-degraded first render.

## The honest boundary — LIVE WIRING over EMPTY DATA

Everything is wired + TDD-covered, but the read-models are **empty until ingestion runs** (`buildGclProjection` on real workspace content, which needs provisioned workspaces via onboarding §9.12). So:
- The Global "Across your workspaces" section shows **"Nothing across your workspaces yet"**.
- Workspace scopes show empty cards (the placeholder `workspaceId`s don't resolve to real workspaces).
- The drill-down is fully wired + adversarially verified but returns empty over the empty read-model.
- The Daily brief / Today's schedule / Recent activity / nav counts (Approvals 3, Inbox 5) / Egress pill remain **static illustrative content** (9.4a design-fidelity port), not yet read-model-driven.

This is the same plumbing-over-empty posture as 9.4b — and the secure one (no seed that would bypass the visibility gate).

## Known follow-ups introduced this session (documented in code)

- **Stream push-path scope-filtering** (`live.ts`): the PULL/query path is scope-correct, but a `read_model.change` STREAM event still upserts regardless of scope (`UiSafeDashboardCard` carries no `workspaceId` to filter on). Scope-correct streaming needs a `workspaceId` on the card OR a per-subscription server scope. Doesn't manifest over empty data.
- **Full AppRouter typing**: the renderer client is `AnyTRPCRouter`; `query.*` / `systemHealth.*` / `globalDrillDown` calls are `(client as any)`. Needs `@sow/worker` to emit an `AppRouter` `.d.ts` (worker-track) to type them.
- **Deferred lows (code-quality)**: no `aria-activedescendant` on the scope listbox (a11y pre-release gap); `onDrillDown`/`onScopeChange` not `useCallback`-memoized (cosmetic — closures are stable).

## Load-bearing invariants (don't relearn)

- `@sow` packages build **structure-preserving** (tsc, `dist` mirrors `src`) behind a **`sow-built` export condition** + a child-only resolve-loader — never bundle (breaks `@sow/contracts`' `import.meta.url` schema loading). Rebuild the child dist with `pnpm --filter @sow/desktop run build:sow` after a worker/policy/contracts change (renderer changes are Vite-bundled, no rebuild).
- Fork the worker child with `execPath` = **system node** (not the Electron binary — ABI).
- Renderer imports `@sow/contracts` via **subpaths** (`api/ui-safe`, `api/events`), never the barrel (pulls `node:fs`).
- **Paint** the pastel wallpaper, never window `vibrancy`.
- The **§9.4 security model**: the drill-down gate is enforced **server-side** (`globalDrillDown` re-derives the level from the server's own global surface; the renderer only requests + folds denials to a no-op). Never move the gate to the renderer.
- Commits are **LOCAL** (no remote — push only if one is configured).

## Build/run + test reference

- `pnpm --filter @sow/desktop dev` — build the `@sow` dist (turbo-cached) + host entry, launch Electron, spawn the worker.
- Per-package: `pnpm --filter @sow/<pkg> typecheck && test`. The worker's socket + drill-down e2e tests are `SOW_API=1`-gated (`api-live.test.ts`, `boot-degraded.test.ts`).
- The §9.4 drill-down adversarial suite: `apps/worker/test/api/procedures/queries.test.ts`.
