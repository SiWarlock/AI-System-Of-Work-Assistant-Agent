# Phase 9 desktop — reachability audit (NOT a phase-exit gate run)

**AUDIT ONLY — NOT a `/phase-exit 9` gate run. No CLEAR/BLOCKED verdict is emitted.**

**Verified at:** HEAD `86477bbf`, branch `main`, tree CLEAN (`git status --short` empty) at the time of every observation below. No mutation performed during this audit.

## Why no verdict

Phase 9 is structurally un-exitable for a reason unrelated to code health: task 9.5's `§4.5` managed doc-pack leg cannot tick because it depends on a Google Drive connector that does not exist yet, and the owner ruled (2026-07-26) that nothing is deferred out of Phase 9's scope to manufacture an early exit. A BLOCKED verdict from this audit would therefore be *predetermined by that unrelated dependency*, not derived from the reachability analysis actually performed here — and once quoted, a verdict line loses its qualifier and reads as an independent analysis result. This document reports findings only; it does not compute or imply a gate outcome.

## Review-surface honesty — what was actually walked

Phase 9 is a later phase on the desktop track with no clean phase-only diff, so per policy this surface **over-approximates to the accumulated track diff**: I walked essentially all of `apps/desktop/` (135 files) rather than a phase-9-only slice. Concretely:

- **`apps/desktop/main/`** — all 14 source files, every `export`ed symbol enumerated and traced.
- **`apps/desktop/preload/`** — `bridge.ts`, `index.ts`, `api.d.ts` — full channel-inventory cross-check against `main/ipc.ts`.
- **`apps/desktop/worker-host/`** — `index.ts`, `temporal-supervisor.ts` (17 exports), `arming-forward.ts` (2 exports), `register-loader.mjs`, `resolve-loader.mjs` — full export sweep.
- **`apps/desktop/renderer/`** — `App.tsx`, `main.tsx`, `chrome/{AppShell,ErrorBoundary}.tsx`, all 14 `surfaces/*` files, all 21 `lib/*` files, all 7 `store/*` files, `dev/seed.ts` — traced at the file/import level (every file confirmed to have ≥1 non-test production importer, or to be the terminal entry point itself).
- **Build wiring** — `electron.vite.config.ts`, `worker-host.build.mjs`, `package.json` scripts, `index.html` — confirmed the full main/preload/renderer/worker-host build graph is one connected component.
- **Plan cross-reference** — `IMPLEMENTATION_PLAN.md` §9.10/9.22/9.25/9.32 and `docs/sessions/129`, `131` — to classify dormant-by-design states correctly rather than rediscovering them.

### What was NOT covered (explicit)

