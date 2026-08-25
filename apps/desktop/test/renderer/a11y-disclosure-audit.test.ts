// §11 a11y fast-follow (CF-7 half) — the `aria-controls` disclosure audit. Every disclosure
// widget (`aria-expanded` on its trigger) must name the id of the region it controls via
// `aria-controls`, or a screen reader has no programmatic link from the toggle to what it
// reveals. Node tier per LESSONS §3 — a DOM-less structural check needs no render.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every file under `renderer/`, recursively (mirrors chrome-egress-claim.test.ts's walk). */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("a11y disclosure audit — every aria-expanded trigger names an aria-controls (§11 / CF-7)", () => {
  it("every .tsx file carrying aria-expanded ALSO carries aria-controls", () => {
    // spec(§11) — a disclosure toggle (aria-expanded) with no aria-controls leaves a screen
    // reader with no programmatic link from the trigger to the region it discloses.
    const rendererDir = fileURLToPath(new URL("../../renderer/", import.meta.url));
    const tsxFiles = walk(rendererDir).filter((f) => f.endsWith(".tsx"));
    const expandFiles = tsxFiles.filter((f) => readFileSync(f, "utf8").includes("aria-expanded"));

    // Positive control: an empty walk (a bad renderer-path resolution, a moved directory) must
    // FAIL this test, not silently pass with zero files inspected. Currently exactly 2 files
    // carry aria-expanded (AppShell.tsx's scope switcher, ingestion-inbox's reroute toggle).
    expect(expandFiles.length).toBeGreaterThanOrEqual(2);

    const offenders = expandFiles.filter((f) => !readFileSync(f, "utf8").includes("aria-controls"));
    expect(offenders).toEqual([]);
  });
});
