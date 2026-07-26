# Session 114 — Desktop ARC-1: Phase-9 completion (isolation specs · open-in-vault · Calendar · Top priorities)

- **Date:** 2026-07-26
- **Phase:** 9 (desktop completion) + §13.16 renderer leg
- **Track/role:** desktop-implementer (single-track `main`)
- **Predecessor:** [113-2026-07-26-worker-phase9-13-21-slices.md](113-2026-07-26-worker-phase9-13-21-slices.md) (chronological, worker track)
- **Successor:** _(none — TEAM PAUSE; next desktop leg = 9.10-C egress-settings, post-pause)_

## Why this session existed
Close the desktop leg of Phase 9 (owner-approved remaining-build plan, ARC 1) and complete the §13.16 renderer — landing five desktop slices toward `/phase-exit 9`, plus catching one duplicate-work brief before it was written.

## What was built (5 slices shipped + 1 duplication Finding)

### 9.14 renderer-isolation + redaction adversarial specs — `25029a76` (test-only)
- **New:** `test/security/renderer-isolation.spec.ts` (real `createMainWindow` webPreferences via a mocked `electron.BrowserWindow` — contextIsolation/nodeIntegration/sandbox/webSecurity/experimentalFeatures + nav-lockdown; bridge==inventory + no-Node-escape; real `registerIpcHandlers` set==inventory; CSP blocks inline/eval) · `test/security/renderer-redaction.spec.ts` (poisoned frame lands no secret in the store; the real `createEventStream.onData` drop path leaks nothing to store/console; non-vacuous clean-event anchor).
- Zero production change; security-reviewer STRONG.

### 9.12r renderer open/reveal-in-vault affordance — Option A — `b95aa3cf`
- **Broken-premise Finding first:** the renderer had NO configured-repo-path source (roots are main-only, §5/REQ-S-004); a strictly renderer-only affordance would be permanently disabled. Orchestrator approved **Option A (identifier-based)**.
- **Modified:** `main/open-in-vault.ts` (NEW `resolveRepoRoot` + `VaultRepoTarget` closed union; reworked `performVaultAction` — renderer sends a target, MAIN resolves the path → traversal impossible by construction; `guardVaultPath` UNCHANGED, called in reveal-mode for a directory root) · `preload/bridge.ts` (arg path→`VaultRepoTarget`) · `main/ipc.ts` · renderer `lib/open-in-vault.ts` (NEW glue) · `surfaces/projects/RepoActions.tsx` (NEW) · `Projects.tsx` · `App.tsx`.
- security-reviewer: §5 preserved + **structurally strengthened**.

### 9.12-A1 true Open-in-Obsidian via `obsidian://` — `0f20c3bb` (completes 9.12)
- Context7-verified wire shape: `obsidian://open?path=<url-encoded absolute path>`.
- **Modified:** `main/open-in-vault.ts` (OPEN branch → `obsidian://` via a new `shell.openExternal` seam; `encodeURIComponent` structural injection guard; graceful A2 `openPath` fallback on reject) · `main/ipc.ts` (openExternal seam) · `RepoActions.tsx` (label → "Open in Obsidian"/"Reveal in Finder").
- security-reviewer: §5 preserved (URI scheme is a hardcoded literal; only interpolant is the main-resolved root).

### 9.9b Calendar renderer surface — `f9d86536` (completes 9.9)
- **New:** `renderer/surfaces/calendar/index.tsx` (dumb busy/free render + honest "No calendar connected" empty-state) · `test-dom/calendar-page.test.tsx` · `test/renderer/schedule-reducer.test.ts`.
- **Modified:** `store/route.ts` (+"calendar") · `store/index.ts` (`schedule` slice) · `store/projections.ts` (`replaceSchedule`) · `lib/live.ts` (`hydrateCalendar` — GLOBAL cold-load only, re-validate `.strict` + drop) · `chrome/AppShell.tsx` (dead Calendar `<div>` → routable `NavLink`) · `App.tsx`.
- Prereq: `pnpm build:sow` (worker dist `query.calendar`). security-reviewer: WS-8/Flow-3 HOLDS.

### 13.16 "Top priorities" Today section — `985c1dda` (completes §13.16)
- **New:** `test-dom/today-priorities.test.tsx` · `test/renderer/task-rollup-reducer.test.ts`.
- **Modified:** `surfaces/today/Today.tsx` (`TopPriorities` section after Daily brief + `dueLabel` bidirectional helper + `tasks` prop; pre-ranked VERBATIM, REQ-F-017 absent-priority⇒no-badge) · `store/index.ts` (`taskRollup`) · `store/projections.ts` (`replaceTaskRollup`, scope-REPLACE) · `lib/live.ts` (`hydrateTaskRollup` — WORKSPACE-scoped mirror of `hydrateIngestionInbox`, `{items}` unwrap, per-row `.strict` drop, wired cold-load + scope-change + clear-first) · `App.tsx` · `test-dom/today-brief.test.tsx` (base +`tasks:[]`).
- Prereq: `pnpm build:sow` (worker dist `query.taskRollup`). security-reviewer: WS-8 HOLDS.

### 12.18-Electron (task #43) — CANCELLED (duplication Finding)
- Flagged at Step-2.5 that the brief would duplicate the shipped 9.14 `renderer-isolation.spec.ts` (already pins main webPreferences + bridge==inventory + no-Node-escape). Orchestrator accepted → task deleted; **12.18 → [x] satisfied-by-9.14**. No duplicate files written.

