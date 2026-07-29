// §2.5 import-direction root boundary test (task 13.20) — the test
// `packages/contracts/CLAUDE.md` forbidden-pattern #2 claims exists ("a boundary
// test pins this") and, until now, did not. Pins THREE surfaces: the declared
// `package.json` dependency set, the real source import surface (a clean
// package.json is defeated by one relative import escaping the package's src
// root, or a disallowed `@sow/*` import), and — a companion guard, not the
// scanner itself (security review) — that the tsconfig chain defines no `paths`
// alias, the one escape vector the specifier-based scanner can't classify.
// Mirrors the OSB anti-corruption guard's shape
// (packages/evals/src/osb/anti-corruption-guard.ts): a PURE scan function + a
// count-pinned LIVE test over git-ls-files-enumerated real source (build
// artefacts can't produce a false red).
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
const PKG_SRC_ROOT = "packages/contracts/src";

// contracts is the PURE ROOT — zero internal (@sow/*) imports allowed, anywhere.
const ALLOWED_INTERNAL: readonly string[] = [];

// Hardcoded so a moved/renamed/new source file forces a deliberate bump (Lesson 12
// non-vacuity) — a scan over a mis-globbed/shrunk surface can never masquerade as
// "0 violations". .snap fixture files are excluded (JSON data, no import statements).
const EXPECTED_SRC_TS_FILE_COUNT = 52;

