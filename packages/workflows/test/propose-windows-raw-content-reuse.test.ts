// spec(§16) — task 24.32: `proposeWindows.ts` reuses the canonical raw-content-shape
// predicate (`@sow/contracts`'s `isRawContentShaped`/`carriesRawContent`, hardened by
// task 24.19 — Map/Set/non-enumerable/Symbol-key closed by construction) instead of
// maintaining its own unfixed fork (24.19 Step 9 / contracts L138). Two behavioral
// regression pins prove the reuse actually took (not merely imported alongside a
// still-running fork) without newly over-rejecting a clean payload; a census pin
// (mirroring `neutralizer-single-source.test.ts`'s #54/L39 pattern) proves the
// predicate lives exactly ONCE repo-wide, both function AND const forms, both-anchored.
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { carriesRawContent as fromContracts } from "@sow/contracts";
import { payloadCarriesRawContent } from "../src/activities/proposeWindows";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("24.32 — proposeWindows reuses the canonical raw-content-shape predicate", () => {
  // 24.19's own case: a Map value's entries are internal slots, not own enumerable
  // string-keyed properties — the fork's `Object.entries` traversal could never see
  // it. RED against the unmodified fork; proves the reuse actually took.
  it("propose_windows_rejects_a_map_valued_field — the fork's Object.entries traversal could not see this", () => {
    const m = new Map([["x", "line one\nline two — raw transcript"]]);
    expect(payloadCarriesRawContent({ schedule: m })).toBe(true);
  });

  // 24.19's other own case: a non-enumerable own property is invisible to
  // `Object.entries`/`Object.keys`/`for...in` — the canonical predicate scans via
  // `Object.getOwnPropertyNames` instead. RED against the unmodified fork.
  it("propose_windows_rejects_a_non_enumerable_raw_property — the fork's Object.entries traversal could not see this either", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "secret", {
      value: "line one\nline two — hidden raw text",
      enumerable: false,
    });
    expect(payloadCarriesRawContent({ meta: obj })).toBe(true);
  });

  // The risk direction a delete-and-reuse introduces: the canonical predicate is
  // STRICTER, so verify no legitimate short/single-line payload is newly rejected.
  it("propose_windows_still_accepts_a_clean_payload", () => {
    expect(
      payloadCarriesRawContent({
        start: "2026-08-20T09:00:00.000Z",
        end: "2026-08-20T09:30:00.000Z",
        genericExplanation: "conflicts with a busy block",
      }),
    ).toBe(false);
  });
});

// Census the repo's non-test TypeScript sources for `pattern`, returning the matching
// FILES. `node_modules`/`dist` excluded so a hoisted install or stale build output
// can't make the census see the canonical definition twice and fail spuriously. A
// grep fault yields `[]`, which fails the assertions below (fail-closed, never a
// false green).
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

describe("24.32 — isRawContentShaped/carriesRawContent live ONCE, in @sow/contracts", () => {
  it("raw_content_shape_predicate_lives_once — exactly ONE DEFINITION of isRawContentShaped repo-wide", () => {
    // Matches any DEFINITION form (`function isRawContentShaped`, `const
    // isRawContentShaped =`), not just the `export function` spelling a re-fork
    // would most plausibly land as (L39). RED today — proposeWindows.ts's fork is
    // a second `export function` definition; this is the pin 24.34 deliberately
    // deferred to this slice because two definitions legitimately existed until now.
    expect(censusFiles(`-E '(function|const) isRawContentShaped'`)).toEqual([
      "packages/contracts/src/models/gcl-projection.ts",
    ]);
  });

  it("carries_raw_content_lives_once — exactly ONE DEFINITION of carriesRawContent repo-wide", () => {
    // Not RED today (the fork's wrapper was named `payloadCarriesRawContent`, never
    // colliding on this name) — a completeness pin for the predicate's other half,
    // covering a future fork under the canonical name.
    expect(censusFiles(`-E '(function|const) carriesRawContent'`)).toEqual([
      "packages/contracts/src/models/gcl-projection.ts",
    ]);
  });

  it("propose_windows_export_is_the_contracts_authority — the two import paths yield the SAME function object", () => {
    // Referential identity, not behavioral agreement: proves a re-export rather
    // than a re-implementation that merely agrees today (the exact failure mode
    // this task exists to close). RED today — the fork is a distinct function.
    expect(payloadCarriesRawContent).toBe(fromContracts);
  });
});