## Decisions made
- **9.12r Option A (identifier-based) over Option B (expose root path):** renderer stays path-blind (honors `vault-roots.ts` §5 posture); traversal impossible by construction. Reused `guardVaultPath` unchanged (reveal-mode for a directory root) rather than dropping its `isFile` gate.
- **9.12-A1 A2 fallback + Context7-verified `obsidian://`:** `path=` (not `vault=`) since main holds the path, not the vault name; folder-open fallback for not-installed accepted as a best-effort edge.
- **9.9b calendar = GLOBAL cold-load-only slice** (query.calendar is workspaceId-free); **13.16 taskRollup = WORKSPACE-scoped** (cold-load + scope-change + clear-first) — the deliberate global-vs-scoped store-slice distinction.

## Decisions explicitly NOT made (deferred)
- **9.12-A1 obsidian:// dir-path semantics** + macOS `openExternal`-resolves-for-unregistered-scheme (fallback best-effort) — verify at a live-Obsidian window (Residuals(9)).
- **projectRef → human title resolution** (13.16 renders the raw id) — follow-up; Today holds no project-name map.
- **`<time>` ISO formatting** (9.9b renders raw ISO) — display-formatting follow-up once the producer serves data.
- **Top-N visual cap / re-sort** — never re-order; a visual cap is a trivial follow-up if wanted.

## TDD compliance
- **9.14 · 9.12r · 9.12-A1:** test-first / test-rework-then-impl (the guard rework's RED tests preceded GREEN). Clean.
- **9.9b · 13.16:** deterministic logic (reducers `replaceSchedule`/`replaceTaskRollup`, hydrate `hydrateCalendar`/`hydrateTaskRollup`, `dueLabel`) covered by unit tests; the dumb-render UI covered by parallel jsdom render tests (the project's UI-coverage path, desktop L4). Tests + impl landed together in the single slice commit — no strict red-first for the pure-render UI, which is the house pattern for dumb-render surfaces. No safety-critical TDD skips.
- **No TDD violations flagged.**

## Cross-doc invariant audit
- **No frozen-model field changes this session.** Every slice CONSUMED frozen Appendix-A contracts as-is (`UiSafeSchedule`, `UiSafeTaskRollup`, `UiSafeScheduleEntry`, `UiSafeTaskRollupItem`); `VaultRepoTarget` is a local `main`/`preload` type, not an Appendix-A seam model. No `ARCHITECTURE.md` edit owed from this track. Clean.

## Reachability (Step-7.5, carried)
- **9.14 specs:** the security test suites are the entry point (assert existing production surfaces). Reachable.
- **9.12r/A1:** Projects repo-header `RepoActions` → `requestVaultOpen/Reveal` → `window.sow.vault.open/reveal` → ipc `vault:open/reveal` → `performVaultAction`. Reachable on a real click.
- **9.9b Calendar:** AppShell Calendar `NavLink` → `onNavigate({surface:"calendar"})` → `App` route arm → `<Calendar entries={state.schedule}/>`; `state.schedule` from `hydrateCalendar` in cold-load `hydrate`. Reachable (honest-empty until the producer's adapter binds — expected).
- **13.16 Top priorities:** the Today surface (home) renders the section; `state.taskRollup` from `hydrateTaskRollup` in cold-load + scope-change. Reachable (empty-until-data).
- No tested-but-unwired gaps introduced.

## Open follow-ups (Step-9 categorized — already routed hot to the orchestrator)
- **Doc ticks (orchestrator writes at /orchestrate-end):** 9.12 → [x] (A1); 9.9 → [x] (9.9a+9.9b); §13.16 → done; 12.18 → [x] satisfied-by-9.14; §11 arch notes (Calendar surface live; Today "Top priorities" over a deterministically-ranked WS-8 read-model).
- **LESSON candidates (desktop territory — orchestrator banks):**
  - Option-A closed-target open/reveal — renderer path-blind, main resolves target→root, traversal impossible by construction; reuse the containment guard in reveal-mode for a directory root; the true Open-in-Obsidian opens `obsidian://` (Context7-verified, encodeURIComponent injection guard, graceful fallback).
  - renderer security specs assert bridge==inventory + main-handler-set==inventory + real webPreferences (mocked ctor) + no-Node-escape + UI-safe-only store via the real `validateStreamEvent→onData` drop path — deterministic renderer-global altitude.
  - GLOBAL (workspaceId-free) read-model → cold-load-only hydrate; WORKSPACE-scoped read-model → scoped-hydrate path (cold-load + scope-change + clear-first + stale-scope guard); the `{items}`/`{entries}` object-unwrap gotcha.
- **Carry-forward residuals:** projectRef→title resolution (13.16); `<time>`/ISO display formatting (9.9b); obsidian:// dir-path + not-installed fallback verify at a live window (9.12-A1); top-level `.max(200)` flood-cap (defense-in-depth; producer caps).
- **Next desktop leg (post-pause):** **9.10-C egress-settings surface** — consuming worker #53's revoke (`225c10ca`); dep-gated on worker 9.10-B.

## Preflight
- Desktop tsc clean (all 3 tiers) + full desktop suite **432 pass** at each slice's Step-10 (latest HEAD `985c1dda`). ⚠ Note: the desktop typecheck requires a FRESH `@sow/worker`+`@sow/contracts` dist (`pnpm build:sow`) for `query.calendar`/`query.taskRollup` (gitignored artifacts) — a fresh orchestrator preflight must rebuild first. Repo-wide `turbo typecheck` is subject to shared-tree races with in-flight worker/eval tracks (transient) — sequence after those land.
