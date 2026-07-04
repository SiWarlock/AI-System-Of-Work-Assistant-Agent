# Session 021 — §9.5 dedicated Projects PAGE + renderer routing/AppShell foundation (the scope-cut fix)

- **Date:** 2026-07-04 · **Mode:** single-operator (build) · **Track:** desktop
- **Predecessor:** `020-2026-07-04-RESUME-dedicated-projects-page.md` (the resume handoff this session executed; HEAD at handoff `24aec7e`)
- **Successor:** `022-2026-07-04-docpack-and-ui-test-harness.md` (§4.5 doc pack + the JSX-render test harness)
- **HEAD at close:** `f86d2d0` · **3 slice commits** (`c1f585d` R1 · `c379f84` R2 · `f86d2d0` R3)
- **Gate at close:** repo-wide `turbo lint typecheck test` **42/42 successful**; desktop suite **111/111**; renderer bundles (electron-vite, 87 modules); tree clean (+ untracked files from a parallel session — `youtube-source.*`, `capture-source.*`, `PHASE-13-PROPOSAL-…` — left untouched per owner instruction).
- **Reviews:** 5 subagent reviews across 3 slices — R1 code-quality (2 low, both fixed); R2 security **all 4 invariants CONFIRMED, 0 general findings** + code-quality (2 low); R3 security **all 5 invariants CONFIRMED, 0 findings** + code-quality (1 med fixed in-slice, 1 low flagged). No critical/high anywhere.

## Why this session existed

