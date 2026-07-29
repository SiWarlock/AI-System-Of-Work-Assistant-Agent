// §2.5 import-direction root boundary test (task 13.20) — the domain half of the
// test `packages/contracts/CLAUDE.md` forbidden-pattern #2 claims exists ("a
// boundary test pins this") and, until now, did not. Domain is the ASYMMETRIC
// half of the invariant: it imports only `@sow/contracts` internally (correct —
// contracts is upstream), nothing else. Pins THREE surfaces: the declared
// `package.json` dependency set, the real source import surface, and — a
// companion guard, not the scanner itself (security review) — that the
// tsconfig chain defines no `paths` alias, the one escape vector the
// specifier-based scanner can't classify. Split from
// the contracts-side test (Q1(c) at Step 2.5) so neither package's suite reaches
// across the seam to police the other — this costs one small duplicated helper,
// intentionally (`test/_helpers/pure-root-scan.ts` mirrors the contracts-side
// file byte-for-byte; a cross-package test import would be worse than the
// duplication it would save).
//
// spec(§2.5/§3)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { scanPureRootViolations, type PureRootFile } from "../_helpers/pure-root-scan";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const PKG_SRC_ROOT = "packages/domain/src";

// domain's ONLY allowed internal dependency is @sow/contracts (upstream, correct).
const ALLOWED_INTERNAL: readonly string[] = ["@sow/contracts"];

// Hardcoded so a moved/renamed/new source file forces a deliberate bump (Lesson 12
// non-vacuity) — a scan over a mis-globbed/shrunk surface can never masquerade as
// "0 violations".
const EXPECTED_SRC_TS_FILE_COUNT = 18;

