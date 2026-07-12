// Shared ARIA-APG roving-tabindex listbox keyboard contract (§11 a11y; task 9-a11y).
//
// Every desktop `role="listbox"` surface (Projects, the workspace ScopeSwitcher) consumes THIS
// hook so the keyboard behavior stays identical — never a per-option `tabIndex={0}` (the N-tab-stops
// anti-pattern) or a divergent per-surface copy of the arrow-key logic.
//
// Contract: exactly ONE option (the active one) is tab-focusable (`tabIndex=0`), the rest `-1`, so the
// listbox is a SINGLE tab stop. Up/Down move the roving focus one step (focus follows), Home/End jump
// to the first/last, with NO wrap-around (ARIA-APG default — a boundary key is a no-op). Enter/Space
// activate the active option (EXPLICIT selection — arrowing browses, it does NOT select). The active
// index tracks the selected option and resets when the selection (or option count) changes externally.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/** Per-option props the hook supplies: the roving `tabIndex` + a ref registrar for `.focus()`. */
export interface RovingOptionProps {
  readonly tabIndex: number;
  readonly ref: (el: HTMLElement | null) => void;
}

export interface RovingListbox {
  /** The index of the option that is currently tab-focusable (the roving position). */
  readonly activeIndex: number;
  /** Props for the `role="listbox"` container — one keydown handler drives the whole keyboard contract. */
  readonly listboxProps: { readonly onKeyDown: (e: ReactKeyboardEvent) => void };
  /** Per-option props: spread/apply `getOptionProps(index)` on each `role="option"`. */
  readonly getOptionProps: (index: number) => RovingOptionProps;
}

export interface UseRovingListboxOptions {
  /** The number of options in the listbox. */
  readonly count: number;
  /** The index of the currently-selected option (the roving entry point); out-of-range ⇒ 0. */
  readonly selectedIndex: number;
  /** Invoked when Enter/Space activates the active option — the surface's existing selection action. */
  readonly onActivate: (index: number) => void;
  /**
   * OPTIONAL popup-open signal (§11 a11y). When provided, on a false→true edge the hook resets the
   * roving activeIndex to the selected entry AND moves focus onto the active option (popup
   * focus-on-open + reset-on-open, for a listbox rendered inside a pull-down). `undefined` ⇒ an
   * always-visible listbox (e.g. Projects) that manages no popup focus — no focus is ever moved on
   * mount/update. Return-focus-to-the-trigger stays the CONSUMER's job (the hook is trigger-agnostic).
   */
  readonly open?: boolean;
}

export function useRovingListbox({ count, selectedIndex, onActivate, open }: UseRovingListboxOptions): RovingListbox {
  const entryIndex = selectedIndex >= 0 && selectedIndex < count ? selectedIndex : 0;
  const [activeIndex, setActiveIndex] = useState<number>(entryIndex);
  const optionRefs = useRef<Array<HTMLElement | null>>([]);

  // The roving entry point tracks the selection: reset the active index when the selected option (or
  // the option count) changes externally. Arrow-driven active changes don't re-run this (entryIndex
  // is unchanged), so browsing with the arrows is never clobbered by a stale selection reset.
  useEffect(() => {
    setActiveIndex(entryIndex);
  }, [entryIndex]);

  // If the option set shrank out from under the roving position (a live projection dropped an option
  // the user had arrow-browsed past, without a selection change to trigger the reset above), clamp the
  // EFFECTIVE active index to the last valid option — so the listbox ALWAYS keeps exactly one tab stop,
  // never zero. Clamping on READ (not resetting the state) preserves the arrow position across benign
  // appends. `count === 0` (listbox not rendered) yields 0 harmlessly.
  const active = count === 0 ? 0 : Math.min(activeIndex, count - 1);

  const focusOption = useCallback((index: number): void => {
    optionRefs.current[index]?.focus();
  }, []);

  // Popup focus loop (§11 a11y): when an OPTIONAL `open` signal is supplied, on the false→true edge
  // reset the roving position to the selected entry AND move focus onto the active option
  // (focus-on-open + reset-on-open for a pull-down listbox). `open === undefined` — an always-visible
  // listbox (Projects) — opts out entirely: no focus is ever moved on mount/update. The effect runs
  // after commit, by which point the just-mounted options' refs are populated, so focusOption lands.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open === undefined) return;
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setActiveIndex(entryIndex);
      focusOption(entryIndex);
    }
  }, [open, entryIndex, focusOption]);

  const moveTo = useCallback(
    (index: number): void => {
      if (index < 0 || index >= count) return; // boundary: no wrap-around (ARIA-APG default)
      setActiveIndex(index);
      focusOption(index);
    },
    [count, focusOption],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent): void => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveTo(active + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveTo(active - 1);
          break;
        case "Home":
          e.preventDefault();
          moveTo(0);
          break;
        case "End":
          e.preventDefault();
          moveTo(count - 1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          onActivate(active);
          break;
        default:
          break;
      }
    },
    [active, count, moveTo, onActivate],
  );

  const getOptionProps = useCallback(
    (index: number): RovingOptionProps => ({
      tabIndex: index === active ? 0 : -1,
      ref: (el: HTMLElement | null): void => {
        optionRefs.current[index] = el;
      },
    }),
    [active],
  );

  return { activeIndex: active, listboxProps: { onKeyDown }, getOptionProps };
}
