# 131 — desktop: render-time ErrorBoundary (9.35) + partial-scaffold repair state (9.21-B, closes 9.21)

**Date:** 2026-07-29
**Track / role:** main · desktop-implementer
**Predecessor session:** `docs/sessions/129-2026-07-29-desktop-copilot-reply-brand-and-egress-posture-render.md`
**Successor session:** `docs/sessions/135-2026-07-29-dead-css-cleanup-and-copilot-rehydrate-precondition.md` (9.37a + 9.25)

---

## Why this session existed

Fresh session after a full teardown (handoff 018). The owner picked task **#35** (no ErrorBoundary anywhere in `apps/desktop`) as the opener — an independent, no-dependency finding. Task **9.21-B** (the desktop consumer leg of the partial-scaffold repair state) followed once worker's leg A (`c09ccd9b`) landed, closing 9.21 — at dispatch time believed to be the sole remaining `/phase-exit 9` blocker (corrected mid-session: it wasn't, see "Decisions explicitly NOT made").

## What was built

### Slice 1 — Commit `3f33c97b` (6 files, +348/−3)

Task #35 / 9.35: added the renderer's first-ever `ErrorBoundary`. Until now, `main.tsx` mounted `<StrictMode><App/></StrictMode>` bare, so any render-time throw unmounted the entire root — the exact gap `surfaces/copilot/Copilot.tsx`'s `admitReply` comment cited as its own justification. Shipped **both** candidate sites (neither alone closes the finding): Site A (`main.tsx`, wraps `<App/>` — catches the `App.tsx:214` Onboarding early-return + anything thrown in `App()` before its return) and Site B (`chrome/AppShell.tsx:480`, wraps `{children}` — chrome/nav/Copilot rail survive a surface throw, keyed on `JSON.stringify(route)` for auto-reset on navigation).

