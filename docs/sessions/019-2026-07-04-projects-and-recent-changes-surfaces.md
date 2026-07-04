# Session 019 — §9.5 surfaces: Recent Changes (③) + Project dashboard (②), both end-to-end

- **Date:** 2026-07-04 · **Mode:** single-operator (build) · **Tracks:** contract · worker · desktop · eval-security
- **Predecessor:** `018-2026-07-04-data-unlock-d1-and-surfaces-design.md` (HEAD `3af4f0a`)
- **Successor:** `020-2026-07-04-RESUME-dedicated-projects-page.md` (the fix-the-scope-cut handoff)
- **HEAD at close:** `e2aea09` · **8 commits this doc covers** (`4246f66`…`e2aea09`)
- **Gate at close:** repo-wide `turbo typecheck test` **31/31 green** (contracts 611 · worker 355/19-skip · desktop 101 · db 331 · evals green; api-live + boot-provision green under SOW_API=1) · tree clean (+ 3 stray untracked files NOT mine — a `youtube-source.ts` + a PHASE-13 proposal from another session; left untouched)
- **Reviews:** 8 subagent pairs (security + code-quality per slice) — every slice **0 critical/high**; all findings fixed in-slice or documented-deferred.

## Owner directive

*"go do them all"* (Project dashboard, Recent Changes, data-unlock) *"…push everything when you're done with 2 and 3."* Both surface targets built end-to-end this session on top of the data-unlock (D1) + push-path work from sessions 017–018. Sequence taken: **③ Recent Changes → ② Project dashboard** (③ first as the lower-risk new-contract pattern; then the bigger ② with its data path).

## ③ Recent Changes — DONE (3 slices)

| Commit | Slice | Summary |
|---|---|---|
| `4246f66` | S1 contract | `UiSafeRecentChange {changeId, kind, summary, occurredAt}` — drops `actor`/`payloadHash`/`refs`, no `workspaceId`; actor+event folded into ONE projector-built single-line `summary`. Hardened the shared `uiSafeSummaryLine` to reject the full Unicode newline family (it's the SOLE bound here). |
| `6beee0e` | S2 worker | `query.recentChanges({workspaceId})` — workspace-scoped fail-closed, re-validates each row, fails closed on a poisoned (multi-line) summary, sorts DESC by the parsed **instant** (not lexicographic — variable ISO precision), caps 50. |
| `4b89e6e` | S3 desktop | Wired Today's static "Recent activity" list to the scoped read-model (store slice + `replaceRecentChanges` + hydrateScope clear+query; Global shows nothing — WS-8). Empty until a real recent_changes projector reads audit records (deferred, no synthetic seed). |

## ② Project dashboard — DONE (4 slices) — deterministic progress, REAL data

| Commit | Slice | Summary |
|---|---|---|
| `5ca5a89` | S1 contract | `UiSafeProjectDashboard` + nested `UiSafeProjectProgress` — deterministic progress (REQ-F-011); drops `workspaceId` + `progressSources`; `evidenceRefs` use an opaque-id grammar (no path/URL); prose arrays single-line + length-capped (chunking defense). The cross-field REQ-F-011 checks live worker-side (an object `.refine` would collapse `.shape`, which the freeze test reads). |
| `dca7089` | S2 worker | `query.projectList({workspaceId})` — workspace-scoped fail-closed; `sanitizeProjectDashboards` re-validates each row AND enforces REQ-F-011 via the **same** `computePercent` the writer uses (percent === count-derived, completed ≤ total, total 0 ⇒ 0%). New `project_dashboards` read-model key. |
| `009bc31` | S3 writer | The dev-provisioner now writes a REAL `UiSafeProjectDashboard` from the checkbox tally (progress consistent by construction; empty prose — no dev model synthesis). So a workspace scope shows genuine deterministic progress. |
| `271ff00` | S4/S5 desktop | A `ProjectsSection` on Today renders each project's progress BAR (width = the **server** `percentComplete` — REQ-F-011: the UI displays, never computes), counts, blockers/waiting/next/evidence. Workspace-scoped (Global empty; WS-8). hydrateScope's workspace branch is now `Promise.allSettled` so one query's failure doesn't drop the others. |

Plus `e2aea09` — **fix(evals):** the two `@sow/evals` fake `ReadModelQueryPort`s went stale when S2 added `recentChanges`/`projectDashboards` to the port; the **per-package worker gate doesn't see cross-package consumers** — the repo-wide `turbo typecheck` at close-out caught it. (Lesson: a port-interface change needs the repo-wide gate, not just the owning package's.)

