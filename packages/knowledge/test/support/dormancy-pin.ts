// Dormancy-pin authority (13.8f-A commit 1) — the ONE place the "is this production importer
// ARMING-GATED?" predicate lives, so every dormant synthesis entry point (rewriteVaultForSource,
// rewriteVaultForMeeting, …) pins the SAME rule and they can never drift (knowledge L1/L2 —
// predicate-lives-once).
//
// WHY THIS SHAPE. The original pin asserted *zero* non-test importers under `apps/` or
// `packages/workflows/`. That phrasing guarantees a RED window on the very slice that binds the
// module (the binder must either turn the repo red or edit another track's test), so it is
// reframed to the invariant it always MEANT:
//
//     every production importer must be an ARMING-GATED site — never merely "there are none".
//
// Zero importers still passes (today's state); a flag-gated binding passes (tomorrow's); an
// UNGATED binding fails. No RED window on either side.
//
// GATED is recognized by one of three signals in the importing FILE:
//
//   · `dormancy-waiver(<task-id>)` — THE LOAD-BEARING BRANCH (see the marker contract below).
//   · a strict `=== true` arming check IN THE IMPORTING FILE — the project's dormancy-gate
//     discipline (knowledge L2: a truthy-non-`true` value is a false-green vector, so every real
//     arming gate is strict). Retained, but it is NOT the branch real bindings rely on.
//   · TYPE-ONLY reference (`import type` / `typeof`), which cannot execute and so cannot arm.
//
// ── THE MARKER CONTRACT (why the waiver is load-bearing, not a fallback) ────────────────────────
// The project's composition discipline is "logic-in-package, wire-at-boot": the strict `=== true`
// arming check lives at the COMPOSITION ROOT (`apps/worker/src/boot.ts`, behind a pure gate helper
// such as `gateCopilotVaultReadDeps` / `gateAutoIngest`), while the file that actually IMPORTS the
// dormant symbol is a different file one hop away (e.g.
// `apps/worker/src/composition/buildActivities.ts`). So a correctly-built, properly-gated binding
// legitimately contains NO `=== true` in the importing file — an `=== true`-only predicate would
// read it as UNGATED and turn this pin RED on a correct binding.
//
// Therefore every production file that imports a dormant synthesis symbol MUST carry, in that file:
//
//     // dormancy-waiver(<task-id>): <where the strict `=== true` gate actually lives>
//
// e.g. `// dormancy-waiver(13.8d): armed only via boot.ts gateLivingVaultRewrite (=== true)`.
//
// The marker is a DELIBERATE, greppable, reviewable claim — the binding author asserts the gate
// exists and says where. That pointer is what a reviewer (and `/wired`) checks; the marker itself
// is not proof.
//
// LIMITATION (documented, not hidden): none of these signals is an adversarial proof — a file can
// carry a marker or a stray `=== true` and still bind ungated. This pin is a guard-rail against the
// ACCIDENTAL ungated binding and a forcing function for the reviewed claim; the binding slice's own
// review + its default-OFF boot test are the real gate.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** How an importing production file relates to the dormancy guarantee. */
export type ImporterVerdict = "gated" | "ungated" | "type_only";

/** A production file that mentions the dormant symbol. */
export interface ImporterFile {
  readonly path: string;
  readonly source: string;
}

const TYPE_ONLY_LINE = /\bimport\s+type\b|\btypeof\s+/;
const STRICT_ARMING_GATE = /===\s*true/;
/** The load-bearing branch: `dormancy-waiver(<task-id>)` — a non-empty task id is REQUIRED. */
const EXPLICIT_WAIVER = /dormancy-waiver\(\s*[^)\s][^)]*\)/;

/**
 * Classify one importing file. TYPE-ONLY wins first (an inert type reference can't arm anything),
 * then the `dormancy-waiver(<task-id>)` marker (the branch a real composition-root binding relies
 * on), then a strict `=== true` arming check in this same file; anything else is UNGATED.
 */
export function classifyImporterSource(source: string, symbol: string): ImporterVerdict {
  const mentions = source.split("\n").filter((l) => l.includes(symbol));
  if (mentions.length > 0 && mentions.every((l) => TYPE_ONLY_LINE.test(l))) return "type_only";
  if (EXPLICIT_WAIVER.test(source) || STRICT_ARMING_GATE.test(source)) return "gated";
  return "ungated";
}

/** The ungated production importers — the pin's offender list. PURE over the supplied files. */
export function ungatedImporters(files: readonly ImporterFile[], symbol: string): string[] {
  return files.filter((f) => classifyImporterSource(f.source, symbol) === "ungated").map((f) => f.path);
}

/**
 * Scan the repo for PRODUCTION importers of `symbol`: non-test `.ts` under `apps/` or
 * `packages/workflows/` (the runtime/orchestration surfaces dormancy is about). Build output
 * (`dist/`) is excluded — it is a compiled artifact of a source file already scanned, not an
 * independent importer. Never throws: an unreadable file surfaces as empty source (⇒ ungated,
 * fail-loud) rather than silently vanishing from the offender list.
 */
export function scanProductionImporters(symbol: string, repoRoot: string): ImporterFile[] {
  let out = "";
  try {
    out = execSync(`grep -rn '${symbol}' packages apps --include='*.ts' || true`, { cwd: repoRoot, encoding: "utf8" });
  } catch {
    out = "";
  }
  const paths = [
    ...new Set(
      out
        .split("\n")
        .filter(Boolean)
        .filter((l) => !l.includes(".test.ts") && !l.includes("/test/") && !l.includes("/dist/"))
        .filter((l) => /^(apps|packages\/workflows)\//.test(l))
        .map((l) => l.slice(0, l.indexOf(":")))
        .filter(Boolean),
    ),
  ];
  return paths.map((p) => {
    let source = "";
    try {
      source = readFileSync(resolve(repoRoot, p), "utf8");
    } catch {
      source = "";
    }
    return { path: p, source };
  });
}
