// Slice 2 (task 13.10) — anti-false-arming regression guard for the propose /
// serving-oracle go-live gate. Pins that the boot-level arming mappings use STRICT
// `=== true`, so a future refactor to a truthy check (`if (config.X)`) can never let a
// non-boolean truthy config value (a JSON/env-sourced `1` / `"false"` / `{}`) silently
// ARM the go-live path (§12 serving-trust axis; §13 owner-gated go-live; Lesson 23/8).
//
// WHY a source assertion (not a behavioral test) for the two boot legs: the mappings are
// INLINE inside `bootWorker` (boot.ts:1171/1173) with no lightweight runtime seam — a
// `bootWorker` behavioral test is `SOW_API`-gated (skipped in the default suite ⇒ a
// non-pin) and heavy, and extracting a pure helper would be a production change on a
// safety gate this coverage-only slice must keep byte-equivalent. Crucially, the
// STRICTNESS for provenance-stamping lives ONLY at boot.ts:1171 — the pure
// `selectServingOracleFactory` truthy-checks `provenanceStampingEnabled` internally
// (servingContextLoader.ts:238), so no pure-fn test can cover that leg. The `goLiveArmed`
// axis is ALSO pinned behaviorally at the enforcing chokepoint (servingContextLoader.ts:239)
// by servingContextLoader.test.ts — this guard is the belt-and-suspenders literal pin.
//
// The assertions are EXPRESSION-anchored (not line-anchored) and whitespace-tolerant, so
// they survive reformatting and fail ONLY on the strictness-weakening regression (the
// `=== true` disappears) or a deliberate config-field rename (itself a signal worth a
// test update).
//
// DO NOT "upgrade" this to a behavioral bootWorker test: that path is `SOW_API`-gated
// (skipped in the default suite ⇒ a non-pin) AND the `:1171` provenance-stamping leg is
// behaviorally unreachable from the pure fn. This is the deliberate, valid resolution
// under the zero-production-change constraint — its rigor is the mutation proof
// (RED-on-weaken, restore) that shipped with it, not runtime observation.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT_SRC = resolve(HERE, "../../src/boot.ts");
const LOADER_SRC = resolve(HERE, "../../src/api/procedures/servingContextLoader.ts");

const bootSource = readFileSync(BOOT_SRC, "utf8");
const loaderSource = readFileSync(LOADER_SRC, "utf8");

describe("propose / serving-oracle arming — strict `=== true` regression guard (13.10)", () => {
  it("boot maps copilotProvenanceStamping with strict `=== true` (boot.ts:1171)", () => {
    // Anchor on the `provenanceStampingEnabled:` selection-mapping key so this pins the
    // boot.ts:1171 leg SPECIFICALLY — not the separate construction guard at boot.ts:1148,
    // which also reads `config.copilotProvenanceStamping === true`. A truthy weakening
    // (`provenanceStampingEnabled: config.copilotProvenanceStamping`) drops the `=== true`.
    expect(bootSource).toMatch(
      /provenanceStampingEnabled:\s*config\.copilotProvenanceStamping\s*===\s*true/,
    );
  });

  it("boot maps copilotServingOracleGoLive with strict `=== true` (boot.ts:1173, OFF-lock 1)", () => {
    expect(bootSource).toMatch(
      /goLiveArmed:\s*config\.copilotServingOracleGoLive\s*===\s*true/,
    );
  });

  it("selectServingOracleFactory gates goLiveArmed with strict `=== true` (servingContextLoader.ts:239)", () => {
    // Belt-and-suspenders literal pin; the behavioral pin lives in servingContextLoader.test.ts.
    // Anchor on the `if (` guard so a stray doc-comment mentioning the literal can't false-pass.
    expect(loaderSource).toMatch(/if\s*\(\s*sel\.goLiveArmed\s*===\s*true/);
  });
});