function loadRealSourceFiles(): PureRootFile[] {
  const listed = execFileSync("git", ["ls-files", "--", PKG_SRC_ROOT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p.endsWith(".ts"));
  return listed.map((p) => ({ path: p, content: readFileSync(join(REPO_ROOT, p), "utf8") }));
}

describe("§2.5 pure-root boundary — packages/domain imports only @sow/contracts (13.20)", () => {
  // ── Unit behavior of the pure scanner (synthetic fixtures) ──────────────────
  it("flags a disallowed @sow/* import (only @sow/contracts is allowed)", () => {
    const res = scanPureRootViolations(
      [{ path: "packages/domain/src/evil.ts", content: 'import { x } from "@sow/db";' }],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(res.violations).toEqual([
      { path: "packages/domain/src/evil.ts", specifier: "@sow/db", line: 1, reason: "disallowed_internal_import" },
    ]);
  });

  it("does NOT flag @sow/contracts — domain depending on contracts is the CORRECT upstream direction", () => {
    const res = scanPureRootViolations(
      [{ path: "packages/domain/src/clean.ts", content: 'import type { Result } from "@sow/contracts";' }],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(res.violations).toEqual([]);
  });

  // code-quality review (13.20): a bare side-effect import (`import "x";` — no
  // `from`, no braces) is a real, idiomatic import form the OSB anti-corruption
  // guard's own "every idiomatic form" fixture treats as must-still-trip
  // (contracts LESSONS #48). The original SPECIFIER_RE missed it entirely.
  it("flags a bare side-effect import (no `from`, no braces) — both violation classes", () => {
    const disallowed = scanPureRootViolations(
      [{ path: "packages/domain/src/evil.ts", content: 'import "@sow/db";' }],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(disallowed.violations).toEqual([
      { path: "packages/domain/src/evil.ts", specifier: "@sow/db", line: 1, reason: "disallowed_internal_import" },
    ]);

    const escaping = scanPureRootViolations(
      [{ path: "packages/domain/src/validation/evil.ts", content: 'import "../../../apps/worker/foo";' }],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(escaping.violations).toEqual([
      {
        path: "packages/domain/src/validation/evil.ts",
        specifier: "../../../apps/worker/foo",
        line: 1,
        reason: "escapes_package_root",
      },
    ]);
  });

  it("flags a relative import that resolves OUTSIDE the package's src root", () => {
    const res = scanPureRootViolations(
      [{ path: "packages/domain/src/validation/evil.ts", content: 'import { x } from "../../../apps/worker/foo";' }],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(res.violations).toEqual([
      {
        path: "packages/domain/src/validation/evil.ts",
        specifier: "../../../apps/worker/foo",
        line: 1,
        reason: "escapes_package_root",
      },
    ]);
  });

  it("an EMPTY scan set is never vacuously green — scannedCount === 0", () => {
    const res = scanPureRootViolations([], PKG_SRC_ROOT, ALLOWED_INTERNAL);
    expect(res.scannedCount).toBe(0);
    expect(res.violations).toEqual([]);
  });

  // ── The declared surface (package.json) ─────────────────────────────────────
  it("domain_depends_only_on_contracts — package.json's only internal dep is @sow/contracts", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages/domain/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const internalDeps = Object.keys(pkg.dependencies ?? {}).filter((k) => k.startsWith("@sow/"));
    expect(internalDeps).toEqual(["@sow/contracts"]);
    // devDependencies must carry NO internal package at all (Q3 — a devDep on a downstream
    // package would let a *test* import it while src stayed clean).
    for (const key of Object.keys(pkg.devDependencies ?? {})) {
      expect(key.startsWith("@sow/"), `${key} is an internal devDependency`).toBe(false);
    }
  });

  // ── The real surface (LIVE, count-pinned — non-vacuity) ─────────────────────
  it("domain_source_imports_nothing_downstream — LIVE scan of the real packages/domain/src tree", () => {
    const files = loadRealSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(
      files.length,
      `packages/domain/src .ts file count changed from ${EXPECTED_SRC_TS_FILE_COUNT} to ${files.length} — ` +
        "if you added a legitimate new file, bump EXPECTED_SRC_TS_FILE_COUNT deliberately AND confirm the " +
        "new file appears in `files` above (i.e. was actually scanned, not silently skipped by git-ls-files/.gitignore). " +
        "A count-pin bumped without checking this has stopped being a non-vacuity guard.",
    ).toBe(EXPECTED_SRC_TS_FILE_COUNT);
    expect(files.map((f) => f.path)).toContain("packages/domain/src/index.ts");

    const res = scanPureRootViolations(files, PKG_SRC_ROOT, ALLOWED_INTERNAL);
    expect(res.scannedCount).toBe(EXPECTED_SRC_TS_FILE_COUNT);
    expect(res.violations).toEqual([]);
  });

  // ── Discovery↔detection wiring proof (PERMANENT — supersedes a transient
  // on-disk mutation, orchestrator/lead ruling 13.20). An on-disk violating
  // import, even reverted within one turn, is observable by another
  // implementer's CONCURRENT reviewer subagent in this shared checkout — a
  // brief mutation is still a real, visible break of a shared surface. This
  // proves the same claim with ZERO disk writes: take the REAL discovered file
  // list (the exact one the LIVE test above just count-pinned and asserted
  // non-empty), append ONE fabricated violating entry IN MEMORY (something
  // OTHER than @sow/contracts, so this proves the deny-case, not just the
  // allow-case), and assert the real scanner flags exactly that one. Runs on
  // every `pnpm test`, forever, unlike a mutation that evaporates on revert.
  it("wires discovery to detection — injecting one fabricated violation into the REAL discovered list is flagged (zero disk writes)", () => {
    const files = loadRealSourceFiles();
    const injected: PureRootFile[] = [
      ...files,
      { path: "packages/domain/src/__synthetic_injected_violation__.ts", content: 'import { x } from "@sow/db";' },
    ];
    const res = scanPureRootViolations(injected, PKG_SRC_ROOT, ALLOWED_INTERNAL);
    expect(res.scannedCount).toBe(files.length + 1);
    expect(res.violations).toEqual([
      {
        path: "packages/domain/src/__synthetic_injected_violation__.ts",
        specifier: "@sow/db",
        line: 1,
        reason: "disallowed_internal_import",
      },
    ]);
  });

  // ── Companion guard (security review) — a tsconfig `paths` alias is a THIRD
  // escape vector the specifier scanner above can't classify. Rather than widen
  // the scanner to guess at alias shapes that don't exist yet, this guard makes
  // their introduction LOUD: if either tsconfig ever defines `paths`, this goes
  // red and the scanner's completeness must be re-examined.
  it("the tsconfig chain (own + shared base) defines NO `paths` alias — the one escape vector the scanner above can't see", () => {
    const ownConfig = JSON.parse(readFileSync(join(REPO_ROOT, "packages/domain/tsconfig.json"), "utf8")) as {
      compilerOptions?: { paths?: unknown };
    };
    const baseConfig = JSON.parse(readFileSync(join(REPO_ROOT, "tsconfig.base.json"), "utf8")) as {
      compilerOptions?: { paths?: unknown };
    };
    expect(ownConfig.compilerOptions?.paths, "packages/domain/tsconfig.json defines `paths`").toBeUndefined();
    expect(baseConfig.compilerOptions?.paths, "tsconfig.base.json defines `paths`").toBeUndefined();
  });
});
