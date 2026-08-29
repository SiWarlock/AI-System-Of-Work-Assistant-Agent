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
 * A REAL local gbrain probe: `doctor --json` for the index schema (and a SHA if a future build
 * reports one), then `--version` for the build TAG. Fixed argv, `shell:false` (no injection
 * surface), bounded timeout + output cap; every fault (nonzero exit / ENOENT / timeout /
 * malformed output) folds to `undefined`. LOCAL-ONLY; never throws.
 *
 * ⛔ THE SECOND EXEC EXISTS BECAUSE `doctor --json` REPORTS NEITHER A SHA NOR A TAG (`### 24.142`,
 * measured against `gbrain 0.35.1.0`). `gbrain --version` is the only surface that reports a build
 * identity at all. The tag is a strictly WEAKER identity than a commit SHA and is consumed only
 * when the owner opts in via `VersionPinOptions.allowTagFallback`.
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
      const parsed = parseGbrainDoctorJson(stdout);
      if (parsed === undefined) return undefined;
      // ⭐ SECOND EXEC, and it is the PRODUCER half of `### 24.142` — without it the tag fallback
      // would be a consumer with nothing feeding it. `doctor --json` carries NO tag either
      // (measured: `{"schema_version":2,"status":…,"health_score":…,"checks":[…]}`), so the only
      // surface reporting a build identity at all is `gbrain --version` → `gbrain 0.35.1.0`.
      // ⚠ BEST-EFFORT BY DESIGN: a failing/absent `--version` omits `tag`, which makes the
      // fallback degrade — never a fabricated identity, and never a reason to discard the
      // doctor result we already have.
      if (parsed.tag !== undefined) return parsed;
      const tag = await probeTag(bin, timeout, maxBuffer);
      return tag === undefined ? parsed : { ...parsed, tag };
    } catch {
      // nonzero exit / ENOENT / timeout / maxBuffer overflow / any fault ⇒ fail-closed.
      return undefined;
    }
  };
}

/** `gbrain 0.35.1.0` → `"0.35.1.0"`. Anything else ⇒ `undefined` (never fabricate an identity). */
export function parseGbrainVersionLine(stdout: string): string | undefined {
  // Anchored and narrow on purpose: a build identity is exactly the kind of value that must not
  // be scavenged out of arbitrary output. Only the documented `gbrain <version>` line matches.
  const m = /^\s*gbrain\s+([0-9][0-9A-Za-z.\-+]*)\s*$/m.exec(stdout);
  return m?.[1];
}

/** Exec `gbrain --version`; every fault folds to `undefined`. Never throws. */
async function probeTag(
  bin: string,
  timeout: number,
  maxBuffer: number,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], {
      timeout,
      maxBuffer,
      shell: false,
      windowsHide: true,
    });
    return parseGbrainVersionLine(stdout);
  } catch {
    return undefined;
  }
}
