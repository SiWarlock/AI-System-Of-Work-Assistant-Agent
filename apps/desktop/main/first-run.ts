// 9.17 — authoritative, DURABLE first-run marker (pure, electron-free; §11 first-run, §16 never-throws).
// Owned by Electron main, persisted under app-data (userData) so onboarding shows ONLY on a genuine first
// run — not on a transient empty registry (worker unreachable at boot). Pure over an INJECTED fs seam
// (LESSON 13: persist to app-data, never /tmp/in-memory; LESSON 16: keep `electron`/`shell`/`app` OUT so it
// compiles + unit-tests under the DOM-less node tsconfig — the real `node:fs` seam is bound in main/ipc.ts).
// Gates ONLY the onboarding MOUNT (renderer first-run-gate), NEVER the WS-8 isolation predicate (LESSON 9).
//
// Deep contracts subpath (not the barrel) so the Electron-main bundle stays lean — the barrel drags the
// whole contracts graph (zod + ajv) into main (the 9.18 regression class; guarded by the main-bundle test).
import { ok, err } from "@sow/contracts/primitives/result";
import type { Result } from "@sow/contracts/primitives/result";

/** Read/write faults are INCONCLUSIVE (typed err ⇒ the renderer gate falls back to the registry). */
export type FirstRunFault = "read_fault" | "write_fault";

/** The marker read/write result. `ok(true)` = onboarding complete; `ok(false)` = absent/unset (first run). */
export type FirstRunStatus = Result<boolean, FirstRunFault>;

/** Injected fs seams so the module is node-testable with zero real fs. Real bindings live in ipc.ts. */
export interface FirstRunDeps {
  /** Whether the marker file exists (real `fs.existsSync`). */
  readonly fileExists: (path: string) => boolean;
  /** Read the marker file's text; throws on a genuine IO/permission fault (real `fs.readFileSync`). */
  readonly readFile: (path: string) => string;
  /** Write the marker file (real `fs.writeFileSync`). */
  readonly writeFile: (path: string, data: string) => void;
}

/** The single canonical marker body — a re-mark writes byte-identical content (idempotent). */
const MARKER_BODY = JSON.stringify({ onboardingComplete: true });

/**
 * Read the durable marker. ABSENT ⇒ `ok(false)` (genuine first run). PRESENT + valid ⇒ `ok(true)`. A
 * malformed / empty / wrong-shape / explicitly-false file ⇒ `ok(false)` (empty=unset hygiene, LESSON 15) —
 * distinguished from a genuine IO fault (permission/read throw) which is `err("read_fault")`. NEVER throws.
 */
export function readOnboardingComplete(path: string, deps: FirstRunDeps): FirstRunStatus {
  let raw: string;
  try {
    if (!deps.fileExists(path)) return ok(false); // conclusively absent — first run
    raw = deps.readFile(path);
  } catch {
    return err("read_fault"); // genuine IO/permission fault — INCONCLUSIVE (gate falls back to the registry)
  }
  // Present + read OK. Parse defensively: anything but a literal `onboardingComplete === true` reads as unset.
  try {
    const parsed: unknown = JSON.parse(raw);
    const complete =
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).onboardingComplete === true;
    return ok(complete);
  } catch {
    return ok(false); // malformed JSON present = unset (NOT a read fault)
  }
}

/** Write the durable completion marker idempotently (byte-identical overwrite). NEVER throws (§16). */
export function markOnboardingComplete(path: string, deps: FirstRunDeps): FirstRunStatus {
  try {
    deps.writeFile(path, MARKER_BODY);
    return ok(true);
  } catch {
    return err("write_fault");
  }
}