**Files:** new `apps/desktop/renderer/chrome/ErrorBoundary.tsx` (the `ErrorBoundary` class + shared `ErrorFallback`), new `apps/desktop/test-dom/error-boundary.test.tsx` (9 tests); modified `renderer/main.tsx`, `renderer/chrome/AppShell.tsx`, `renderer/styles.css`; modified `tsconfig.testdom.json` (added `preload/api.d.ts` to `include` — a real test's own`App` import exposed a pre-existing tier-config gap, not new scope).

### Slice 2 — Commit `f4cc1b0f` (8 files, +293/−11)

Task 9.21-B: `renderer/lib/onboard-workspace.ts` deliberately folded every onboarding failure — typed err, transport error, malformed ok — to a bare `{ok:false}`, so worker's new typed `ONBOARDING_PARTIAL_SCAFFOLD` outcome (9.21-A) arrived and was discarded before any surface saw it, leaving an actively-wrong generic message ("Couldn't create the workspace. Check the vault path…") on a state where the config row *was* durably written. Widened the fold by exactly one case (`OnboardResult` gains `reason?: "partial_scaffold"`, a closed literal with no message/detail field — rule 7 enforced by the type). `surfaces/onboarding/index.tsx` branches on it: a partial renders true copy (no "couldn't create," no "vault path") with resume = re-submitting the same form; every other failure is byte-unchanged. Also bundled two comment-only amendments: `Copilot.tsx:137`'s stale "no ErrorBoundary" premise corrected (conclusion about `admitReply`'s rationale kept), and `ErrorBoundary.tsx`'s "not a persisted log sink" comment now cites `test/security/preload-inventory.snapshot.test.ts:26` by name.

**Files:** modified `renderer/lib/onboard-workspace.ts`, `renderer/surfaces/onboarding/index.tsx`, `renderer/styles.css`, `renderer/surfaces/copilot/Copilot.tsx`, `renderer/chrome/ErrorBoundary.tsx`; new `test-dom/app-partial-scaffold-markonboarded.test.tsx`; extended `test/renderer/onboard-workspace.test.ts` + `test-dom/onboarding-page.test.tsx`.

## Decisions made

- **9.35 — both sites, no "just pick one."** Site B alone leaves the Onboarding/first-run white-screen class uncovered (structurally unreachable from inside `AppShell`); Site A alone gives no in-app recovery. Two instances of one reusable `ErrorBoundary`, different fallback wiring.
- **9.35 — `fallback: (reset: () => void) => ReactNode`, no error parameter at all.** Rule 7 discharged by the type, not by discipline — a caller cannot render `error.message`/stack because it is never handed one. Orchestrator called this the round's best design decision; banked as desktop **L20**.
- **9.35 — reset is both automatic (route-keyed) and manual (`ErrorFallback`'s "Try again" button).** Cheap, and the brief's Q3 allowed "both if cheap."
- **9.35 — `boundary_does_not_catch_async_or_handler_failures` uses an async rejection, not a synchronous throw.** A first draft asserted `fireEvent.click` throws synchronously; it doesn't (DOM spec: a listener exception reports to the global handler, not the caller) — and React DEV's `invokeGuardedCallbackDev` re-dispatches it as a *delayed* global report, which failed the whole `pnpm test` run as a process-level unhandled exception even though the test's own assertions were green. Rewrote to a component-handled async rejection (the real `{ok:false}` fold shape) — same invariant, zero process noise. Banked as desktop **L21** (with the tsconfig gap below).
- **9.35 — `tsconfig.testdom.json` gains `preload/api.d.ts`.** The root-boundary test renders the real `App`, which references `window.sow`; no test-dom file had transitively pulled in `App.tsx` before, so the tier had never needed the ambient global declaration. One-line mirror of `tsconfig.web.json`'s existing convention.
- **9.21-B — shape `(c)`: `{ok:false, reason?:"partial_scaffold"}`.** Every existing `{ok:false}` call site (including `App.tsx:217`'s live-handle fallback) stays valid unchanged since the field is optional. Applied the same "withhold from the type" move as 9.35's `fallback`, unprompted, on the same day — the orchestrator named this the L20 construction proving itself with a second independent application.
- **9.21-B — `markOnboarded` has TWO real call sites, not one, and both needed a direct pin.** `App.tsx:240` (inside the `onOnboarded` handler) and `App.tsx:104` (the 9.17 existing-install backfill effect). On a partial, `onOnboarded` never fires, so `backfilledRef` stays false and the backfill effect's fire-once guard does *not* block it — the only thing preventing a written marker is `shouldBackfillMarker` returning false, which holds only because the store never gains a workspace (the dispatch lives inside the unreached handler). A pin covering only `onOnboarded` would have left `:104` resting on that inference. Added a real-`App` integration test (mirroring 9.35's Site-A pattern: real production component, one seam — `renderer/lib/live.ts`'s `startLive` — mocked via `vi.mock`/`vi.hoisted`) covering both sites in one render. This is banked as desktop **L22**; the orchestrator named the flag itself ("`markOnboarded` is NOT separately pinned" instead of "both pinned") as the more transferable half of the lesson than the trace.
- **9.21-B — mutation-verified the new `markOnboarded` pin before commit (mandatory, per orchestrator).** The test passed against unmodified code (the guarantee already held, incidentally), so nothing had yet shown it could fail. Temporarily made `submit()` fire `onOnboarded` on a partial too; the test went RED (`Unable to find role="alert"` — the app navigated past Onboarding into `AppShell`, since the workspace got recorded as onboarded); reverted. Confirmed via `git status` + a full clean re-run (499/499) that no artifact was left behind.
- **9.21-B — resume is re-submitting the existing form, no separate "Resume" button.** Per the brief's Q3 default vote; fewer moving parts, no new mechanism to build or test.

## Decisions explicitly NOT made

- **9.35 — no persistent error-reporting preload channel.** `preload/bridge.ts` has exactly 7 channels, none logging; adding one is an out-of-scope IPC-surface expansion. `componentDidCatch` stays `console.error`-only (dev-tools, never a UI surface or log sink).
- **9.21-B — no cross-restart persistence of the partial-repair state.** The durable truth lives in the worker's store; re-running onboarding re-derives it. Out of scope, per the brief's Q4.
- **9.21-B — `App.tsx` left untouched.** The surface absorbs the new `reason` discriminant entirely; `App.tsx`'s `onOnboarded` handler exists to record a *completed* onboarding, and a partial is not one.
- **Neither slice touches `packages/contracts` or `packages/domain`.** No contract type changed; `OnboardResult` is a desktop-local type. Cross-doc invariant audit: N/A both slices.
- **"9.21 closes `/phase-exit 9`" — corrected, not claimed.** The dispatch and my own Step-9 initially inherited a plan line read as "9.21 is the sole remaining gate blocker." The orchestrator corrected this twice: 9.21 landing closes 9.21, but `9.10-D` and the `[~]` legs `9.5`/`9.6`/`9.7`/`9.8` remain open, and `9.5`'s §4.5 doc-pack leg can't tick at all (owner-deferred, no Drive connector). The commit message states the corrected claim.

## TDD compliance

**Clean, both slices.** 9.35: all 9 tests written and confirmed RED (import-resolution failure) before `ErrorBoundary.tsx` existed. 9.21-B: all 7 new tests confirmed RED for the right reason (missing `reason` discrimination / stale copy) before the fold/surface were widened; the `markOnboarded` integration test additionally mutation-verified post-GREEN per the mandatory Step-2.5 obligation (see above).

## Reachability

- **9.35:** Site B — reachable from the real production `AppShell` (rendered from `App.tsx`), test-covered directly. Site A — traced by inspection, not test (`main.tsx` is imperative boot glue, same class as this repo's other boot-glue wiring): `index.html` → `<script src="/renderer/main.tsx">` → unconditional top-level `createRoot(...).render(<StrictMode><ErrorBoundary><App/></ErrorBoundary></StrictMode>)`. Stated asymmetrically per the orchestrator's mandatory Step-7.5 ask, not folded into "both sites covered."
- **9.21-B:** unchanged, pre-existing real wiring, widened rather than newly reached: `index.html`→`main.tsx`→`App`→`onCreateWorkspace` (`App.tsx:217`) → `liveRef.current.onboardWorkspace` → `createOnboardWorkspace(live.client)` (`lib/live.ts:153`) → `onboard-workspace.ts` → worker `onboarding.createWorkspace`.

## Open follow-ups

**Routed hot at Step 9 (orchestrator territory — already committed or acknowledged, not re-listed as mine):**
- `ARCHITECTURE.md` §11 notes for both slices — 9.35's landed at `e6eb3d4e`; 9.21-B's partial-scaffold note is the orchestrator's per this session's Step-9.
- Lessons banked: desktop **L20** (redaction-by-type, `97e220a7`), **L21** (jsdom/React-DEV handler-throw landmine + tsconfig include-parity gap, `97e220a7`), **L22** (a fold-incidental guarantee becomes a branching obligation the moment you narrow it — pin every real call site, `a5a35678`).
- 9.21 task tick + the `/phase-exit 9` blocker-list correction — orchestrator's.

**Desktop queue, not picked up this session:**
- **#13** — precondition on Copilot history/restore carrying derived disclosure state; activates when that feature is built (unchanged from doc 129).
- Three deferred code-quality lows across both slices (9.35: static-vs-data-attr pill class convention, test-naming convention question, dead `.sow-pill--zero-egress` CSS selector; 9.21-B: an untested-but-type-foreclosed absent-`cause`-key case, and one test — `onOnboarded_does_not_fire_on_a_partial_scaffold_result` — that's a strict subset of a preceding assertion, with the real coverage living in the `app-partial-scaffold-markonboarded` integration test instead). None need action; informational.

**Not desktop territory, flagged only:** a pre-existing dead CSS selector `.sow-pill--zero-egress` (still unaddressed from doc 129) — worth a future cleanup pass.

## `/preflight` note

`apps/desktop` typecheck (3 tsc passes, run standalone to isolate which config actually fails when one does): clean, both slices. `apps/desktop` test suite: 483 → 492 (9.35) → 499 (9.21-B), all green, no regressions, no process-level unhandled errors (after the 9.35 handler-throw test rewrite). `pnpm lint` is `tsc --noEmit`; no ESLint installed, no `format:check` defined anywhere — **"typecheck + tests clean; no lint coverage exists,"** never "lint clean." Did not run a full `pnpm build`; the 9.35/9.21-B briefs' acceptance lists named typecheck+test only.

One transient, non-blocking observation during 9.21-B's code-quality review: a repo-wide `pnpm typecheck` briefly showed `packages/domain/src/validation/no-inference.ts` failing to resolve `@sow/db` — traced to another track's (`contracts`) in-flight mutation for 13.20 (a deliberately-injected downstream import to prove a non-vacuity pin), not a regression in any file this session touched. `@sow/desktop`'s own typecheck, run standalone, was clean throughout.
