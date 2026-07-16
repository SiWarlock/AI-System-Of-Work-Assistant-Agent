# Session 087 — desktop-impl cycle close-out (Phase-14 desktop legs + visual polish)

- **Date:** 2026-07-16
- **Phase:** 14 (Onboarding, Config Surfaces & Runtime Substrate — §19.1); + the Phase-14 visual-polish debt.
- **Role/agent:** desktop-impl (implementer, desktop track) — team `session-734f946b`; orchestrators across the cycle: orch22 → orch23 → orch24.
- **Predecessor:** [086](086-2026-07-16-desktop-impl-phase14-desktop-legs.md) (the Phase-14 desktop functional close-out — full per-leg detail).
- **Successor:** _(next desktop-impl cycle — a fresh spawn for 15.8 / a Phase-16 desktop leg)_
- **Close-out reason:** HARD-STOP cycle (lead directive at the context ceiling). This is the technical `/session-end` for the whole desktop-impl cycle.

## Why this session existed
Build the Phase-14 desktop-track surfaces on top of the shipped worker-foundation round, then close the phase (session doc, design review, visual polish). Session 086 documents the functional legs in full; this doc is the cycle close-out and captures the **visual-polish slice (#53)** built after 086 plus the cycle's audit + handoff state.

## What was built (this cycle)
Seven commits landed (all `apps/desktop/`-only, each dual-reviewed where safety-relevant; security-reviewer = invariant returned CLEAR on every safety slice):

| Work | Commit |
|---|---|
| 14.1 + 14.5 onboarding UI + preset picker + real onboarded-id scope model | `ad624a16` |
| 14.2 + 14.3 connectors surface + System-Health panel | `7d141528` |
| 14.7 cross-workspace-links approval UI (rule-4) | `31a0a0d3` |
| 14.4 app-managed local Temporal supervision (loopback-only, mock-tested) | `98696cea` |
| 14.4-durability Temporal `--db-filename` persistence (§13) | `3270a7d6` |
| Phase-14 desktop session doc (086) | `1c46d029` |
| **Phase-14 UI Liquid Glass styling (#53 — this doc's focus)** | `0abdb75a` |
| Design review #52 (static/code-level pass) | _(report only — no commit)_ |

**#53 — Phase-14 styling slice (`0abdb75a`):**
- **Files modified:** `renderer/styles.css` (a new "Phase-14 desktop surfaces" block — Liquid Glass rules for every new `sow-*` class, mirroring the Approvals vocab: cards with hairline border + glass fill, uppercase tinted status pills, `sow-btn--<variant>` buttons, glass form fields, a CSS spinner + step-dots) · the 4 surface components (`surfaces/onboarding|connectors|system-health|cross-workspace-links/index.tsx` — adopted the shared `<main className="sow-content sow-X"><div className="sow-page-head"><h1>` page-chrome, per-row `sow-btn--<variant>` action buttons, `aria-busy` + inline spinner loading affordance, onboarding 1/3 step indicator) · 4 `test-dom/*-page.test.tsx` (light structural assertions: single-`main` landmark, button-variant class, step-dots node, `aria-busy`).
- **Pure presentation, zero logic/safety change** — all gate/guard predicates, WS-8/rule-4 aria-labels, fieldset/legend, aria-pressed, and empty (role=status) / error (role=alert) states byte-preserved (code-quality-reviewer confirmed).

## Decisions made (this cycle's visual slice)
- **Inline decorative nodes, no shared component** — the spinner (`sow-spinner` class + `aria-busy`) and step-dots are inline CSS + JSX, not a `<Spinner>`/`<StepDots>` export (YAGNI for a single use-site; orch24 APPROVED).
- **`--primary` (blue `--accent-ink`) split from `--approve` (green `--good-ink`)** — a code-quality catch: both were resolving to green, making primary buttons pixel-identical to Approve.
- **Real `": "` separator in the preset preview** — fixed a screen-reader run-on ("Connectorsgoogle, asana").
- **Page-chrome swap keeps exactly one `main` + one `<h1>`** per surface (idiomatic — the other surfaces already root on bare `<main className="sow-content">`).

## Decisions explicitly NOT made
- **A live `/design-review`** — this cycle had NO app-up environment (per `/phase-exit 14`), so #52 was static/code-level and #53 was a blind CSS pass. The rendered spacing/hierarchy/color/motion is UNVERIFIED — a live `/design-review` remains owed.
- **Extracting a shared `<Spinner>`/`<StepDots>`** — deferred until a second use-site appears.
- All prior Phase-14 "NOT made" items stand (see 086): dormant transports, the cold-load list queries, projectionType taxonomy formalization, etc.

## TDD compliance
Clean. Every **deterministic** slice (14.1/14.5, 14.2/14.3, 14.7, 14.4, 14.4-durability) was strict RED-first. The **styling slice (#53) is explicitly NOT strict `/tdd`** (visual output can't be pinned by a deterministic failing test — brief 102 + the project's non-deterministic-coverage path); it followed that path — all existing render/structure/a11y tests kept green + light structural assertions added for the deterministic structural changes. No violations.

## Cross-doc invariant audit
No frozen contract-model field changed this cycle. The desktop work consumed existing worker procedures + UI-safe contract types; the new types are renderer-internal (`ScopeMeta.isGlobal`, `UiSafeConnectorInstanceView`, `UiSafeCrossWorkspaceLinkView`, the store slices) — not Appendix-A frozen seams, so no `ARCHITECTURE.md` field-row edit is owed. The possible §19.1 desktop-leg arch notes + the desktop lesson candidates were flagged at each Step 9 and are routed by the orchestrators at round close (not implementer territory).

## Reachability
- All 5 surfaces are reachable from the production App entry — routed in the renderer route store + mounted via AppShell nav (onboarding is the first-run entry; connectors/system-health/cross-workspace-links via NavLinks). Confirmed at each slice's Step 7.5.
- The Temporal supervisor is reachable via the worker-host boot path (env-gated `SOW_MANAGE_TEMPORAL`; OFF-default byte-equivalent). Tested via injected mocks (no real process in-suite).
- No tested-but-unwired gaps.

## Open follow-ups (routed at Step 9; carried for future-you)
1. **LIVE `/design-review`** on the 5 Phase-14 surfaces once an app-up env exists (the visual result is unverified this cycle).
2. **Worker Future-TODOs** (routed to the worker track): `connectorConfig.listByWorkspace` + `crossWorkspaceLink.listByWorkspace` (WS-8-scoped cold-load lists) · tokenRef reference-shape enforcement (14.7 worker) · share the `127.0.0.1:7233` default const between desktop `TEMPORAL_DEV_ADDRESS` and worker `boot.ts` · formalize the cross-workspace-allowed projection taxonomy.
3. **Desktop lesson candidate** (routed): a new desktop surface adopts `sow-content`/`sow-page-head` + mirrors the Approvals `sow-*-card/head/status` + `sow-*-btn--<variant>` vocab from the start (ships styled, not as deferred debt).
4. **Deferred review nits** (all non-blocking): onboarding `from`-default stale on scope-switch-while-mounted · connectors no in-flight busy-gate on toggle/cadence · the Temporal `dirname(config.dbPath)` userData coupling · the unreachable spawner fallback omitting `--ip` · the optional branded non-empty-path type for `dbFilename`.
5. **15.8 desktop leg** (human routing-resolution loop) + any Phase-16 desktop legs — the next desktop-impl spawn picks these up.

## Handoff
Phase-14 desktop track is FUNCTIONALLY + VISUALLY complete (styling debt closed; a live design-review verification still owed). All commits on `main`, unpushed (push is the orchestrator's `/orchestrate-end`). The desktop-impl cycle stands down here.
