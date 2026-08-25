// R7-c — the @sow/contracts and @sow/domain BARRELS must not reach `node:fs` /
// `node:crypto`: a Temporal workflow bundle statically resolves every relative
// import off the sandbox entrypoint and cannot resolve a Node built-in, so a
// module that pulls one in ONLY through a package-barrel `export *` (never
// actually called at workflow runtime) still breaks the bundle. This test
// statically walks the TRANSITIVE RELATIVE-import graph off each barrel's
// entrypoint — reading real source, resolving `./x` -> `x.ts` — and asserts no
// reachable module VALUE-imports `node:fs` / `node:crypto` (or their bare `fs`
// / `crypto` forms). It does NOT follow bare/package specifiers (`ajv`,
// `@sow/contracts`, …) — those cross a package boundary the walk isn't scoped
// to (the two barrels' OWN reachable surface is what a bundler resolving THIS
// package's relative imports would inline).
//
// Parses real TypeScript AST (`typescript`, already a devDependency) rather
// than regex/text scanning, for two reasons discovered writing this test:
//  1. A doc-comment quoting `from "node:fs"` as an example (this repo's own
//     module headers do exactly that) is textually indistinguishable from a
//     real import to a regex, but is invisible to an AST walk.
//  2. `packages/contracts/src/models/agent-job.ts` has a REAL
//     `import type { SchemaRegistry } from "../schema/registry"` — a
//     TYPE-ONLY import. Under this repo's `verbatimModuleSyntax` (pinned in
//     tsconfig.base.json), a whole-clause type-only import/export is ERASED
//     at compile time — zero runtime reference, so a bundler never resolves
//     it. Treating it as a live edge would be a FALSE POSITIVE against what a
//     real build does; `ts.ImportDeclaration.importClause.isTypeOnly` /
//     `ts.ExportDeclaration.isTypeOnly` are exactly the compiler's own
//     verdict on whether a clause is erased, so we defer to them instead of
//     re-deriving the rule by hand.
//
// POSITIVE CONTROL (non-vacuity, Lesson 12 shape): the identical walker, run
// from `packages/contracts/src/schema/registry.ts` (which legitimately keeps
// its own VALUE `import { readdirSync, readFileSync } from "node:fs"` — see
// that module's header), MUST find it. An "all clear" from a walker that has
// never once found anything is worthless.
//
// spec(R7-c)
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

const CONTRACTS_BARREL = "packages/contracts/src/index.ts";
const DOMAIN_BARREL = "packages/domain/src/index.ts";
const CONTRACTS_REGISTRY = "packages/contracts/src/schema/registry.ts"; // positive-control entrypoint

const NODE_BUILTIN_SPECIFIERS: ReadonlySet<string> = new Set(["node:fs", "node:crypto", "fs", "crypto"]);

interface ImportEdge {
  readonly specifier: string;
  /** True iff the WHOLE import/export clause is type-only (erased under verbatimModuleSyntax). */
  readonly typeOnly: boolean;
}

/**
 * Extract every static `import`/`export … from "spec"` edge from real
 * TypeScript source, via the compiler's own AST (not text/regex scanning —
 * see the module header for why). Dynamic `import(...)` calls are NOT
 * ImportDeclaration/ExportDeclaration nodes, so they are naturally excluded.
 */
function extractImportEdges(source: string, fileName: string): ImportEdge[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: node.importClause?.isTypeOnly === true,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return edges;
}

interface BuiltinHit {
  readonly file: string; // repo-relative path of the module doing the importing
  readonly specifier: string; // the exact node-builtin specifier found
}

interface WalkResult {
  readonly visitedFiles: readonly string[]; // repo-relative paths actually read
  readonly hits: readonly BuiltinHit[];
}

/**
 * Resolve a relative specifier (`./x`, `../y/z`) seen inside `fromRepoPath`
 * to a repo-relative `.ts` file path, the same way Node/a bundler resolves an
 * extensionless relative specifier: try the bare path (if already carries an
 * extension), then `<path>.ts`, then `<path>/index.ts`.
 */
function resolveRelative(fromRepoPath: string, specifier: string): string {
  const fromDirAbs = dirname(join(REPO_ROOT, fromRepoPath));
  const targetAbsNoExt = resolve(fromDirAbs, specifier);
  const candidates =
    extname(specifier) !== ""
      ? [targetAbsNoExt]
      : [`${targetAbsNoExt}.ts`, join(targetAbsNoExt, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate.slice(REPO_ROOT.length + 1);
    }
  }
  throw new Error(
    `barrel-node-builtin-free walker: could not resolve relative import "${specifier}" ` +
      `from ${fromRepoPath} (tried: ${candidates.join(", ")}). The walker is out of sync ` +
      `with real module resolution — fix the walker, don't ignore this.`,
  );
}

/**
 * Walk the transitive RELATIVE-import graph starting at `entryRepoPath`,
 * collecting every VALUE `node:fs` / `node:crypto` (or bare `fs` / `crypto`)
 * edge. A whole-clause TYPE-ONLY edge is skipped entirely (neither followed
 * nor counted as a hit) — it is erased at compile time under this repo's
 * `verbatimModuleSyntax`, so it is not part of what a bundler actually
 * resolves. Bare/package specifiers (no `./`/`../` prefix, and not a
 * node-builtin form) are likewise recorded as neither a hit nor a traversal
 * edge — they cross a package boundary this walk does not follow.
 */
