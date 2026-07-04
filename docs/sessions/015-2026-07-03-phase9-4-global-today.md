# Session 015 — Phase 9.4: Global Today (GCL sanitized grouped results + policy-gated drill-down)

- **Date:** 2026-07-03 · **Mode:** single-operator (build) · **Tracks:** contract · providers-integrations (policy) · worker · desktop
- **Predecessor:** `014-2026-07-03-degraded-health-surfacing.md` (HEAD `32a7a8d`)
- **HEAD at close:** `4cb75f0` · **6 commits** (`93e44a9`…`4cb75f0`), all LOCAL (no remote)
- **Gate:** contracts 594 · policy 211 · worker 335/18-skip · desktop 80 · all typecheck clean · api-live 11/11 · tree clean
- **Reviews:** security-reviewer on the drill-down safety core → **0 findings** (could not refute any of the 5 isolation properties); code-quality-reviewer on the renderer half → **2 high + 3 medium fixed, 2 low deferred** (`4797344` review-response).

## The owner decision (load-bearing)

§9.4 is built as **ONE scoped Today surface with a top-bar scope switcher** (All (Global) / Employer-Work / Personal-Business / Personal-Life), **honoring the locked UI/UX design** (`ui-ux-spec.md` §"Workspace scope model") over the plan's pre-lock `surfaces/global-today/` file-layout. The design **merges** the plan's separate "Global Today" (§9.4) and "Workspace tabs" (§9.5) into one scoped Today. Owner-approved 2026-07-03; recorded in memory `sow-phase9-4-global-today.md`.

**Security posture (owner-directed "architecturally correct + most secure"):** one scope switcher = one place the WS-8 visibility gate is enforced; the renderer gets only UI-safe projections; drill-down is worker-enforced + workspace-scoped; **empty until real ingestion — NO seed** (a seed would place data on screen bypassing the gate).

## Slice-by-slice (the 6 commits)

| Commit | Slice | Track | Summary |
|---|---|---|---|
| `93e44a9` | 1 | contract | `UiSafeGclProjection` — the UI-safe shape (workspaceId · visibilityLevel · projectionType · summary · drillable). Drops the open `sanitizedPayload` + internal `sourceRefs`; `summary` re-bounded single-line. Behind the freeze test + `Exact<>` parity. |
| `e7fc5fc` | 2a | policy | `permitsRawDrillDown(level) = level === "full"` — the shared drill gate (fail-closed). |
| `e1c6286` | 2b | worker | `query.global` now returns **UI-safe** projections via `toUiSafeGclProjection` + `projectGlobal` (was shipping the RAW `GclProjection` — the one query surface bypassing the 8.2 allowlist). |
| `731fa9a` | 3 | worker | **SAFETY CORE** — `globalDrillDown`: server-side gate, fail-closed, workspace-scoped (never blended). Adversarially security-reviewed clean. |
| `01e7169` | 4 | desktop | The scope switcher on Today (store scope state + `setScope`) + per-workspace accent (Treatment 1: dot + scope line only; app stays blue). |
| `4cb75f0` | 5 | desktop | Global-scoped Today renders grouped GCL (`groupGlobalByWorkspace`, empty state) + the drill affordance (iff `drillable`) → `drilldown.ts` → `query.globalDrillDown`; hydrate + App wiring. |

## The security core (WS-8 drill-down) — how it's enforced

`resolveGlobalDrillDown` (`apps/worker/src/api/procedures/queries.ts`):
1. Re-read + re-validate the global surface through the §6 gate (`sanitizeGlobal`) — a leaky (multi-line) projection fails closed **before** any drill.
2. Match the `(workspaceId, projectionType)` pointer the renderer supplied; none → `DRILL_TARGET_NOT_FOUND`.
3. **Fail-closed:** every matching projection must pass `permitsRawDrillDown` (full-only); the level is re-derived from the **server's** own surface. `parseGlobalDrillInput` reads ONLY `workspaceId`+`projectionType`, so a renderer-spoofed level/drillable is dropped and can never force a drill.
4. Permitted → `readModel.workspaceCards(workspaceId)`: a single-workspace read, structurally never a blended cross-brain query; result is UI-safe cards.

Security review (adversarial, trying to REFUTE) could not break any of: full-only · un-spoofable/server-derived · single-workspace · typed-err-no-leak · fail-closed. WS-8 isolation + secrets + candidate-data invariants all PASS.

## What's live vs. what's empty (the honest boundary)

- **Live wiring, empty data:** the Global "Across your workspaces" section renders `query.global` grouped by workspace, but the `global_surface` read-model is empty (no ingestion has run `buildGclProjection`), so it shows **"Nothing across your workspaces yet"**. The scope switcher works and re-colors the accent. All logic is TDD-covered over fixtures.
- **The drill-down** is fully wired end-to-end (renderer → gated worker query → workspace-scoped read) and adversarially verified, but returns empty cards over the empty read-model.

## What's still missing / next

- **Real GCL data** — run `buildGclProjection` on real workspace content (needs ingestion + provisioned workspaces via onboarding §9.12) to populate `global_surface`. Until then §9.4 is plumbing-over-empty (same posture as 9.4b).
- **Workspace-scope rendering (§9.5)** — selecting a workspace scope currently shows the existing Today (cards/health); the per-workspace read-model wiring + Project/Recent-changes surfaces are §9.5. The scope→workspaceId mapping is a placeholder until onboarding mints real ids.
- **Wire the static Today sections to real read-models** (Daily brief / schedule / recent activity / nav counts) — still `static illustrative content`.
- **9.6–9.14** surfaces + the dashboard warm-load benchmark + the desktop-security hardening pass.
- **Full AppRouter typing** — the renderer client is `AnyTRPCRouter` (`(client as any)`); the drill + global calls are dynamic. Needs `@sow/worker` to emit an `AppRouter` `.d.ts` (worker-track).

## Code-quality review outcome (renderer)

**Fixed in-slice:** (high) the ScopeSwitcher pull-down had no click-outside dismissal → added a document-mousedown listener + focus-out close; (high/test) `hydrateGlobal` non-empty→empty retraction was untested → pinned; (medium) the GlobalGroups row key used `type-index` → now `workspaceId-type-index` (duplicate-type safe); (medium/doc) clarified the retraction comment. **Confirmed intentional (not a bug):** Employer-Work shares the system-blue accent by locked design (documented in `scope.ts`). **Deferred (low, pre-release):** no `aria-activedescendant` on the listbox (screen-reader focus tracking — a11y is a pre-release gap, not a Phase-1 req); `onDrillDown` not `useCallback`-memoized (cosmetic — the closure is stable, no correctness bug).

## Build/run reference

- `pnpm --filter @sow/desktop dev` — builds the `@sow` dist (turbo-cached; rebuilt this session for contracts/policy/worker) + the host entry, launches Electron, spawns the worker. The scope switcher offers All (Global) + the 3 workspaces; under Global the "Across your workspaces" section renders (empty until data).
- The worker's socket + drill-down tests are `SOW_API=1`-gated; the drill-down adversarial suite is in `apps/worker/test/api/procedures/queries.test.ts`.
