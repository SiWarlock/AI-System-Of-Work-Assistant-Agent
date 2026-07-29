// Task 9.25 — the recorded PRECONDITION that a rehydrated Copilot turn must carry DERIVED
// disclosure state (ARCHITECTURE.md §5), not an absent-therefore-safe optional. Its Done-when
// offers two exits: (A) a restore path lands with derived disclosure + a discloses-pin, or
// (B) the task closes with evidence no restore path exists. This file IS that evidence for (B),
// established from source (not inferred from the brief or the prior audit):
//
//   - The mount-time seed door is the `turns` prop on `CopilotProps`
//     (`renderer/surfaces/copilot/Copilot.tsx:112`), typed `readonly CopilotTurnSeed[]`
//     (`CopilotTurnSeed` declared at `:86-91`), destructured locally as `seedTurns`
//     (`:288`, `const { workspaceScoped, onCollapse, turns: seedTurns = [], onAsk } = props;`).
//   - The ONLY production render of `<Copilot>` is `chrome/AppShell.tsx:493`
//     (`<Copilot workspaceScoped={...} onCollapse={...} onAsk={...} />`, imported unaliased at
//     `:23` — `import { Copilot } from "../surfaces/copilot/Copilot";`), and it does not pass
//     `turns`. `renderer/dev/seed.ts` seeds no Copilot turns at all. No `localStorage` /
//     `sessionStorage` / `indexedDB` exists anywhere in `renderer/` — no persisted-state
//     rehydration route exists either. `copilot-panel.test.tsx` is the seed door's only consumer,
//     and it is a test file (a legitimate one, per this task's own Step 2.5).
//
// ⛔ This does NOT close the RISK, only the TASK: 9.25 stays a live, dormant precondition on
// whatever slice builds Copilot history/restore. The moment a production caller of `turns`
// appears, this pin goes RED — mutation-verified (see the session doc / Step-9 report for the
// applied mutations, the observed REDs, and the reverted counts).
//
// ⚠ Revision history is itself load-bearing here (two security-reviewer passes, both closed in
// this same slice — read before touching this file):
//
// (1) A first draft used a TEXT REGEX to find `<Copilot ...>` tags and a `turns=` substring check
//     inside the captured text. Two ORDINARY (non-adversarial) JSX idioms already used elsewhere
//     in THIS codebase defeated it silently: a spread attribute (`{...someProps}` — used at this
//     file's own `{...roving.listboxProps}`) can carry `turns` without the literal substring
//     `turns=` ever appearing; and a bare `>` INSIDE a JS expression earlier in the same tag (e.g.
//     a `.length > 0`-shaped comparison, idiomatic in `Copilot.tsx:196`) truncated the lazy
//     tag-capture before a later real `turns=` was ever seen. Fixed by switching to REAL JSX/TSX
//     parsing (`ts.createSourceFile` + walking `JsxOpeningElement`/`JsxSelfClosingElement` nodes),
//     which has no such gap, and by flagging a spread attribute as an offender OUTRIGHT (its
//     contents cannot be statically proven `turns`-free).
//
// (2) A second pass found the AST version still matched on the BARE TAG-NAME STRING `"Copilot"`,
//     with no resolution back to the actual imported binding — so a renamed import
//     (`import { Copilot as X }`), a namespace-qualified tag (`<M.Copilot .../>`), or a non-JSX
//     construction (`React.createElement(Copilot, {...})`) would all evade it silently, even
//     though none exists in this codebase today (verified: the sole import is the plain, unaliased
//     `import { Copilot } from "../surfaces/copilot/Copilot"` at `AppShell.tsx:23`, and
//     `createElement`/`cloneElement` have ZERO occurrences anywhere under `renderer/`). Closed the
//     realistic half: the scan now resolves the LOCAL name(s) a file's own `import` declarations
//     bind to the `Copilot` export of `../surfaces/copilot/Copilot` (handling `as`-aliasing and
//     namespace imports) and matches JSX tags against THAT resolved set, not a hardcoded string.
//
// (3) A third pass found `copilotLocalNames` resolves a DIRECT relative import of
//     `.../surfaces/copilot/Copilot` only — it does not follow a RE-EXPORT through an
//     intermediate barrel module (`import { Copilot } from "../surfaces/copilot"` via an
//     `export { Copilot } from "./Copilot"` in `copilot/index.ts`). Reproduced: a synthetic
//     consumer importing from the barrel path renders `<Copilot ... turns={...}/>` and the scan
//     returns zero offenses — silent, no unusual JSX shape, no renamed binding. Realistic, not
//     contrived: `renderer/surfaces/copilot/` is the ONLY one of seven `renderer/surfaces/*`
//     subdirectories with no `index.ts` barrel today — the other six (`connectors`, `calendar`,
//     `ingestion-inbox`, `system-health`, `cross-workspace-links`, `onboarding`) all already have
//     one, so adding one to `copilot/` for consistency is a mundane, foreseeable refactor, not an
//     adversarial one.
//
// ⛔ NAMED, NOT CHASED, RESIDUALS (both use the same honest-scoping posture rather than chasing
// arbitrary-depth static resolution):
//   - Non-JSX construction (`createElement`/`cloneElement`) is NOT structurally resolved to
//     Copilot specifically (doing so soundly means resolving arbitrary call-expression arguments
//     through variable bindings — a much larger undertaking for a risk that is currently
//     zero-occurrence and would be "a stark, foreseeable departure from the codebase's 100%
//     JSX-idiom style" — a reviewer's own words). Instead: a blunt tripwire asserts
//     `createElement`/`cloneElement` are not called AT ALL in the scanned production files — not
//     scoped to Copilot, but real: the day that stops being true, it goes RED and forces a human
//     look rather than silently staying green over a blind spot.
//   - Barrel re-export is NOT followed transitively (a general N-hop re-export resolver is its
//     own undertaking). Instead: a blunt tripwire asserts NO `index.ts`/`index.tsx` barrel exists
//     under `renderer/surfaces/copilot/` today (true right now) — the day one is added, THIS test
//     goes RED and forces a re-look at whether `copilotLocalNames` still resolves correctly,
//     rather than the barrel silently opening the exact gap this file exists to close.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Every file under `dir`, recursively, excluding `dev/` (renderer/dev/seed.ts — a legitimate,
 *  non-production consumer; there is no `test*` subtree inside `renderer/` itself, but the
 *  exclusion is named here anyway so the rule travels if one is ever added). */
