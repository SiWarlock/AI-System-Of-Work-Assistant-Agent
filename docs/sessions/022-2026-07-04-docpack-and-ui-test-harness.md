# Session 022 — §4.5 managed doc pack (00–04) + a JSX-render UI test harness

- **Date:** 2026-07-04 · **Mode:** single-operator (build) · **Tracks:** contract · worker · desktop
- **Predecessor:** `021-2026-07-04-dedicated-projects-page.md` (HEAD at start `7ce7be7`)
- **Successor:** _(none yet)_
- **HEAD at close:** `d1667c8` · **4 slice commits** (`241e048` DP-1 · `a729520` DP-2 · `ce62c38` DP-3 · `d1667c8` harness)
- **Gate at close:** repo-wide `turbo typecheck test` **31/31**; desktop suite **127** (node tier + 13 jsdom render tests); contracts 51/51; renderer bundles; tree clean (+ untracked files from a parallel session — `youtube-source.*`, `capture-source.*`, `PHASE-13-PROPOSAL-…` — left untouched).
- **Reviews:** 5 subagent reviews across 4 slices — DP-1 security (leakage gate HOLDS, 0 crit/high/med) + code-quality (1 med fixed); DP-2 security (serving gate holds, 0 findings) + code-quality (1 low fixed); DP-3 security (0 findings) + code-quality (3 low deferred); d code-quality (1 med + 3 low, med + 2 low addressed in-slice). No critical/high anywhere.

## Why this session existed

Owner directive: *"build the doc pack now and then move on to b-d"* (b = 9.6 Copilot, c = real
projectors, d = UI test harness). This session discharges the **§4.5 managed doc-pack deferment**
(surfaced to the owner in session 021) and builds the **UI test harness** (the gap two prior
reviews flagged). **b (Copilot Q&A) and c (real projectors) are NOT in this session** — they are
backend-heavy subsystems (retrieval + LLM synthesis + citations; audit-record projectors) scoped
as focused follow-ups (see Open follow-ups) rather than rushed.

## What was built

### §4.5 managed doc pack — DONE (3 slices)

| Commit | Slice | Summary |
|---|---|---|
| `241e048` | DP-1 contract | `UiSafeManagedDoc {slot, title, linkState, syncState}` + `docPack: readonly UiSafeManagedDoc[]` (`.max(5)`) on `UiSafeProjectDashboard`. Link/sync STATE + slot enum only — DROPS the Drive doc/folder ids + URL/path (leakage gate; the NotebookMapping.managedDocIds source stays worker-side). Frozen: `.strict()` + Exact<> parity + sorted allowlist + freeze tests. Slot uniqueness deferred to DP-2 (an object `.refine` would collapse `.shape`). Downstream constructors got `docPack: []`. |
| `a729520` | DP-2 worker | The dev-provisioner writes the real 5-slot pack (from the new shared `MANAGED_DOC_SLOTS` constant), all `unlinked`/`unknown` — the honest pre-connector state. `sanitizeProjectDashboards` enforces slot UNIQUENESS worker-side (fail-closed → PROJECT_DASHBOARD_SANITIZATION_REJECTED), the REQ-F-011-style posture the pure contract couldn't. |
| `ce62c38` | DP-3 desktop | The "Managed docs" section in the Projects detail pane. `resolveDocPack` (window-free, LESSONS §3) overlays the read-model onto the 5 canonical slots in canonical order (robust to a partial pack). The re-add/refresh affordance is DISABLED with an explanatory tooltip + hint — honest, because no Drive connector exists to link/sync yet. No Drive id/url exposed or constructed. |

### JSX-render UI test harness — DONE (1 slice)

| Commit | Slice | Summary |
|---|---|---|
| `d1667c8` | d | A second test tier (jsdom + @testing-library/react) alongside the DOM-less node tier (LESSONS §3 preserved — no cross-contamination). `test-dom/` runs under jsdom per-file; `tsconfig.testdom.json` gives it DOM lib + jsx (`include: ["test-dom"]` so App.tsx's `import.meta.env` isn't dragged in). 13 render tests: the R2 left-rail routing, the §9.4 scope-switcher moved-verbatim dismissal (open→select→onScopeChange+close, Escape, outside-mousedown — PROVING the R2 extraction preserved the security-reviewed behavior), and the Projects page (WS-8 two empty states, list→detail, REQ-F-011 bar, doc pack). |