Owner ruling (2026-07-04): session 019 wrongly interim-shipped the §9.5 ② Project dashboard as a
**section on Today** and unilaterally deferred the renderer routing/AppShell foundation — a scope
cut the owner rejected ("that wasn't your decision to make. there should be a dedicated projects
page"). The locked design §4.5 requires a **dedicated Projects PAGE**. This session builds the
routing foundation + the dedicated page, MOVING the project rendering off Today. It also unblocks
the 9.6–9.14 dedicated pages (they now have a shell + route model to mount into).

## What was built

Three TDD/refactor slices (plan R1→R2→R3 from the 020 handoff):

### Files created
- `apps/desktop/renderer/store/route.ts` — the renderer ROUTE model (§9.5): a `Route` discriminated union `{surface:"today"} | {surface:"projects";projectId?}`, `DEFAULT_ROUTE` (frozen singleton), structural `routeEquals`. Window-free (LESSONS §3). Route is INDEPENDENT of scope.
- `apps/desktop/renderer/chrome/AppShell.tsx` — the persistent shell extracted out of Today: top bar (scope switcher · ⌘K · egress + connection pills · gear), scope line, left-rail nav (new `NavLink` routing Today/Projects), Copilot rail. Renders the active surface as `{children}`.
- `apps/desktop/renderer/lib/accent.ts` — the shared `accentVar` CSS-var helper (used by the shell's scope switcher + Today's Global groups).
- `apps/desktop/renderer/surfaces/projects/Projects.tsx` — the dedicated Projects PAGE: master list (left) + detail (right), deterministic progress, blockers/waiting/next/evidence.
- `apps/desktop/renderer/surfaces/projects/select.ts` — window-free `resolveSelectedProject(projects, projectId)` list→detail resolver (LESSONS §3).
- `apps/desktop/test/renderer/route.test.ts` — 6 route-reducer tests (R1, test-first).
- `apps/desktop/test/renderer/projects-select.test.ts` — 4 selection-resolver tests (R3, test-first).

### Files modified
- `apps/desktop/renderer/store/index.ts` — added required `route: Route` field to `UiSafeStoreState` + `route: DEFAULT_ROUTE` to initial.
- `apps/desktop/renderer/store/projections.ts` — added the pure `navigate(state, route)` reducer (scope-independent; ref-stable no-op).
- `apps/desktop/renderer/App.tsx` — reads the `route` slice, mounts the active surface inside `<AppShell>`; `onNavigate` + `onSelectProject` (sets `route.projectId`, scope-preserving).
- `apps/desktop/renderer/surfaces/today/Today.tsx` — now renders ONLY its `<main>` content pane (shell moved to AppShell); removed `ProjectsSection`/`ProjectItems` + the `projects` prop.
- `apps/desktop/renderer/styles.css` — new `.sow-projects-*` two-pane list/detail classes; removed the 4 dead card rules (`.sow-projects`, `.sow-project`, `.sow-project-head`, `.sow-project-title`) orphaned by the ProjectsSection removal.

## Decisions made

- **Hand-rolled routing (NO router lib)** — a `Route` discriminated union + a pure `navigate` reducer, mirroring the existing scope model. Route ≠ scope: SCOPE gates the DATA, ROUTE selects the SURFACE; the two never entangle (switching scope leaves the route; navigating leaves the scope + scope-hydrated data).
- **R2 = pure behavior-preserving extraction.** The security-reviewed §9.4 scope switcher (ARIA listbox + dismissal) and the WS-8 Global gate + drill-down were moved VERBATIM; the projects route rendered a short-lived stub so the extraction could be security-reviewed in isolation before the real page landed in R3. Security-review CONFIRMED behavior preservation.
- **Selection source of truth = the route's `projectId`.** `resolveSelectedProject` falls back to the first project on an absent/stale id (never a blank detail); undefined only when the list is empty. Selecting from a foreign scope can't resurrect a foreign project (it selects only from the current scoped list).
- **Two distinct empty states** (WS-8): under Global → "Select a workspace to see its projects" (gated on `scope === "global"`, not merely on emptiness); under a workspace with no projects → "No projects in this workspace yet".

## Decisions explicitly NOT made (deferred / surfaced to owner)

- **The §4.5 managed doc pack (00 Brief · 01 Decisions · 02 Meeting Digest · 03 Research · 04 Open Questions) + re-add/refresh affordance — DEFERMENT SURFACED TO OWNER, awaiting decision.** It needs a Drive connector + a doc-pack read-model that don't exist yet. Asked via `AskUserQuestion` (owner away — proceeded with the recommended "defer pack, build core now"; the question is on record, re-askable). This is NOT a silent cut — it's a flagged deferment the owner can revisit. Building it would require a new contract + data path + fake data.
- **A JSX-render test harness (jsdom + @testing-library/react).** The repo has NO component-render test harness — the whole surface layer (Today, Global, now Projects) is unit-tested only at the extracted window-free-logic level (LESSONS §3), with UI wiring verified by review. R2's nav wiring + R3's page JSX are therefore review-verified, not render-tested. Adding a harness is an infra decision left to the owner (flagged, not decided).
- **Projects count nav badge (R4).** Skipped — it would sit inconsistently among the mockup badges (Approvals/Inbox are fake) and need workspace-scoped counts plumbed into the shell. The active-surface highlight (the real R4 value) already landed in R2.

## TDD compliance

- **R1 (route store)** — test-first (route.test.ts red → green), pure reducer. ✓
- **R3 (selection resolver)** — test-first (projects-select.test.ts red → green), pure window-free logic. ✓
- **R2 (AppShell extraction)** — a structural refactor + trivial nav glue. No failing-test-first is possible (the repo has no JSX-render harness; the codebase never component-tested the shell). Covered instead by the regression suite staying green (107→111) + typecheck + a dedicated security review CONFIRMING behavior preservation + a real electron-vite bundle. Consistent with the established codebase pattern. **No TDD violation for deterministic code** (the deterministic bits — route reducer, selection resolver — were both test-first).

## Reachability

- `AppShell` — reachable from `App.tsx` (the renderer root, mounted by `main.tsx`). Wraps every surface.
- `Today` — reachable from `App` via `route.surface === "today"` (the default route).
- `Projects` — reachable from `App` via `route.surface === "projects"`, reached by the left-rail **Projects** `NavLink` (`onNavigate`). Detail reached via `onSelectProject` → `route.projectId`.
- `navigate` / `route` / `resolveSelectedProject` — reachable via the above. No tested-but-unwired code.

## Open follow-ups

- **[owner decision pending] The §4.5 managed doc pack (00–04) + re-add/refresh** — build when the Drive/NotebookLM data path exists (needs a connector + a doc-pack read-model + a frozen UI-safe contract). Re-ask the deferment.
- **[owner decision] JSX-render test harness** (jsdom + @testing-library/react) — would give the routing/page UI + the whole Phase-9 surface layer regression coverage. Currently review-verified only.
- **[a11y follow-up] Projects list ARIA-APG keyboard model** — the `role="listbox"`/`option` list lacks `aria-activedescendant` + arrow-key roving focus (every option is `tabIndex={0}`). Matches the existing ScopeSwitcher pattern, so it's a codebase-wide a11y pass, not a regression.
- Inherited (unchanged): real recent_changes + project-sync PROJECTORS; D2 gated global surface; live push for recentChanges/projects; shared `workspaceScopedRead<T>` helper; the two-token same-scope hydrate/refresh race (session 017).

## How to use what was built

Run the app (`pnpm --filter @sow/desktop dev`) with `devProvision` on → the left rail navigates
**Today ↔ Projects**; the Projects page shows the real deterministic checkbox progress (server
percent, never UI-computed) as a list→detail; switching workspace scope re-scopes it (WS-8); Global
shows "Select a workspace". The route is independent of scope. New 9.6–9.14 surfaces mount by adding
a `Route` variant + a `NavLink` + a surface component under `renderer/surfaces/`.