function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) {
      if (e.name === "dev" || e.name.startsWith("test")) return [];
      return productionFiles(join(dir, e.name));
    }
    return [join(dir, e.name)];
  });
}

/** The real `Copilot.tsx` module, extension-stripped so a relative import resolves to it
 *  regardless of whether the specifier itself carries an extension. */
function copilotModulePath(): string {
  return fileURLToPath(new URL("../../renderer/surfaces/copilot/Copilot", import.meta.url));
}

/** Every local JSX-tag name a source file's OWN imports bind to the `Copilot` export of
 *  `../surfaces/copilot/Copilot` — resolves `as`-aliasing (`import { Copilot as X }` ⇒ `"X"`) and
 *  namespace imports (`import * as M from "..."` ⇒ `"M.Copilot"`, matching a `<M.Copilot>` tag's
 *  `tagName.getText()`). A non-relative (bare/aliased-path) import is not resolved — none exists
 *  for this module today; if one is added, this scan needs a matching update (named, not chased). */
function copilotLocalNames(sourceFile: ts.SourceFile, filePath: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue; // only relative specifiers can point at Copilot.tsx here
    if (resolve(dirname(filePath), spec) !== copilotModulePath()) continue;
    const clause = stmt.importClause;
    if (clause?.namedBindings === undefined) continue;
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const exportedName = (el.propertyName ?? el.name).text;
        if (exportedName === "Copilot") names.add(el.name.text); // el.name is the LOCAL binding
      }
    } else if (ts.isNamespaceImport(clause.namedBindings)) {
      names.add(`${clause.namedBindings.name.text}.Copilot`);
    }
  }
  return names;
}

/** One offending attribute on a resolved `<Copilot>`-bound JSX element: either an explicit
 *  `turns=` attribute, or a spread (`{...x}`) — a spread's contents cannot be proven `turns`-free
 *  statically, so it counts as an offender rather than being silently trusted. */
interface CopilotOffense {
  readonly file: string;
  readonly kind: "explicit-turns-attribute" | "spread-attribute";
  readonly detail: string;
}