- **Not an exhaustive per-symbol audit of the largest files.** `renderer/store/projections.ts` (35 symbols) and `renderer/lib/live.ts` (29 symbols) were confirmed reachable **at the file level** (imported by App.tsx / other reachable files) but individual internal helper exports within them were not each traced separately — a file-level trace, not a 35-way symbol-level one.
- **Did not run `pnpm test` / `pnpm build`.** This is a static import/call trace, not a runtime verification. The known transient (`main-bundle-resolution.test.ts` failing only under a repo-wide concurrent run) was not re-verified here — it's recorded as a known non-finding per the task brief.
- **Did not audit `apps/desktop/test/`, `test-dom/*.test.tsx`, or `worker-host/register-loader.mjs`/`resolve-loader.mjs` internals** beyond confirming their wiring (used only to confirm negatives — e.g., that no production caller passes Copilot's `turns` prop).
- **Did not audit the worker-side producers** behind Calendar (9.9) or Ingestion Inbox (9.7-B) dormancy, or `providerMatrix`'s empty-writer state (9.32) — those are `apps/worker` territory, out of this area's scope. They're referenced below only as context for why certain desktop surfaces render honest-empty.
- **Did not re-verify `apps/desktop/out/`** (build output, e.g. `out/renderer/assets/index-*.css`) as a live artifact — it's a build product, not source; noted once below only because it happened to surface in a grep.

## Findings

### 1. Main → preload → renderer → worker-host: fully connected, no orphans

Traced the complete chain: `electron.vite.config.ts` entries (`main/index.ts`, `preload/index.ts`, `index.html`→`renderer/main.tsx`) exactly match what's built; `main/index.ts` imports all 12 of its sibling main modules directly, and the remaining 2 (`first-run.ts`, `open-in-vault.ts`) are imported by `main/ipc.ts` (itself imported by `main/index.ts`). `preload/bridge.ts`'s `PRELOAD_CHANNELS` (7 channels) has an exact 1:1 match against `main/ipc.ts`'s 7 `ipcMain.handle` registrations — no channel exposed without a handler, no handler for an unexposed channel.

`main/index.ts:139-147` forks `out/worker/desktop-host.mjs`, which `apps/desktop/worker-host.build.mjs` builds from `worker-host/index.ts` (confirmed via `package.json:8-10` — `build:worker` runs in both the `dev` and `build` scripts, so this isn't a dead build step). `worker-host/index.ts` imports both `temporal-supervisor.ts` and `arming-forward.ts`; all 19 of their combined exports are either imported externally (6 + 2) or used internally by an already-reachable exported function (verified by grep — every "internal-only" export has ≥2 in-file occurrences, i.e., declared *and* called/referenced, not merely declared).

**Main-module exported-symbol sweep (48 symbols across 14 files):** every symbol is reachable — either imported by another production file, or used within its own defining file by a function that *is* imported elsewhere (e.g. `restartBackoffMs` is called only inside `createWorkerSupervisor`, but that function is imported by `main/index.ts`). No genuinely dead exports found in `main/`.

### 2. Renderer routing: all 9 nav-routed surfaces + Copilot + Onboarding + both ErrorBoundary layers wired

`renderer/store/route.ts`'s `Route` union has exactly 9 surfaces; `App.tsx:312-379`'s route switch renders all 9 (`approvals`, `ingestion`, `projects`, `calendar`, `connectors`, `system-health`, `workspace-settings`, `cross-workspace-links`, and the `today` default), and `chrome/AppShell.tsx:371-460` has a matching `NavLink` for each. `Copilot` mounts unconditionally in `AppShell.tsx:492-493` (the collapsed-rail/expanded-panel toggle, not route-gated — by design, §4.6). `Onboarding` mounts via `App.tsx:214-244`'s first-run gate. `main.tsx:11-16` wraps `<App/>` in a root `ErrorBoundary` (9.35 backstop for the Onboarding branch + `App()` itself); `AppShell.tsx:487-489` wraps `{children}` in a second, route-keyed `ErrorBoundary` (the per-surface recoverable layer) — both landed, confirmed live, not redundant (each covers a gap the other cannot reach, per the in-code comment at `AppShell.tsx:481-486`).

All 21 `renderer/lib/*` files and all 7 `renderer/store/*` files were confirmed to have at least one non-test production importer (traced via targeted grep per file, cross-checked against each importer's own reachability). The three `renderer/surfaces/projects/` helper files (`docpack.ts`, `select.ts`, `RepoActions.tsx`) are all imported by `Projects.tsx`, which is routed. `renderer/dev/seed.ts` is imported by `App.tsx:42` as the deliberate dev-only fallback when `startLive` returns no real worker handle (`App.tsx:85`, gated on `import.meta.env.DEV`) — reachable and intentional, not a gap.

### 2a. Correction to the task brief's own citation

The task brief cited `apps/desktop/renderer/styles.css:1960` for `.sow-pill--zero-egress`. At current HEAD it is at **`styles.css:1942`** (part of a shared declaration block with `.sow-pill--egress-false`, `styles.css:1941-1945`); line 1960 now falls inside an unrelated `.sow-inline-error` rule. The selector itself is confirmed still present — only the line number has rotted, consistent with this repo's recent doc-citation-drift pattern (see the latest commit, `7ed6d83e`, which fixes a different rotted citation). Not a code finding, just a correction for whoever reads this doc next.

### 3. Genuinely unreachable / orphaned (real finding)

- **`apps/desktop/renderer/styles.css:1942` `.sow-pill--zero-egress`** — CONFIRMED zero live references (grep across all of `apps/desktop/renderer` for the class name found only its own CSS declaration; the one test-file mention, `test/renderer/chrome-egress-claim.test.ts:34`, is a comment about dash-count, not a usage). This selector was deliberately pre-staged (`docs/briefs/205-remove-hardcoded-local-only-chrome-claim.md:16`) for the follow-up that would render the derived `zeroEgressOnly` posture — **9.10-C bullet 1 / task #8**. ⚠ **That follow-up has since shipped** (`docs/sessions/129-2026-07-29-...md`, commit `cda4d2f4`), but it renders its pill with a **different** class: `sow-pill--egress-scoped` (`apps/desktop/renderer/surfaces/workspace-settings/egress.tsx:238`), not `sow-pill--zero-egress`. So this is no longer "waiting for its follow-up" — **the follow-up already landed and used a different shape**, which by the pre-staging brief's own stated condition ("if the follow-up takes a different shape, delete it rather than leaving it orphaned") means it should now be deleted. Two independent session docs (129, 131) already flagged it as dead CSS and deferred cleanup; this audit confirms the deferred cleanup's precondition (the follow-up landing) has now actually occurred, so the "wait and see" period is over.
  - **Recommended action:** a one-line CSS deletion (remove `.sow-pill--zero-egress,` from the shared selector at `styles.css:1942`), not a wiring task — no production code references it, so nothing to wire.

No other genuinely-dead exported symbol was found across `main/`, `preload/`, `worker-host/`, or the renderer file-level trace.

### 4. Dormant-by-design (not defects — cited, not reported as gaps)

- **`Copilot.tsx:110-112,288` — the `turns`/`seedTurns: CopilotTurnSeed[]` prop.** Confirmed zero production callers: neither `App.tsx` nor `AppShell.tsx` passes `turns=`/`seedTurns=` to `<Copilot>` (`AppShell.tsx:493`: `<Copilot workspaceScoped={...} onCollapse={...} onAsk={...} />` — no seed prop). This is explicitly documented as INIT-ONLY, "tests; a future restore" (`Copilot.tsx:79-83`), and is the exact subject of **task 9.25** (`IMPLEMENTATION_PLAN.md:1199-1203`, OPEN): *"not a feature; a precondition that ACTIVATES when Copilot history/restore is built."* Session 129's Reachability section independently confirmed the same negative via grep. Not a gap — a documented, gated dormancy with no owning consumer yet, and a task tracking exactly when it should activate.
- **`egress.tsx`'s `true`-state `zeroEgressOnly` pill (task #8, `cda4d2f4`).** The pill renders correctly for both states, but the `true` branch is currently unreachable in production because nothing yet writes a non-empty `providerMatrix` (**task 9.32**, `IMPLEMENTATION_PLAN.md:1178`, owner-ratified deferred arc — confirmed independently by two implementers per the plan's citations). This is worker-side dormancy surfacing at a desktop UI branch; the desktop code itself is fully reachable and correctly renders the plainly-unreachable state without de-emphasis (a deliberate choice, `docs/sessions/129...md` "Decisions explicitly NOT made").
- **Calendar (`surfaces/calendar/index.tsx`) and Ingestion Inbox empty states.** Both surfaces are fully wired and routed (confirmed in §2 above); they render honest-empty states because their upstream worker producers are partially dormant (9.9's producer is empty-until-wired by design; 9.7-B's "always-on Temporal wiring" remains the plan's stated remaining leg, `IMPLEMENTATION_PLAN.md:1129-1133`). This is worker territory, not a desktop reachability defect — flagged here only so it isn't mistaken for one.

## Summary counts

- **Files walked:** ~50 non-test source files directly (main/ 14, preload/ 3, worker-host/ 5, renderer 14 surfaces + 21 lib + 7 store + App/AppShell/ErrorBoundary/main.tsx/dev-seed ≈ 28), plus build-config cross-checks (4 files) and plan/session-doc cross-references (IMPLEMENTATION_PLAN.md §9.5/9.7/9.9/9.10/9.22/9.25/9.32, sessions 129/131). Full file list of the 135-file `apps/desktop/` tree was enumerated via `codegraph_files`; the ~85 remaining files are test/test-dom/config files excluded per the audit's own rules (test-only references don't count as reachability).
- **Exported symbols individually enumerated + traced:** 48 in `main/`, 8 in `preload/`, 19 in `worker-host/` = 75 symbols with an explicit reachable/internal-use classification. Renderer symbols were traced at file-import granularity, not exhaustively per-symbol (see "not covered" above).
- **REACHABLE:** all 75 explicitly-traced main/preload/worker-host symbols; all 43 renderer files traced (9 routed surfaces + Copilot + Onboarding + 2 ErrorBoundary layers + 21 lib + 7 store + 3 projects-helpers + dev/seed).
- **Dormant-by-design (cited, not a gap):** 3 — Copilot `seedTurns`/`CopilotTurnSeed` (task 9.25, OPEN), egress `true`-state pill (task 9.32, owner-ratified), Calendar/Ingestion-Inbox empty states (worker-side producer dormancy, tasks 9.7-B/9.9).
- **Genuinely unreachable (real finding):** 1 — `styles.css:1942` `.sow-pill--zero-egress`, now confirmed stranded (its intended consumer shipped using a different selector) — a one-line CSS deletion, not a wiring task.
