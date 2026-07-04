# RESUME HANDOFF — build the dedicated Projects PAGE (fix the §9.5 ② scope cut)

> **This is a PROSPECTIVE handoff** (written at the close of session 019 for the next session),
> not a retrospective session doc. Predecessor: `019-2026-07-04-projects-and-recent-changes-surfaces.md`.
> **Read the ⚠️ CORRECTION section of 019 first.**

---

## ▶ RESUME PROMPT (paste this to start the next session)

```
Continue the System of Work Assistant BUILD — fix the §9.5 ② Project-dashboard scope cut:
build the DEDICATED Projects PAGE + the renderer routing/AppShell foundation. The locked
design (docs/design/ui-ux/ui-ux-spec.md §4.5) requires Projects as a dedicated page; session
019 wrongly shipped it as a section on Today instead of building the routing foundation. The
Projects DATA path is already done + correct (contract · query.projectList · dev-provisioner
writer · worker-side REQ-F-011) — only the SURFACE is wrong.

Goal: a real routing foundation (route store + AppShell extraction, hand-rolled — NO router
lib) so Today and a dedicated Projects page are distinct mounted surfaces reachable from the
left-rail nav; MOVE the project rendering out of the Today section into the dedicated page
(list → detail: deterministic progress bar from the SERVER percent, blockers/waiting/next/
evidence). This foundation also unblocks the 9.6–9.14 dedicated pages.

Read first: docs/sessions/020-2026-07-04-RESUME-dedicated-projects-page.md (THIS doc — full
plan, slices, invariants), then 019 (the CORRECTION), then docs/design/ui-ux/ui-ux-spec.md
§3 "shell" + §4.5 Projects. HEAD at handoff: c073e71 (pushed to origin/main).

Method (standing): TDD for deterministic/security slices (failing test first); commit per slice
(explicit git add <path>, never -A; Conventional Commits + Co-Authored-By: Claude Opus 4.8 (1M
context) <noreply@anthropic.com>); ultracode; dispatch security-reviewer + code-quality-reviewer
per slice; run the REPO-WIDE `pnpm -w turbo run typecheck test` after any port/shared change
(a per-package gate misses cross-package consumers). Do NOT touch the 3 stray untracked files
from another session (youtube-source.ts, PHASE-13-PROPOSAL). Push at close-out (remote is
origin/main — the "no remote" note is stale). If running ultracode workflows, use the fable model.
```

---

## The mistake (own it, then fix it)

Session 019 built ② Project dashboard's DATA path correctly, then **deferred the renderer
routing/AppShell foundation and shipped Projects as a `ProjectsSection` on Today** — justified
as "avoiding a risky refactor of the working Today shell." That was a **unilateral scope cut**;
the locked design §4.5 requires a **dedicated Projects page**, and a scope cut is the owner's
call. **Owner ruling: build the dedicated page.**

## Current state (what's DONE vs what's WRONG)

**DONE + correct — the whole DATA path (do NOT rebuild):**
- `UiSafeProjectDashboard` / `UiSafeProjectProgress` contracts (`packages/contracts/src/api/ui-safe.ts`) — frozen, REQ-F-011, opaque-ref grammar, array caps. Security-reviewed clean.
- `query.projectList({workspaceId})` (`apps/worker/src/api/procedures/queries.ts`) — workspace-scoped fail-closed, re-validates + enforces REQ-F-011 via `computePercent`. Read-model key `project_dashboards` (`adapters/readModel.ts`).
- The dev-provisioner writes a real `UiSafeProjectDashboard` from the checkbox tally (`apps/worker/src/composition/provisionDev.ts`).
- Store: `projects` slice + `replaceProjects` reducer (`apps/desktop/renderer/store/`); `hydrateScope` already queries `projectList` in the workspace branch (`lib/live.ts`) → **`store.projects` is populated regardless of route**. The Projects page just reads it.

**WRONG — the SURFACE:**
- `ProjectsSection` + `ProjectItems` in `apps/desktop/renderer/surfaces/today/Today.tsx` render the projects as a Today section. **This must MOVE into a dedicated Projects page**, reached via routing. The `.sow-project*` CSS in `styles.css` can be reused by the page.

## The build — routing foundation + dedicated page (hand-rolled, NO router lib)

Two axes are INDEPENDENT: **scope** (which workspace — the §9.4 top-bar switcher, already built + security-reviewed) and **route** (which surface). Switching scope while on Projects re-scopes Projects (hydrateScope already handles this — `store.projects` re-hydrates on scope change). Do NOT entangle route with scope.

**Proposed slices (adjust as you learn the code):**