function parse(filePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Real JSX/TSX parsing (TypeScript compiler API), never a text/regex scan — see the file-header
 *  comment. Resolves the tag name against the file's OWN import bindings (not a bare string
 *  match), so an `as`-aliased or namespace-qualified `Copilot` tag is still recognized. */
function copilotOffensesIn(filePath: string, source: string): readonly CopilotOffense[] {
  const sourceFile = parse(filePath, source);
  const localNames = copilotLocalNames(sourceFile, filePath);
  if (localNames.size === 0) return []; // this file doesn't import Copilot at all — nothing to check
  const offenses: CopilotOffense[] = [];

  function checkAttributes(tagName: string, attrs: ts.JsxAttributes): void {
    if (!localNames.has(tagName)) return;
    for (const attr of attrs.properties) {
      if (ts.isJsxAttribute(attr) && attr.name.getText(sourceFile) === "turns") {
        offenses.push({ file: filePath, kind: "explicit-turns-attribute", detail: attr.getText(sourceFile) });
      } else if (ts.isJsxSpreadAttribute(attr)) {
        offenses.push({ file: filePath, kind: "spread-attribute", detail: attr.getText(sourceFile) });
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node)) {
      checkAttributes(node.tagName.getText(sourceFile), node.attributes);
    } else if (ts.isJsxOpeningElement(node)) {
      checkAttributes(node.tagName.getText(sourceFile), node.attributes);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return offenses;
}

/** A blunt, file-wide (not Copilot-specific) check: does this source call `createElement` or
 *  `cloneElement` at all, however imported? Not a resolved construction analysis — a tripwire that
 *  a currently-zero-occurrence idiom shift would trip, forcing a human look rather than a silent
 *  blind spot (see the file-header "NAMED, NOT CHASED, RESIDUAL" note). */
function usesImperativeElementConstruction(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
          ? callee.name.text
          : undefined;
      if (name === "createElement" || name === "cloneElement") found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function rendererDir(): string {
  return fileURLToPath(new URL("../../renderer/", import.meta.url));
}

function copilotSurfaceDir(): string {
  return fileURLToPath(new URL("../../renderer/surfaces/copilot/", import.meta.url));
}

/** No `index.ts`/`index.tsx` barrel exists under `renderer/surfaces/copilot/` today — see the
 *  file-header "(3)" note. A barrel there would let a consumer import `Copilot` via a re-export
 *  path `copilotLocalNames` does not resolve, silently reopening the gap this file exists to
 *  close. Named, not chased. */
function copilotSurfaceHasBarrel(): boolean {
  const entries = readdirSync(copilotSurfaceDir(), { withFileTypes: true });
  return entries.some((e) => e.isFile() && (e.name === "index.ts" || e.name === "index.tsx"));
}

describe("Copilot rehydrate seam — no production consumer (9.25, branch-B evidence)", () => {
  it("no_production_consumer_of_the_rehydrate_seam", () => {
    const files = productionFiles(rendererDir());
    const offenders = files.flatMap((f) => copilotOffensesIn(f, readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no_imperative_element_construction_in_production_renderer_code — named residual tripwire", () => {
    const files = productionFiles(rendererDir());
    const offenders = files.filter((f) => usesImperativeElementConstruction(parse(f, readFileSync(f, "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("no_copilot_surface_barrel_exists — named residual tripwire (re-export indirection)", () => {
    expect(copilotSurfaceHasBarrel()).toBe(false);
  });

  // Non-vacuity (contracts L74/L80): without this, an empty/broken scan would pass the tests above
  // forever. Proves the walk actually visits files AND that the AST scan actually finds the one
  // known legitimate production `<Copilot>` usage (AppShell.tsx) — the scan's subject is real.
  it("the_tripwire_scans_something — non-vacuity control", () => {
    const files = productionFiles(rendererDir());
    expect(files.length).toBeGreaterThan(0);
    let foundCopilotElement = false;
    for (const f of files) {
      const sourceFile = parse(f, readFileSync(f, "utf8"));
      const localNames = copilotLocalNames(sourceFile, f);
      if (localNames.size === 0) continue;
      const visit = (node: ts.Node): void => {
        if (
          (ts.isJsxSelfClosingElement(node) && localNames.has(node.tagName.getText(sourceFile))) ||
          (ts.isJsxOpeningElement(node) && localNames.has(node.tagName.getText(sourceFile)))
        ) {
          foundCopilotElement = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(foundCopilotElement).toBe(true);
  });
});
