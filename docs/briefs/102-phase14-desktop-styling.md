# /tdd brief — phase14_desktop_styling (Phase-14 visual-polish slice)

## Feature
Apply the **deferred visual polish** to the 5 Phase-14 desktop UI surfaces so they render in the project's macOS **Liquid Glass** system instead of raw unstyled HTML. The /tdd briefs for these surfaces explicitly deferred visual styling to `/design-review`; design-review #52 (static pass — no app-up env) confirmed the surfaces are functionally + a11y sound but **every new `sow-*` class has ZERO CSS**. This slice adds the CSS (+ minor JSX structure) to match the established styled vocabulary. **Desktop-track; CSS-only + minor JSX — NO logic change, no hard line.** This is NOT strict `/tdd` (visual output can't be pinned by a deterministic failing test — the project's non-deterministic-coverage path applies); the deliverable is verified by keeping existing render/structure tests green + a **live `/design-review` still owed** once an app-up env exists.

## Use case + traceability
- **Task ID:** Phase-14 visual-polish follow-up (task #53; Carry-forward "PHASE-14 DESKTOP VISUAL-POLISH DEBT", origin: design-review #52).
- **Architecture sections it implements:** `ARCHITECTURE.md §19.1` (Onboarding/Config/Runtime-Substrate desktop surfaces) — the UI-design posture is the locked macOS Liquid Glass system (see the SoW UI design memo). No model/contract anchor (pure presentation).
- **Depends on:** the shipped Phase-14 desktop legs (all 5 surfaces exist + are wired + a11y-sound). Nothing blocks this; it's additive presentation.
- **Related context (confirm at Step 1 — you own the desktop track):**
  - **The reference styled surface — `apps/desktop/renderer/surfaces/approvals/Approvals.tsx` + its CSS vocab** (`sow-approval-card` / `-head` / `-status` / `-meta` / `-actions`, `sow-approval-btn--<variant>`): the established Liquid Glass card/list/action pattern to mirror.
  - **The shared page chrome** — `sow-content` + `sow-page-head` (the content-padding + page-head wrapper the other surfaces use; the 5 new surfaces currently use a bare `role="main"` + `<h1>`).
  - **The 5 surfaces to style:** `surfaces/onboarding/index.tsx` (incl. the preset picker — `sow-preset-preview`/`sow-preset-*`), `surfaces/connectors/index.tsx`, `surfaces/system-health/index.tsx`, `surfaces/cross-workspace-links/index.tsx`. (Preset picker lives in the onboarding surface.)
  - **The stylesheet** — `apps/desktop/renderer/styles.css` (where the new `sow-*` classes get their rules).

## Acceptance criteria (what "done" means)
- [ ] **(1) Liquid Glass CSS for every new `sow-*` class** — `sow-onboarding`, `sow-preset-preview`/`sow-preset-*`, `sow-connectors`/`sow-connector-item`/`-list`, `sow-system-health`/`sow-health-item`, `sow-cross-workspace-links`/`sow-link-item`/`-direction`/`-scope`, the `*-error` banners, `sow-field-note`, `sow-subtle` — styled to the Approvals card/list/form vocabulary (glass surfaces, consistent radius/spacing/typography). No class renders as raw HTML.
- [ ] **(2) Shared page chrome** — each surface adopts `<main className="sow-content"><div className="sow-page-head"><h1>…` (replacing the bare `role="main"` + `<h1>`), so they inherit the shared content padding + page-head. (Structural JSX change — keep a11y roles intact.)
- [ ] **(3) Per-row action buttons** — connectors (Enable/Pause/Set-cadence) + cross-workspace-links (Approve/Revoke) per-row buttons get the `sow-*-btn--<variant>` treatment (Approve/Revoke as distinct affordances, mirroring the Approvals decision buttons). The rule-4 approve/revoke aria-labels stay intact.
- [ ] **(4) Loading affordance** — a lightweight spinner / `aria-busy` during async (preset preview, create, register, approve/revoke). Buttons already disable via the in-flight `busy` guard — this adds the visible indicator, not new logic.
- [ ] **(5) Onboarding step indicator** — a small `1/3` wayfinding affordance on the 3-step onboarding flow.
- [ ] **No logic/behavior change** — the busy guards, gate calls, WS-8/rule-4 aria-labels, empty (`sow-empty` role=status) + error (role=alert, safe generic copy) states are UNTOUCHED. Existing render/structure/a11y tests stay green.
- [ ] `/preflight` clean (desktop + repo-wide typecheck/lint).

## Wiring / entry point (Step 7.5)
No new reachability surface — these are already-routed, already-reachable surfaces (via the AppShell nav / route store). This slice changes their presentation only. Confirm at Step 1 that no new exported symbol is introduced (pure CSS + in-place JSX edits); if a small presentational helper/subcomponent is extracted, name it + its render-site in Step 9.

## Files expected to touch
**Modified:** `apps/desktop/renderer/styles.css` (the bulk — new `sow-*` rules) + the 5 surface components (`surfaces/onboarding/index.tsx`, `surfaces/connectors/index.tsx`, `surfaces/system-health/index.tsx`, `surfaces/cross-workspace-links/index.tsx`) for the page-chrome adoption + button variant classNames + loading/step affordances.
If a shared presentational helper (e.g. a `<Spinner>` or a `<StepDots>`) is warranted, add it under `renderer/lib` or `renderer/chrome` and flag at Step 2.5.

## Test / verification posture (NOT strict RED — visual slice)
- This is presentation; there is no deterministic failing-test-first for rendered CSS. **Keep every existing desktop test green** (render/structure/a11y snapshots for these surfaces).
- Where a change is structural + assertable (the `sow-content`/`sow-page-head` wrapper presence, the `sow-*-btn--<variant>` class on the action buttons, the step-indicator node, `aria-busy` on the async control), **add/extend a light render assertion** so the structure is pinned (these ARE deterministic).
- **Live verification owed:** flag in Step 9 that a live `/design-review` remains owed once an app-up env exists — this static/blind CSS pass mirrors the Approvals surface but the rendered spacing/hierarchy/color/motion is unverified in this env.

## Cross-doc invariant impact
- **Model:** none (pure presentation). **Shared-contract seam touched?** No.

## Things to flag at Step 2.5
1. **Any shared presentational helper** you extract (Spinner / StepDots / a styled row-button) — name it + where it lives, so it's not a hidden new surface.
2. **Page-chrome adoption scope** — confirm swapping `role="main"`+`<h1>` for `sow-content`+`sow-page-head` keeps each surface's a11y landmark/heading semantics intact (it must remain one `main` landmark + an `<h1>`).
3. **Any place the CSS pass tempts a logic tweak** — if styling a state reveals a genuine behavior gap, flag it separately (don't fold logic into the visual slice).

## Dependencies + sequencing
- **Depends on:** the shipped Phase-14 desktop surfaces (all present). **Blocks:** nothing. Idle-fill; sequence AFTER task #51 (the Phase-14 desktop session doc).
- Not a phase gate; Phase-14 functional completion already stands. This is the visual-polish debt closing.

## Estimated commit count
**1.** CSS-dominant + minor JSX; no logic. **code-quality every-slice**; **security-reviewer NOT required** (no invariant/safety surface — pure presentation; the WS-8/rule-4 aria-labels + gate calls are untouched, confirm so at Step 8). **Pure-build — NO hard line.**

## Lessons-logged candidates anticipated
- **Convention candidate (maybe)** — the desktop visual vocabulary: new surfaces adopt `sow-content`/`sow-page-head` chrome + mirror the Approvals `sow-*-card/head/status/meta/actions` + `sow-*-btn--<variant>` vocab from the start (so a future surface ships styled, not as deferred debt). Bank only if it reads as a durable convention.

## How to invoke
1. Continue the desktop-impl session (AFTER #51 lands).
2. Read this brief + re-read design-review #52's enumerated items (1–5).
3. `/tdd phase14_desktop_styling` — treat it as a visual slice: existing tests stay green + add light structural assertions; no RED-first for pure CSS.
4. Step 2.5 — ping the helper-extraction + page-chrome-a11y answers. (Lightweight review — it's presentation.)
5. Step 9 — categorized flags; **explicitly flag the live `/design-review` still owed**. Confirm no logic changed.