- **R1 — route store (TDD, pure).** `apps/desktop/renderer/store/route.ts`: a discriminated-union route `{ surface: "today" } | { surface: "projects"; projectId?: string }`; add a `route` field to `UiSafeStoreState` (init `{ surface: "today" }`) + a `navigate(state, route)` reducer (`store/projections.ts`). Pure → failing test first (mirror `replaceProjects`).

- **R2 — AppShell extraction (the load-bearing refactor; be careful).** Extract the persistent SHELL from `Today.tsx` into `apps/desktop/renderer/chrome/AppShell.tsx`: the top bar (scope switcher + ⌘K + egress pill) and the left rail nav. AppShell renders the shell + `{children}` (the active surface). **PRESERVE EXACTLY** the §9.4 scope switcher wiring (scope state, `setScope`/`onScopeChange`, the accent treatment, the security-reviewed drill-down affordance), the egress pill, System Health, degraded-health. The left-rail nav items call `navigate` + show an active state; "Today" → `{surface:"today"}`, "Projects" → `{surface:"projects"}`. `Today.tsx` keeps ONLY the Today content (`<main>`). `App.tsx` renders `<AppShell route onNavigate={navigate}>{route.surface === "today" ? <Today .../> : <Projects .../>}</AppShell>`. **This touches the security-reviewed shell — dispatch security-reviewer + verify the scope switcher + drill-down still behave identically.**

- **R3 — the dedicated Projects page.** `apps/desktop/renderer/surfaces/projects/Projects.tsx`: reads `store.projects` (workspace-scoped; under GLOBAL it's empty → show a "Select a workspace to see its projects" state — WS-8-consistent, confirm the exact copy with the owner or the spec). List → detail: each project's deterministic progress bar (width = the SERVER `percentComplete` — **REQ-F-011: never a UI computation**), counts, blockers/waiting/next lists, evidence chips. **REMOVE `ProjectsSection`/`ProjectItems` from `Today.tsx`** (move the rendering to the page; keep/relocate the `.sow-project*` CSS). Locked design §4.5 also names five managed docs (00 Brief … 04 Open Questions) + "re-add/refresh source" affordances — scope with the owner; the deterministic-progress list→detail is the core.

- **R4 — left-rail nav polish (optional).** Active-surface highlight, a Projects count badge if a read-model supplies one.

**Verify:** run the app (`pnpm --filter @sow/desktop dev` after `build:sow` if worker/contracts changed — they won't for R1-R4, renderer-only) with `devProvision` on → the left rail navigates Today ↔ Projects; the Projects page shows the real deterministic progress; switching scope re-scopes it; Global shows the empty/pick-a-workspace state.

## Load-bearing invariants — DO NOT break

- **The §9.4 scope switcher + drill-down are security-reviewed and load-bearing.** The AppShell extraction moves them but must not change their behavior. Re-verify with a security pass.
- **REQ-F-011:** the Projects page DISPLAYS `progress.percentComplete` (server-provided, worker-re-derived) — it must NEVER compute/infer a percent (no division, no Math in the render).
- **WS-8 isolation:** Projects is workspace-scoped; `store.projects` is `[]` under Global (never a cross-workspace blend). The route does not change scoping — scope still gates the data.
- Renderer imports `@sow/contracts` via subpaths (`api/ui-safe`), never the barrel. Paint the pastel wallpaper, never window vibrancy. Renderer-only slices are Vite-bundled (no `build:sow`).
- Commits per slice, explicit `git add`, never `-A` (the 3 stray untracked files must stay untracked + unpushed).

## Also open (lower priority than the Projects page)

- Real recent_changes + project-sync PROJECTORS (dev-provisioner is the interim project writer; recent_changes has no writer → the Today list is empty until one exists).
- D2 gated global surface (`buildGclProjection` via `admitProjection`; needs per-workspace policy provisioned).
- Live push updates for recentChanges + projects (they hydrate on scope switch, not on `read_model.change`).
- Shared `workspaceScopedRead<T>` read-model helper (≈5 near-identical copies now; extract at next worker touch).
- The two-token same-scope hydrate/refresh race (session 017).

## Build/run + test reference

- `pnpm --filter @sow/desktop dev` — build the `@sow` dist (turbo-cached) + launch Electron + spawn the worker. Turn projects on: run the worker with `devProvision` specs (BootConfig) pointing at vault notes.
- Per-package: `pnpm --filter @sow/<pkg> typecheck && test`. **Repo-wide: `pnpm -w turbo run typecheck test`** after any port/shared change. Worker boot/socket tests are `SOW_API=1`-gated.
