// §2.5 import-direction root — pure-root boundary scan (task 13.20). PURE, no
// I/O of its own; the caller supplies real source file contents (git-ls-files-
// enumerated, so build artefacts can't produce a false red). Mirrors the OSB
// anti-corruption guard's shape (packages/evals/src/osb/anti-corruption-guard.ts
// `scanForWriteSurfaces`): a pure scan function + a count-pinned LIVE test.
//
// Detects the REAL import surface, not just the declared package.json deps — a
// clean package.json is defeated by one relative import escaping the package's
// src root (a `../../apps/...` reach-around) or a disallowed `@sow/*` import.
// A tsconfig `paths` alias is a THIRD escape vector this scanner's specifier
// classification (`@sow/`-prefixed or relative-only) does NOT itself catch (a
// bare `@apps/worker/foo`-shaped alias matches neither branch and would pass
// through unscanned) — security review caught the doc overclaiming this.
// Closed instead by a companion guard in the LIVE test asserting neither this
// package's tsconfig.json nor the shared tsconfig.base.json defines `paths`
// (none does today); if one ever does, that guard goes red and this scanner
// needs a real third branch, not a silently-widened claim.
//
// KNOWN BLIND SPOTS, named rather than hidden (an `arch_gap`-style documented
// residual — not something to silently accept): (1) a dynamic `import()` whose
// specifier is a COMPUTED expression (or a template-literal specifier with no
// quotes) rather than a plain quoted string literal is invisible to this text
// scan — it can't evaluate an expression. (2) A `from`/specifier pair split
// across two lines (`import { a } from\n  "@sow/x";`) is missed by this
// LINE-based scan; this repo's consistent single-line `from "..."` formatting
// makes it low-likelihood, not eliminated. Both accepted for this slice.
//
// Test-only helper (not shipped in src/) — intentionally duplicated verbatim in
// packages/domain/test/_helpers/pure-root-scan.ts rather than imported across
// the package boundary (Q1(c) at Step 2.5: neither package's test suite reaches
// across the seam to police the other).
import { posix } from "node:path";

export interface PureRootFile {
  /** repo-root-relative path, e.g. "packages/contracts/src/models/task.ts" */
  readonly path: string;
  readonly content: string;
}

export type PureRootViolationReason = "disallowed_internal_import" | "escapes_package_root";

export interface PureRootViolation {
  readonly path: string;
  readonly specifier: string;
  readonly line: number;
  readonly reason: PureRootViolationReason;
}

export interface PureRootScanResult {
  readonly violations: readonly PureRootViolation[];
  readonly scannedCount: number;
}

// Matches the specifier of `from "x"`, `require("x")`, a STRING-LITERAL
// `import("x")`, AND a bare side-effect `import "x"` (no `from`, no braces —
// an idiomatic form the OSB anti-corruption guard's own fixture treats as
// must-still-trip, contracts LESSONS #48; missed until code-quality review
// caught it). The bare-form alternative anchors `import` immediately followed
// by whitespace then a quote, so it can't misfire on `import { x } from "y"`,
// `import type {...}`, or `import * as x` (none has a quote right there) or on
// `import(` (no whitespace before the paren, already covered by the 3rd
// alternative).
const SPECIFIER_RE =
  /\bfrom\s+["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;

/**
 * Scan `files` (real source under `pkgSrcRoot`, e.g. "packages/contracts/src")
 * for two violation classes: (1) an `@sow/*` import whose package is not in
 * `allowedInternalPackages` (contracts: none allowed; domain: only
 * `@sow/contracts`); (2) a relative import that RESOLVES outside `pkgSrcRoot` —
 * the escape hatch a clean package.json can't see. TOTAL — never throws.
 */
export function scanPureRootViolations(
  files: readonly PureRootFile[],
  pkgSrcRoot: string,
  allowedInternalPackages: readonly string[],
): PureRootScanResult {
  const violations: PureRootViolation[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      SPECIFIER_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SPECIFIER_RE.exec(line)) !== null) {
        const specifier = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
        if (specifier.length === 0) continue;
        if (specifier.startsWith("@sow/")) {
          const pkgName = specifier.split("/").slice(0, 2).join("/");
          if (!allowedInternalPackages.includes(pkgName)) {
            violations.push({ path: file.path, specifier, line: i + 1, reason: "disallowed_internal_import" });
          }
          continue;
        }
        if (specifier.startsWith(".")) {
          const resolved = posix.normalize(posix.join(posix.dirname(file.path), specifier));
          if (resolved !== pkgSrcRoot && !resolved.startsWith(pkgSrcRoot + "/")) {
            violations.push({ path: file.path, specifier, line: i + 1, reason: "escapes_package_root" });
          }
        }
      }
    }
  }
  return { violations, scannedCount: files.length };
}
