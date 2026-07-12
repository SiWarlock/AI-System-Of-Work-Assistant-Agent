# /tdd brief — a11y_roving_focus_listboxes (Phase 9, pivot slice 1)

## Feature
Fix the ARIA-APG roving-focus anti-pattern on the desktop's two `role="listbox"` surfaces — the **Projects** list (`surfaces/projects/Projects.tsx`) and the **workspace ScopeSwitcher** (`chrome/AppShell.tsx`). Both currently put `tabIndex={0}` on EVERY `role="option"`, so Tab cycles through all options and there's no arrow-key navigation. Convert to the standard roving-tabindex listbox: exactly ONE option (the active one) is tab-focusable (`tabIndex={0}`), the rest `tabIndex={-1}`; Up/Down/Home/End move the roving focus; Enter/Space selects; the listbox is a single tab stop. Extract a shared `useRovingListbox` hook so both surfaces stay consistent. Pure renderer UI, LOCAL, non-HITL, no safety surface.

## Use case + traceability
- **Task ID:** 9-a11y (the standing codebase-wide a11y roving-focus carry-forward item — origin: 2026-07-04, the Projects-listbox 9.5-R3 carry-forward)
- **Architecture sections it implements:** `ARCHITECTURE.md §11` (Electron Desktop UI — accessibility posture of the interactive surfaces). (§11 ∈ Phase 9 Spec anchors — no widen.)
- **Related context:** the carry-forward "a11y: Projects list ARIA-APG — the Projects `role="listbox"` lacks arrow-key roving focus (matches the existing ScopeSwitcher), so a codebase-wide a11y pass." The desktop render-test tier (jsdom + `@testing-library/react`, session 022 `d1667c8`) is the test harness. **Current gap (confirmed):** `Projects.tsx:200` `role="listbox"` with options at `:60-62` (`role="option"` + `aria-selected` + `tabIndex={0}` each); `AppShell.tsx:103` `role="listbox"` with options at `:109-111` (same). Both = the "every option tabIndex=0" anti-pattern. **NOT a hard-line item** — pure local renderer UI, no worker/contract/egress touch.

## Acceptance criteria (what "done" means)
- [ ] In each listbox, exactly ONE `role="option"` has `tabIndex={0}` (the active option); all others `tabIndex={-1}` — so the listbox is a SINGLE tab stop, not N.
- [ ] Arrow keys move the roving focus: `ArrowDown`/`ArrowUp` move to the next/previous option (focus follows), `Home`/`End` jump to the first/last. No wrap-around (ARIA-APG default — `ArrowDown` at the last option is a no-op).
- [ ] `Enter`/`Space` on the active option performs the existing selection action (Projects: open the project; ScopeSwitcher: select the workspace scope) — no selection behavior is lost.
- [ ] The active option tracks the currently-selected item on mount / when selection changes (so the roving entry point is sensible), and `aria-selected` stays correct.
- [ ] A shared `useRovingListbox` hook (or equivalent) is used by BOTH surfaces — no divergent copy of the keyboard logic.
- [ ] Render tests (jsdom + `@testing-library/react`) pin the roving behavior for both listboxes; existing Projects/ScopeSwitcher render tests stay green; repo-wide `turbo typecheck test` green; `/preflight` clean.

## Wiring / entry point (Step 7.5)
`Projects` + the AppShell `ScopeSwitcher` are already rendered on the real app shell — this refactors their existing keyboard/focus handling in place. `none — both surfaces are already mounted; this is an in-place a11y refactor`.

## Files expected to touch
**New:**
- `apps/desktop/renderer/lib/a11y/useRovingListbox.ts` (or a shared location) — the roving-tabindex + arrow-key hook (active index, key handler, per-option `tabIndex`/`ref` wiring).
- `apps/desktop/renderer/lib/a11y/useRovingListbox.test.tsx` (or fold into the surface render tests).

**Modified:**
- `apps/desktop/renderer/surfaces/projects/Projects.tsx` — options use the roving hook (drop per-option `tabIndex={0}`; container manages arrow nav).
- `apps/desktop/renderer/chrome/AppShell.tsx` — the ScopeSwitcher listbox uses the same hook.

