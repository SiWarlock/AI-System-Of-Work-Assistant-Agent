// Real LOCAL gbrain-version probe adapter (§13; task 11.3-a).
//
// The concrete `GbrainVersionProbe` behind the pure composition: execs `gbrain doctor --json`
// with a fixed argv ARRAY (NO shell), a bounded timeout + output cap, and maps stdout through
// the pure `parseGbrainDoctorJson`. LOCAL-ONLY (a local CLI read, no network) and NEVER throws
// — a nonzero exit / ENOENT / timeout / maxBuffer-overflow / malformed output all fail closed
// to `undefined` (which the composition degrades to read-only/index-only).
//
// Mirrors the install-doctor exec-safety (Lesson 19: fixed argv, `shell:false`, timeout+cap,
// errno-only — no raw stderr / path leak) WITHOUT importing it: `packages/knowledge` is
// UPSTREAM of `apps/worker` in the layer DAG (knowledge → policy → {domain,contracts}), so
// reusing the worker's `RunCommand`/`createLocalCommandRunner` would invert the dependency.
//
// `gbrain` stays a BARE (PATH-resolved) bin — it is the user's installed CLI (e.g. under a
// bun/npm prefix), not a fixed-location system tool; absolutizing would miss it (Lesson 19
// version-presence rationale). A PATH-shadowed gbrain can only DEGRADE here (the probe
// fail-closes, and the pin — not the probe — holds `validatedOn`), never fabricate serving.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseGbrainDoctorJson, type GbrainVersionProbe } from "./startup-verify";

const execFileAsync = promisify(execFile);

/** Default probe timeout (ms): `gbrain doctor` runs several local DB checks — allow headroom. */
export const DEFAULT_GBRAIN_PROBE_TIMEOUT_MS = 15_000;
/** Default stdout cap (bytes): the doctor JSON is small; cap defensively. */
export const DEFAULT_GBRAIN_PROBE_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * A REAL local `gbrain doctor --json` probe. Fixed argv, `shell:false` (no injection surface),
 * bounded timeout + output cap; every fault (nonzero exit / ENOENT / timeout / malformed
 * output) folds to `undefined`. LOCAL-ONLY; never throws.
 */
export function createGbrainVersionProbe(opts?: {
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  /** Override the bin (tests / a non-default install path); defaults to the bare `gbrain`. */
  readonly gbrainBin?: string;
}): GbrainVersionProbe {
  const timeout = opts?.timeoutMs ?? DEFAULT_GBRAIN_PROBE_TIMEOUT_MS;
  const maxBuffer = opts?.maxBufferBytes ?? DEFAULT_GBRAIN_PROBE_MAX_BUFFER;
  const bin = opts?.gbrainBin ?? "gbrain";
  return async () => {
    try {
      const { stdout } = await execFileAsync(bin, ["doctor", "--json"], {
        timeout,
        maxBuffer,
        shell: false,
        windowsHide: true,
      });
      return parseGbrainDoctorJson(stdout);
    } catch {
      // nonzero exit / ENOENT / timeout / maxBuffer overflow / any fault ⇒ fail-closed.
      return undefined;
    }
  };
}