### Files
- **Created:** `packages/contracts/src/api/ui-safe.ts` additions (UiSafeManagedDoc + MANAGED_DOC_SLOTS); `apps/desktop/renderer/surfaces/projects/docpack.ts`; `apps/desktop/tsconfig.testdom.json`; `apps/desktop/test-dom/{app-shell,projects-page}.test.tsx`; new tests in `packages/contracts/test/api/ui-safe.test.ts`, `apps/worker/test/api/procedures/queries.test.ts`, `apps/worker/test/provision-dev.test.ts`, `apps/desktop/test/renderer/projects-docpack.test.ts`.
- **Modified:** `apps/worker/src/api/procedures/queries.ts` (slot-uniqueness); `apps/worker/src/composition/provisionDev.ts` (5-slot pack); `apps/desktop/renderer/surfaces/projects/Projects.tsx` (ManagedDocPack); `apps/desktop/renderer/styles.css` (.sow-docpack-*); `apps/desktop/{vitest.config.ts,package.json}` (harness); constructor updates for the now-required `docPack`.

## Decisions made

- **Doc pack rides `UiSafeProjectDashboard.docPack`** (not a separate query) — the detail already holds the dashboard; no extra round-trip. Required field (empty pack is valid), consistent with the sibling required arrays.
- **`MANAGED_DOC_SLOTS`** is the single shared source of truth for slots+titles (contract), used by the worker writer + the UI overlay — no duplication/drift.
- **UI overlays onto the 5 canonical slots** (always shows the full pack) rather than rendering the read-model array directly — robust to a partial/empty read-model.
- **The re-add affordance is disabled, not hidden** — honest §4.5 scaffold; the button lights up when a Drive connector + doc-pack projector land.
- **Two-tier test harness** (node DOM-less + jsdom render) rather than converting everything — preserves LESSONS §3 while adding render coverage.

## Decisions explicitly NOT made (deferred)

- **b — 9.6 Copilot Q&A surface.** The existing `query.copilot` returns recent workflow runs; the §4.6 CORE (ask → retrieval → cited answer, routes to Approvals) needs a GBrain-retrieval + governed-LLM-synthesis + citation backend that doesn't exist. That's a major (LLM-driven, eval-tested) subsystem, not a UI slice — deferred to a focused session.
- **c — real recent_changes + project-sync projectors.** The dev-provisioner is the interim project writer; recent_changes has no writer. Building real projectors (audit records / project state → read-models) is a substantial worker/knowledge feature — deferred.
- **The doc-pack live path** (a real Drive-backed doc-pack projector + the re-add/refresh worker action) — lands with a Drive connector.

## TDD compliance

- **DP-1** contract (managed-doc + docPack validation) — test-first. ✓
- **DP-2** worker (dup-slot rejection + full-5-slot + provisioner writes 5 unlinked slots incl. titles) — test-first. ✓
- **DP-3** desktop `resolveDocPack` (empty/partial/out-of-order overlay) — test-first (window-free). ✓
- **d** harness — the render tests ARE the deliverable (infra); they exercise real component behavior. The two window-free resolvers (select, docpack) were already test-first in their slices. No TDD violation.

## Reachability

- Doc pack: `query.projectList` → `store.projects` → `Projects` detail → `ManagedDocPack` (reachable; the dedicated Projects page mounts via the `projects` route).
- `resolveDocPack` / `resolveSelectedProject` — reachable from `Projects`. `MANAGED_DOC_SLOTS` — worker writer + UI overlay.
- The render tests exercise `AppShell` + `Projects` via their real props. No tested-but-unwired code.

## Open follow-ups

- **[owner — b] 9.6 Copilot Q&A** — needs a retrieval + governed-LLM-synthesis + citation backend (eval-tested). A focused session.
- **[owner — c] Real recent_changes + project-sync projectors** — audit records / project state → read-models, replacing the dev-provisioner interim.
- **The §4.5 doc-pack live path** — a real Drive-backed projector + the re-add/refresh worker action (blocked on a Drive connector).
- **Harness expansion** — more render coverage (Today surface, GlobalGroups drill-down, the connection/health pills); consolidate the `proj()` inline fixture with `test/renderer/fixtures.ts`.
- Inherited: D2 gated global surface; live push for recent/projects; shared `workspaceScopedRead<T>`; the two-token same-scope hydrate/refresh race; the Projects list ARIA-APG keyboard model.

## How to use what was built

Run the app with `devProvision` → a workspace scope's Projects page detail shows the 5-slot managed
doc pack (all unlinked, re-add disabled until a Drive connector). Component render tests:
`pnpm --filter @sow/desktop test` runs both tiers; add a render test as `test-dom/<x>.test.tsx` with
a `// @vitest-environment jsdom` docblock.