function walkForNodeBuiltins(entryRepoPath: string): WalkResult {
  const visited = new Set<string>();
  const hits: BuiltinHit[] = [];
  const stack: string[] = [entryRepoPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const absPath = join(REPO_ROOT, current);
    const source = readFileSync(absPath, "utf8");
    for (const edge of extractImportEdges(source, absPath)) {
      if (edge.typeOnly) continue; // erased under verbatimModuleSyntax — not a real edge
      if (NODE_BUILTIN_SPECIFIERS.has(edge.specifier)) {
        hits.push({ file: current, specifier: edge.specifier });
        continue;
      }
      if (edge.specifier.startsWith("./") || edge.specifier.startsWith("../")) {
        const resolved = resolveRelative(current, edge.specifier);
        if (!visited.has(resolved)) stack.push(resolved);
      }
      // else: bare package specifier (ajv, @sow/contracts, zod, …) — not followed.
    }
  }

  return { visitedFiles: [...visited], hits };
}

describe("barrel-node-builtin-free — @sow/contracts + @sow/domain barrels reach no node:fs/node:crypto (R7-c)", () => {
  // ── Unit behavior of the walker (synthetic, isolated from repo state) ──────
  it("extractImportEdges finds a VALUE import's specifier", () => {
    const edges = extractImportEdges('import { x } from "node:fs";', "fixture.ts");
    expect(edges).toEqual([{ specifier: "node:fs", typeOnly: false }]);
  });

  it("extractImportEdges finds a multi-line import's specifier", () => {
    const edges = extractImportEdges('import {\n  a,\n  b,\n} from "./deep/path";', "fixture.ts");
    expect(edges).toEqual([{ specifier: "./deep/path", typeOnly: false }]);
  });

  it("extractImportEdges finds a bare side-effect import with no `from`", () => {
    const edges = extractImportEdges('import "./polyfill";', "fixture.ts");
    expect(edges).toEqual([{ specifier: "./polyfill", typeOnly: false }]);
  });

  it("extractImportEdges marks a whole-clause `import type` as typeOnly", () => {
    const edges = extractImportEdges(
      'import type { SchemaRegistry } from "../schema/registry";',
      "fixture.ts",
    );
    expect(edges).toEqual([{ specifier: "../schema/registry", typeOnly: true }]);
  });

  it("extractImportEdges marks `export type * from` as typeOnly", () => {
    const edges = extractImportEdges('export type * from "./types";', "fixture.ts");
    expect(edges).toEqual([{ specifier: "./types", typeOnly: true }]);
  });

  it("extractImportEdges ignores a doc-comment that merely QUOTES an import (no false positive)", () => {
    const source = [
      '// this module used to `import { readdirSync } from "node:fs"` for real',
      'import { z } from "zod";',
    ].join("\n");
    expect(extractImportEdges(source, "fixture.ts")).toEqual([{ specifier: "zod", typeOnly: false }]);
  });

  it("extractImportEdges does NOT treat a dynamic import() call as a declaration edge", () => {
    const edges = extractImportEdges('const x = await import("node:fs");', "fixture.ts");
    expect(edges).toEqual([]);
  });

  it("walkForNodeBuiltins skips a type-only edge entirely (no traversal, no hit)", () => {
    // A synthetic two-file graph would need real files on disk for resolveRelative,
    // so this is exercised end-to-end instead: agent-job.ts's REAL
    // `import type { SchemaRegistry } from "../schema/registry"` must not
    // surface as a hit when walking from the contracts barrel (asserted below).
    const edges = extractImportEdges(
      'import type { SchemaRegistry } from "../schema/registry";\nimport { z } from "zod";',
      "fixture.ts",
    );
    expect(edges.filter((e) => !e.typeOnly).map((e) => e.specifier)).toEqual(["zod"]);
  });

  // ── POSITIVE CONTROL — the walker DOES find node:fs when it is really there ──
  it("POSITIVE CONTROL: walking from contracts/src/schema/registry.ts finds node:fs", () => {
    const result = walkForNodeBuiltins(CONTRACTS_REGISTRY);
    const fsHits = result.hits.filter((h) => h.specifier === "node:fs" || h.specifier === "fs");
    expect(fsHits.length).toBeGreaterThan(0);
    expect(fsHits[0]!.file).toBe(CONTRACTS_REGISTRY);
  });

  // ── LIVE walk of the real barrels ──────────────────────────────────────────
  it("packages/contracts/src/index.ts reaches no node:fs / node:crypto", () => {
    const result = walkForNodeBuiltins(CONTRACTS_BARREL);
    // Non-vacuity: the walk must have actually traversed more than the entry file.
    expect(result.visitedFiles.length).toBeGreaterThan(5);
    expect(result.hits).toEqual([]);
  });

  it("packages/domain/src/index.ts reaches no node:fs / node:crypto", () => {
    const result = walkForNodeBuiltins(DOMAIN_BARREL);
    expect(result.visitedFiles.length).toBeGreaterThan(5);
    expect(result.hits).toEqual([]);
  });
});