function loadRealSourceFiles(): PureRootFile[] {
  const listed = execFileSync("git", ["ls-files", "--", PKG_SRC_ROOT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p.endsWith(".ts"));
  return listed.map((p) => ({ path: p, content: readFileSync(join(REPO_ROOT, p), "utf8") }));
}

describe("§2.5 pure-root boundary — packages/contracts imports nothing internal (13.20)", () => {
  // ── Unit behavior of the pure scanner (synthetic fixtures) ──────────────────
  it("flags a disallowed @sow/* import (contracts allows none)", () => {
    const res = scanPureRootViolations(
      [{ path: "packages/contracts/src/evil.ts", content: 'import { x } from "@sow/domain";' }],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(res.violations).toEqual([
      { path: "packages/contracts/src/evil.ts", specifier: "@sow/domain", line: 1, reason: "disallowed_internal_import" },
    ]);
  });

  // code-quality review (13.20): a bare side-effect import (`import "x";` — no
  // `from`, no braces) is a real, idiomatic import form the OSB anti-corruption
  // guard's own "every idiomatic form" fixture treats as must-still-trip
  // (contracts LESSONS #48). The original SPECIFIER_RE missed it entirely.
  it("flags a bare side-effect import (no `from`, no braces) — both violation classes", () => {
    const disallowed = scanPureRootViolations(
      [{ path: "packages/contracts/src/evil.ts", content: 'import "@sow/domain";' }],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(disallowed.violations).toEqual([
      { path: "packages/contracts/src/evil.ts", specifier: "@sow/domain", line: 1, reason: "disallowed_internal_import" },
    ]);

    const escaping = scanPureRootViolations(
      [{ path: "packages/contracts/src/models/evil.ts", content: 'import "../../../apps/worker/foo";' }],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(escaping.violations).toEqual([
      {
        path: "packages/contracts/src/models/evil.ts",
        specifier: "../../../apps/worker/foo",
        line: 1,
        reason: "escapes_package_root",
      },
    ]);
  });

  it("flags a relative import that resolves OUTSIDE the package's src root", () => {
    const res = scanPureRootViolations(
      [{ path: "packages/contracts/src/models/evil.ts", content: 'import { x } from "../../../apps/worker/foo";' }],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(res.violations).toEqual([
      {
        path: "packages/contracts/src/models/evil.ts",
        specifier: "../../../apps/worker/foo",
        line: 1,
        reason: "escapes_package_root",
      },
    ]);
  });

  it("does NOT flag an external npm import or a same-package relative import", () => {
    const res = scanPureRootViolations(
      [
        {
          path: "packages/contracts/src/models/clean.ts",
          content: [
            'import { z } from "zod";',
            'import Ajv from "ajv";',
            'import { fieldSet } from "../schema/field-set";',
          ].join("\n"),
        },
      ],
      PKG_SRC_ROOT,
      ALLOWED_INTERNAL,
    );
    expect(res.violations).toEqual([]);
  });

  it("an EMPTY scan set is never vacuously green — scannedCount === 0", () => {
    const res = scanPureRootViolations([], PKG_SRC_ROOT, ALLOWED_INTERNAL);
    expect(res.scannedCount).toBe(0);
    expect(res.violations).toEqual([]);
  });

  // ── The declared surface (package.json) ─────────────────────────────────────
  it("contracts_declares_no_internal_dependency — package.json carries no @sow/* key anywhere", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages/contracts/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      for (const key of Object.keys(section ?? {})) {
        expect(key.startsWith("@sow/"), `${key} is an internal dep`).toBe(false);
      }
    }
  });

  // ── The real surface (LIVE, count-pinned — non-vacuity) ─────────────────────
  it("contracts_source_imports_nothing_internal — LIVE scan of the real packages/contracts/src tree", () => {
    const files = loadRealSourceFiles();
    // Non-vacuity: the scan actually found the real tree, not an empty/mis-globbed one.
    expect(files.length).toBeGreaterThan(0);
    expect(
      files.length,
      `packages/contracts/src .ts file count changed from ${EXPECTED_SRC_TS_FILE_COUNT} to ${files.length} — ` +
        "if you added a legitimate new file, bump EXPECTED_SRC_TS_FILE_COUNT deliberately AND confirm the " +
        "new file appears in `files` above (i.e. was actually scanned, not silently skipped by git-ls-files/.gitignore). " +
        "A count-pin bumped without checking this has stopped being a non-vacuity guard.",
    ).toBe(EXPECTED_SRC_TS_FILE_COUNT);
    expect(files.map((f) => f.path)).toContain("packages/contracts/src/index.ts");

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
  // non-empty), append ONE fabricated violating entry IN MEMORY, and assert the
  // real scanner flags exactly that one. The claim decomposes into three parts,
  // and only this third part was ever missing: (1) discovery is correct — the
  // count-pin + known-file assertion above; (2) detection is correct — the
  // synthetic-fixture tests above; (3) the two are actually WIRED TOGETHER —
  // this test. Runs on every `pnpm test`, forever, unlike a mutation that
  // evaporates the moment it's reverted.
  it("wires discovery to detection — injecting one fabricated violation into the REAL discovered list is flagged (zero disk writes)", () => {
    const files = loadRealSourceFiles();
    const injected: PureRootFile[] = [
      ...files,
      { path: "packages/contracts/src/__synthetic_injected_violation__.ts", content: 'import { x } from "@sow/domain";' },
    ];
    const res = scanPureRootViolations(injected, PKG_SRC_ROOT, ALLOWED_INTERNAL);
    expect(res.scannedCount).toBe(files.length + 1);
    expect(res.violations).toEqual([
      {
        path: "packages/contracts/src/__synthetic_injected_violation__.ts",
        specifier: "@sow/domain",
        line: 1,
        reason: "disallowed_internal_import",
      },
    ]);
  });

  // ── Companion guard (security review) — a tsconfig `paths` alias is a THIRD
  // escape vector the specifier scanner above can't classify (a bare
  // `@apps/worker/foo`-shaped alias matches neither the `@sow/`-prefix nor the
  // relative-import branch). Rather than widen the scanner to guess at alias
  // shapes that don't exist yet, this guard makes their introduction LOUD: if
  // either tsconfig ever defines `paths`, this goes red and the scanner's
  // completeness must be re-examined, instead of silently staying green over a
  // widened claim.
  it("the tsconfig chain (own + shared base) defines NO `paths` alias — the one escape vector the scanner above can't see", () => {
    const ownConfig = JSON.parse(readFileSync(join(REPO_ROOT, "packages/contracts/tsconfig.json"), "utf8")) as {
      compilerOptions?: { paths?: unknown };
    };
    const baseConfig = JSON.parse(readFileSync(join(REPO_ROOT, "tsconfig.base.json"), "utf8")) as {
      compilerOptions?: { paths?: unknown };
    };
    expect(ownConfig.compilerOptions?.paths, "packages/contracts/tsconfig.json defines `paths`").toBeUndefined();
    expect(baseConfig.compilerOptions?.paths, "tsconfig.base.json defines `paths`").toBeUndefined();
  });
});
