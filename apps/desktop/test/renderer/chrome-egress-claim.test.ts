// Task 9.10 follow-on (⚠ rule-5) — the STRUCTURAL half of the "chrome asserts no egress posture" pin.
//
// A hardcoded `Egress: local-only` pill lived in `AppShell` until 2026-07-26 (`c379f847` → removed).
// The RENDER half of this pin lives in `test-dom/app-shell.test.tsx` (`chrome_makes_no_egress_claim`);
// this half asserts the pill's styling is gone too, because a live selector named for the badge is an
// invitation to "restore" it — the claim would come back with its CSS already waiting.
//
// Node tier per LESSONS §3 — a DOM-less structural check needs no render, and §4 reserves the jsdom
// tier for component behavior. Worth knowing if you ever move it back: under the jsdom tier the static
// `new URL("<literal>", import.meta.url)` form does NOT work — Vite's web transform rewrites that exact
// pattern to an asset URL resolved against the jsdom document base (`http://localhost:3000/…`), so
// `fileURLToPath` throws ERR_INVALID_URL_SCHEME. (`import.meta.url` itself IS a proper `file:` URL
// there — measured, not assumed — so `dirname(fileURLToPath(import.meta.url))` would work; it is the
// static two-arg form specifically that breaks.)
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every file under `renderer/`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("chrome egress claim — structural (⚠ rule-5 regression pin)", () => {
  it("no_dead_egress_pill_styles — the removed pill's classes have zero references in renderer/", () => {
    // spec(§5) — `sow-pill-egress` was the badge itself; `sow-pill-mono` was used by NOTHING but that
    // badge's inner span, so it dies with it. Both must be gone: a leftover selector is the seed of a
    // restored claim.
    //
    // Word-boundary, not substring: the live 9.10-C classes `sow-pill--egress-true` /
    // `sow-pill--zero-egress` use a DOUBLE dash and must not trip this, and task #8's truthful pill
    // should be free to name itself `sow-pill-egress-scoped` without inheriting a confusing failure.
    // ⚠ `\b` is NOT enough here: `-` is a non-word char, so `\bsow-pill-egress\b` still matches
    // `sow-pill-egress-scoped`. Exclude an adjoining word char OR dash on either side, so only the
    // EXACT dead tokens count.
    const dead = /(?<![\w-])(?:sow-pill-egress|sow-pill-mono)(?![\w-])/;
    const rendererDir = fileURLToPath(new URL("../../renderer/", import.meta.url));
    const offenders = walk(rendererDir).filter((f) => dead.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no_css_injected_claim — no `content:` declaration carries renderable text", () => {
    // spec(§5) — jsdom does not evaluate `content:`, so the RENDER half of this pin is structurally
    // BLIND to a `::before`/`::after` claim: `.sow-pill::after { content: "local-only" }` would
    // restore a visible assurance with both other pins green. Every decorative pseudo-element in the
    // shell uses an EMPTY string, so "no non-empty content" is a real, currently-true invariant.
    // The lookbehind excludes the `--content:` custom property and every `justify-content:`.
    const css = readFileSync(fileURLToPath(new URL("../../renderer/styles.css", import.meta.url)), "utf8");
    const values = [...css.matchAll(/(?<![-\w])content\s*:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(values.filter((v) => v !== '""' && v !== "''" && v !== "none")).toEqual([]);
  });
});