## What lights up now

With `devProvision` on + a vault note: select a **workspace scope** → Today shows a real project card with the deterministic checkbox percent as a progress bar + a real dashboard card. **Global** Today's cards/GCL/projects/recent-activity stay empty (workspace-scoped surfaces never blend cross-workspace; WS-8). Recent activity stays empty until a real audit-record projector runs (deferred).

## ⚠️ CORRECTION — ② is NOT complete: the dedicated Projects PAGE is REQUIRED (owner ruling)

**A scope-cut mistake was made this session and is corrected here.** ② Project dashboard was
delivered as a Projects **section on Today** with the renderer routing/AppShell foundation
DEFERRED. That deferral was decided unilaterally — the wrong call: the **locked design (§4.5)
specifies a dedicated Projects PAGE**, and a scope cut is an owner decision, never the
implementer's. **Owner ruling (2026-07-04): the dedicated Projects page IS required; ② is NOT
done.** The DATA path (contract · `query.projectList` · dev-provisioner writer · REQ-F-011
enforcement) is complete and correct — but the SURFACE must become a dedicated page. This is the
**#1 next task** (see the §9.5-routing handoff doc + resume prompt). It also unblocks the
9.6–9.14 dedicated pages.

## Deferred (documented, NOT silently dropped)

- **The dedicated Projects PAGE + the renderer routing/AppShell foundation** — see the CORRECTION above. This is REQUIRED work (locked design §4.5), the top next task, NOT a valid deferral. The Today `ProjectsSection` is an interim data-display that will move into the dedicated page.
- **The real recent_changes + project-dashboard PROJECTORS** (read audit records / run project-sync → write the read-models with model-synthesized prose). The dev-provisioner is the interim real-data writer for projects; recent_changes has no writer yet. Downstream obligations recorded in the contracts (redact-by-type prose, non-enumerable evidence refs, drill scope-ownership re-check).
- **Live push updates** for recentChanges + projects (they hydrate on scope switch, not on read_model.change — same-workspace staleness, self-heals, no blend).
- **Shared `workspaceScopedRead<T>` read-model helper** — the resolve→get→read block is now ~5 copies; flagged repeatedly, extraction due at the next touch.
- **The two-token same-scope hydrate/refresh race** (from session 017) — still open.

## Load-bearing invariants (unchanged)

- New UI-safe shapes are frozen via allowlist + `.strict()` + `Exact<>` parity + freeze tests; they're NOT Appendix-A seam models, so no schema-snapshot / ARCHITECTURE coordination. The cross-field REQ-F-011 lives worker-side (contracts can't import `computePercent`; an object `.refine` breaks the freeze).
- `@sow` builds structure-preserving behind `sow-built`; **`build:sow` verified clean this session** (9 pkgs) — the live desktop child picks up the new contracts/worker code. Renderer-only slices are Vite-bundled (no rebuild).
- Every scoped read is fail-closed on an unknown workspace (WS-8); Global surfaces never blend; the renderer gets only UI-safe projections; commits LOCAL until push.

## Build/run + test reference

- Turn projects/recent-activity on: run the worker with `devProvision` specs (BootConfig) pointing at vault notes → a workspace scope shows real deterministic-progress cards.
- Per-package: `pnpm --filter @sow/<pkg> typecheck && test`. **Run the repo-wide `turbo typecheck` after any port-interface change** (cross-package consumers). Worker boot/socket tests are `SOW_API=1`-gated.
