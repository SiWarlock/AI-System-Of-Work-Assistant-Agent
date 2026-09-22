// Regression pin: the scope switcher's pull-down must paint ABOVE the sidebar and content.
//
// ⛔ THE BUG, reported by the owner 2026-09-21 ("when I click the drop down to switch to employer work
// the dropdown doesn't show up") and REPRODUCED against the real `styles.css` in a live browser:
//   • `.sow-toolbar` is `position: relative` + `backdrop-filter`, which makes it its OWN stacking
//     context — so `.sow-ws-menu { z-index: 50 }` only ranks the menu WITHIN the toolbar.
//   • `.sow-sidebar` and `.sow-content` are ALSO stacking contexts (relative + backdrop-filter) and come
//     LATER in the DOM. With every one of them at `z-index: auto`, they paint in DOM order, OVER the
//     whole toolbar context — menu included.
//   • Measured: the menu spans y 47→182 but the toolbar ends at y 52, so the owner saw only a 5px
//     strip. `elementFromPoint` on the "Employer-Work" row returned `sow-sidebar`.
// ⇒ It blocked the owner from switching scope at all, which gates every workspace-scoped surface.
//
// ⭐ WHY THE MENU'S OWN `z-index: 50` LOOKED LIKE IT SHOULD WORK, and is the transferable part: a
// z-index is only compared against siblings in the SAME stacking context. `backdrop-filter` (like
// `transform`, `filter`, `opacity < 1`) silently creates one, so a large z-index on a popup inside a
// glass panel is capped by the panel's own rank. The fix belongs on the PANEL, not the popup.
//
// Node tier, structural (desktop LESSONS §3 — no render needed; jsdom computes no paint order anyway,
// so a jsdom test here would pass on the broken CSS). Mirrors `chrome-egress-claim.test.ts`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../../renderer/styles.css", import.meta.url)), "utf8");

/** The declaration block of the FIRST rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (m === null || m[1] === undefined) throw new Error(`no rule for ${selector}`);
  return m[1];
}

/** The integer z-index a block declares, or 0 for `auto`/absent (both rank as level 0). */
function zIndex(selector: string): number {
  const m = /(?:^|[;\s])z-index\s*:\s*(-?\d+)/.exec(block(selector));
  return m?.[1] === undefined ? 0 : Number(m[1]);
}

describe("toolbar stacking — the scope pull-down paints above the body panels", () => {
  it("control: the parser reads real rules, so a pass below is not a parse miss", () => {
    // Positive control first — without it, a selector typo would make every assertion below
    // compare against an empty block and fail (or pass) for the wrong reason.
    expect(zIndex(".sow-ws-menu")).toBe(50);
    expect(block(".sow-sidebar")).toMatch(/backdrop-filter/);
    expect(block(".sow-content")).toMatch(/backdrop-filter/);
  });

  it("⛔ `.sow-toolbar` is positioned AND ranks above every later stacking-context sibling", () => {
    const toolbar = block(".sow-toolbar");
    // `z-index` does nothing on a static element, so both halves are required.
    expect(toolbar).toMatch(/position\s*:\s*(relative|absolute|fixed|sticky)/);
    const tb = zIndex(".sow-toolbar");
    for (const later of [".sow-body", ".sow-sidebar", ".sow-content"]) {
      expect(tb, `${later} would paint over the toolbar's popups`).toBeGreaterThan(zIndex(later));
    }
  });
});
