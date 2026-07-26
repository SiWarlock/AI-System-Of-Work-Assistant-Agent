// spec(§6 / safety rule 1) — task #54: the region-marker neutralizer is a SAFETY predicate, so it must
// exist EXACTLY ONCE in the repo. #51 made `packages/knowledge/src/markdown-vault/sections.ts` the canonical
// definition (co-located with `MARKER_RE`, the grammar it defends); the `@sow/workflows` projection copy is
// retired to a RE-EXPORT. Two independently-maintained copies of a marker-forgery defense are a drift hazard:
// a hardening applied to one (e.g. the ReDoS-safe `[\s/]*` class, or the single-pass `replaceAll` nesting
// collapse) silently leaves the other exploitable, and NOTHING in the type system notices.
//
// These are STRUCTURAL pins, deliberately distinct from `region-marker-neutralization.test.ts` (the BEHAVIOR
// pin, which keeps passing unchanged across the re-point): behavior agreeing today does not prove
// single-sourcing tomorrow — only a definition census + referential identity do.
//
// NOTE on the re-point's output: the two implementations shared a BYTE-IDENTICAL `REGION_MARKER_RE`, so the
// set of spans treated as markers is unchanged. They differed only in how much of a matched span is escaped
// per pass — the retired copy escaped the FIRST `<!--` (`String.replace`), the canonical one escapes EVERY
// `<!--` in the span (`replaceAll`, collapsing greedy-id-merged nesting in a single linear pass). Both run to
// the same fixpoint POST-CONDITION (zero `REGION_MARKER_RE`-matchable spans remain); on a nested marker-shaped
// body the canonical one escapes strictly MORE (the safe direction). So this is a hardening, not a regression
// — but it is a real output delta on that edge, not a pure no-op move (flagged at Step 9).
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neutralizeRegionMarkers as fromWorkflows } from "../src/activities/projections/noteSlug";
import { neutralizeRegionMarkers as fromKnowledge } from "@sow/knowledge";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Census the repo's non-test TypeScript sources for `pattern`, returning the matching FILES.
 * `node_modules` + `dist` are excluded so a pnpm-hoisted install (or a stale build output) cannot make the
 * census see the canonical definition twice and fail spuriously. A grep fault yields `[]`, which fails the
 * assertions below (fail-closed — never a false green).
 */
function censusFiles(grepArgs: string): readonly string[] {
  let out = "";
  try {
    out = execSync(
      `grep -rn ${grepArgs} packages apps --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist || true`,
      { cwd: repoRoot, encoding: "utf8" },
    );
  } catch {
    out = "";
  }
  return out
    .split("\n")
    .filter(Boolean)
    // Source definitions only — a test fixture that declares one is not a second authority.
    .filter((l) => !l.includes(".test.ts") && !l.includes("/test/"))
    .map((l) => l.split(":")[0])
    .filter((f): f is string => f !== undefined);
}

describe("neutralizeRegionMarkers — ONE definition, re-exported (#54 / #51)", () => {
  it("single_definition_repo_wide — exactly ONE DEFINITION of neutralizeRegionMarkers, in @sow/knowledge", () => {
    // Matches any DEFINITION form (`function neutralizeRegionMarkers`, `const neutralizeRegionMarkers =`),
    // exported or not — NOT just the `export function` spelling. A re-fork would most plausibly land as a
    // `const` arrow or an unexported local helper, and the narrower pattern would have missed both. A pure
    // RE-EXPORT (`export { neutralizeRegionMarkers }`, what noteSlug.ts now carries) is correctly not a match.
    expect(censusFiles(`-E '(function|const) neutralizeRegionMarkers'`)).toEqual([
      "packages/knowledge/src/markdown-vault/sections.ts",
    ]);
  });

  it("single_matcher_literal_repo_wide — exactly ONE region-marker MATCHER, in @sow/knowledge", () => {
    // The name census pins the FUNCTION; this pins the DEFENSE. The drift shape #54 exists to close is a
    // second copy of the MATCHER — re-declaring the marker regex under any other identifier would slip past
    // a name-only census while re-opening exactly the forge/ReDoS surface #51 consolidated.
    expect(censusFiles(`-F 'kw:region:[^\\s>]*'`)).toEqual([
      "packages/knowledge/src/markdown-vault/sections.ts",
    ]);
  });

  it("workflows_export_is_the_knowledge_authority — the two import paths yield the SAME function object", () => {
    // Referential identity, not behavioral agreement: proves a re-export rather than a re-implementation
    // that merely agrees today (the exact failure mode #54 exists to close).
    expect(fromWorkflows).toBe(fromKnowledge);
  });
});
