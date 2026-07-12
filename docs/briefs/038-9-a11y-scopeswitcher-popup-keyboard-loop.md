# /tdd brief — a11y_scopeswitcher_popup_keyboard_loop (Phase 9, pivot slice — a11y fast-follow)

## Feature
Complete the workspace **ScopeSwitcher** popup keyboard loop — the deferred a11y fast-follow to slice 1 (9-a11y). Add: (1) **focus-on-open** — opening the pull-down moves focus into the listbox onto the active option; (2) **return-focus-to-button** — a keyboard-driven close (Escape or a selection) returns focus to the trigger button; (3) **reset the roving activeIndex to the selected scope on each open** (so a reopen doesn't resume a stale arrow position). Pure local, non-HITL renderer a11y; no safety surface. **ADDITIVE ONLY** — the existing outside-click / Escape / tab-away dismissals + ARIA listbox semantics are security-reviewed (`AppShell.tsx:45-46` "do not alter") and MUST be preserved unchanged.

## Use case + traceability
- **Task ID:** 9-a11y-scopeswitcher-popup — the Phase-9 a11y fast-follow explicitly deferred by slice 1 (9-a11y, `5c55011`); the ScopeSwitcher is the 9.5 workspace-scope switcher surface (`chrome/AppShell.tsx`). Origin: PIVOT-note Future-TODO "the ScopeSwitcher popup keyboard loop (focus-on-open + Escape-to-close + return-focus-to-button; the activeIndex-persists-on-popup-reopen LOW folds in — key the reset on the open event)."
- **Architecture sections it implements:** `ARCHITECTURE.md §11` (Electron Desktop UI — accessibility of the interactive surfaces). (§11 ∈ Phase 9 Spec anchors — **no widen**.)
- **Related context:** slice 1 built the shared `useRovingListbox` hook (`renderer/lib/a11y/useRovingListbox.ts`, desktop Lesson 22) — the roving-tabindex contract WITHIN the listbox. This slice adds the POPUP-level focus loop AROUND it. The render-test tier (jsdom + `@testing-library/react`) is present.

**Confirmed current surface (pre-orient — `chrome/AppShell.tsx` `ScopeSwitcher` :48-135):**
- `const [open, setOpen] = useState(false)`; `wrapRef`; `useRovingListbox({ count, selectedIndex, onActivate })` (roving within the listbox). The `<ul role="listbox">` is rendered only `{open ? … }`; each `<li role="option">` gets `tabIndex`/`ref` from `roving.getOptionProps(i)`.
- ALREADY PRESENT + security-reviewed (DO NOT alter): outside-click close (`:77-86`), Escape close (`:92-94`), tab-away close (onBlur `:95-98`), `aria-haspopup="listbox"` + `aria-expanded` on the button (`:100-117`).
- EXPLICITLY DEFERRED (`:58-60` "Popup focus-on-open is a deferred follow-up — the user Tabs onto the active option, then arrows"): focus-on-open. Also missing: return-focus-to-button on close, and the roving `activeIndex` persists across open/close (the hook lives in the always-mounted `ScopeSwitcher`, so it resets only when `selectedIndex` changes — not on reopen).

## Acceptance criteria (what "done" means)
- [ ] **Focus-on-open:** when the popup opens, focus moves into the listbox onto the active (selected) option — the user no longer has to Tab onto it.
- [ ] **Return-focus-to-button on KEYBOARD close:** closing via Escape OR via a selection (Enter/Space/click-select that closes the popup) returns focus to the trigger `<button>`. Closing via **outside-click or tab-away does NOT** yank focus back (focus follows the user's action) — the security-reviewed dismissals stay behaviorally intact.
- [ ] **Reset roving activeIndex on each open:** reopening the popup starts the roving position at the currently-selected scope, not a stale prior arrow position.
- [ ] The existing outside-click / Escape / tab-away dismissals + ARIA listbox semantics are UNCHANGED (additive only). If the shared `useRovingListbox` is extended, its current consumers (Projects) are unaffected (the new param is optional; Projects passes nothing).
- [ ] Render tests (jsdom) pin: focus-on-open, return-focus on Escape, return-focus on select, NO return-focus on outside-click, reset-on-reopen; existing ScopeSwitcher/Projects render + dismissal tests stay green. Repo-wide `pnpm -w turbo run typecheck test` green; `/preflight` clean.

## Wiring / entry point (Step 7.5)
`none — the ScopeSwitcher is already mounted on the AppShell top bar`. This refactors its existing open/close/focus handling in place. No new entry point.

## Files expected to touch
**Modified:**
- `apps/desktop/renderer/chrome/AppShell.tsx` — `ScopeSwitcher`: a `buttonRef` on the trigger; return-focus on the Escape + select close paths (NOT on outside-click/tab-away); drive focus-on-open + reset-on-open.
- `apps/desktop/renderer/lib/a11y/useRovingListbox.ts` — (if the reset+focus-on-open lives in the shared hook, per Step-2.5 #1) an OPTIONAL `open?: boolean` param that, on a false→true edge, resets `activeIndex` to the selected entry + focuses the active option; `undefined` ⇒ today's behavior (Projects unaffected).
**New / extended:**
- `apps/desktop/test-dom/*.test.tsx` — extend the ScopeSwitcher render tests (or add a focused file) for the popup keyboard loop. Optionally a `useRovingListbox` hook unit test for the reset-on-open edge.

If implementation needs files beyond this list, **flag at Step 2.5**.

## RED test outline (Step 2)
Render (jsdom, extends the existing ScopeSwitcher render tests):
1. **`focus_moves_into_listbox_on_open`** — Asserts: after opening, `document.activeElement` is the active (selected) option. Why: §11 focus-on-open.
2. **`escape_returns_focus_to_button`** — Asserts: Escape closes + focus returns to the trigger button. Why: §11 keyboard loop.
3. **`select_returns_focus_to_button`** — Asserts: activating an option closes + focus returns to the button. Why: keyboard loop.
4. **`outside_click_does_not_return_focus`** — Asserts: an outside-click close does NOT force focus back to the button (dismissal behavior preserved). Why: the security-reviewed dismissal stays intact.
5. **`reopen_resets_active_to_selected`** — Asserts: arrow to a non-selected option, close, reopen → the roving active/focus is back on the selected scope. Why: the reset-on-open LOW.
6. **`existing_dismissals_still_work`** — Asserts: outside-click + Escape + tab-away still close the popup (regression guard on the security-reviewed behavior). Why: additive-only invariant.

## Cross-doc invariant impact
- **Model field changes:** none — pure renderer a11y.
- **Orchestrator doc rows to write hot:** none.
- **Shared-contract (§2.5-seam) model touched?** No.

## Things to flag at Step 2.5
1. **Where the reset+focus-on-open lives.** My default vote: **extend the shared `useRovingListbox` with an optional `open?: boolean`** — on the false→true edge it resets `activeIndex` to the selected entry + focuses the active option; keeps the a11y focus logic in the ONE shared hook (desktop Lesson 22 consistency), and Projects (always-visible, passes no `open`) is unaffected. Alternative: keep it ScopeSwitcher-local (the hook exposes a `focusActive()`), leaving the hook popup-agnostic. Confirm.
2. **Return-focus scope.** My default vote: **keyboard-close ONLY** — Escape + selection return focus to the button; outside-click + tab-away do NOT (focus follows the user's action; yanking it back on an outside-click is wrong + would alter the security-reviewed dismissal). Confirm.
3. **Focus target on open.** My default vote: **the active (selected) option** (roving already `.focus()`es options) rather than the listbox container — matches the roving model + ARIA-APG listbox pattern. Confirm.
4. **Additive-only guarantee.** My default vote: treat `AppShell.tsx:45-46` as binding — add focus management WITHOUT touching the outside-click/Escape/tab-away dismissal code paths or ARIA semantics; the regression test (RED #6) pins it. Confirm.

## Dependencies + sequencing
- **Depends on:** slice 1 (9-a11y, `5c55011`) — the shared `useRovingListbox` hook. The render-test tier (present).
- **Blocks:** nothing. Closes the Phase-9 a11y fast-follow.

## Estimated commit count
**1.** A focused, additive a11y refactor of one surface + a small optional hook extension. **No safety invariant** (pure renderer a11y; no worker/contract/egress/secret) → **code-quality review suffices; security-reviewer NOT required** (lead-confirmed). One commit.

## Lessons-logged candidates anticipated
- Possibly a small addendum to desktop Lesson 22 (roving-listbox) — "a listbox rendered inside a POPUP also owns focus-on-open + return-focus-to-trigger + reset-on-open, keyed on the open event; the shared hook takes an optional `open` signal." Note only if it recurs.

## How to invoke
1. Read this brief (small additive a11y fast-follow of the ScopeSwitcher popup; the shared roving hook exists; dismissals are security-reviewed — do not alter). 2. `/tdd a11y_scopeswitcher_popup_keyboard_loop`. 3. Step 0 restate: focus-on-open + return-focus-to-button (keyboard-close) + reset-activeIndex-on-open, additive over the existing dismissals. 4. Step 1: confirm the file list. 5. Step 2.5: the four decisions (hook vs local, return-focus scope, focus target, additive-only). 6. Step 8: code-quality review (no security surface). 7. Step 9: flags + ship-ask.