If a third listbox surfaces (see Step-2.5 #3), flag before extending scope.

## RED test outline (Step 2)
1. **`roving_tabindex_exactly_one_zero`** — Asserts: in each listbox, exactly one option has `tabIndex=0` and the rest `-1` (initially the selected/first). Tag `spec(§11)`.
2. **`arrow_down_up_moves_active_and_focus`** — Asserts: `ArrowDown`/`ArrowUp` from the active option moves `tabIndex=0` + `document.activeElement` to the next/previous option. Why: §11 keyboard nav.
3. **`home_end_jump_first_last`** — Asserts: `Home`→first, `End`→last option becomes active/focused. Why: ARIA-APG.
4. **`no_wraparound_at_ends`** — Asserts: `ArrowDown` on the last / `ArrowUp` on the first is a no-op (active unchanged). Why: the chosen no-wrap contract.
5. **`enter_space_selects_active`** — Asserts: `Enter`/`Space` on the active option fires the existing selection callback (Projects open / scope select) — behavior preserved. Why: no regression.
6. **`listbox_single_tab_stop`** — Asserts: only one option is in the tab order (querying `tabIndex=0` count === 1 per listbox). Why: the roving contract (fixes the N-tab-stops anti-pattern).

## Cross-doc invariant impact
- **Model field changes:** none — pure renderer UI.
- **Orchestrator doc rows to write hot:** none.
- **Shared-contract seam model touched?** No.

## Things to flag at Step 2.5
1. **Roving-tabindex vs `aria-activedescendant`.** My default vote: **roving-tabindex** — it fits the existing per-option focusable `div`/`li` structure (each option stays a real focus target; only the active one is tab-reachable), a smaller, lower-risk refactor than restructuring to a container-focus + `aria-activedescendant` model. Confirm.
2. **Shared hook vs per-component.** My default vote: **a shared `useRovingListbox` hook** consumed by both surfaces — keeps the keyboard contract identical + DRY (the carry-forward calls it a "codebase-wide pass"). Confirm.
3. **Scope — which listboxes.** My default vote: **Projects + ScopeSwitcher ONLY** (the two confirmed `role="listbox"` surfaces with the anti-pattern). `IngestionInbox` (`surfaces/ingestion-inbox/`) is NOT currently a listbox (no `role="listbox"`) — CONVERTING it is a separate concern, OUT. Copilot's `onKeyDown` is the composer textarea, not a listbox — OUT. Confirm (flag if you find a third real listbox).
4. **Wrap-around + typeahead.** My default vote: **no wrap-around** (ARIA-APG default; Home/End cover the extremes) and **no typeahead** (out of scope for this pass — a follow-up if wanted). Confirm.

## Dependencies + sequencing
- **Depends on:** the desktop render-test tier (session 022, present). The Projects + ScopeSwitcher surfaces (built).
- **Blocks:** nothing hard. A cleaner a11y baseline for future listbox surfaces (e.g. a future IngestionInbox listbox).

## Estimated commit count
**1.** A focused a11y refactor + shared hook. Pure local renderer UI, no safety invariant → standard review (code-quality; no security-reviewer needed — no worker/contract/egress/secret surface). One commit.

## Lessons-logged candidates anticipated
- Possibly a convention candidate — "interactive list surfaces use the shared `useRovingListbox` (roving-tabindex, single tab stop) — never per-option `tabIndex=0`." Note if it recurs across future listboxes.

## How to invoke
1. Read this brief (pure renderer a11y refactor of two existing listboxes; the render-test tier is present). 2. `/tdd a11y_roving_focus_listboxes`. 3. Step 0 restate: roving-tabindex + arrow-key nav on Projects + ScopeSwitcher via a shared hook, single tab stop, selection preserved. 4. Step 2.5: the four decisions (roving vs activedescendant, shared hook, scope, wrap/typeahead). 5. Step 8: code-quality review (no security surface). 6. Step 9: flags + ship-ask.
