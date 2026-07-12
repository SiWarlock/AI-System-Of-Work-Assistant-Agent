// GBrain startup version-pin VERIFICATION over a real LOCAL probe (§13, §12; task 11.3-a).
//
// Makes the startup version-pin check REAL: probes the running gbrain's self-report (via
// `gbrain doctor --json`, adapter in ./gbrain-version-probe) and delegates the decision to
// the ALREADY-BUILT pure `checkVersionPin` (./version-pin) — serving vs a fail-closed
// read-only/index-only degrade + a System Health item. This module is PURE (a fail-closed
// parser + an injected port + the composition); the real exec adapter is its sibling.
//
// Shape mirrors the install-doctor collectors (Lesson 19): a pure fail-closed mapper + an
// injected port + a thin LOCAL never-throwing adapter. LOCAL-ONLY.
//
// ⚠ IDENTITY-MODEL GAP (task 11.3-a Finding — deferred to the HITL `config/gbrain.pin`
// re-capture slice): gbrain 0.35.1.0 exposes NO commit SHA locally. `gbrain doctor --json`
// carries the index `schema_version` but no sha; `gbrain --version` reports the release TAG
// (a semver), not the 40-hex commit the pin stores. So against 0.35.1.0 this probe
// fail-closes to `gbrain_unavailable` (there is no running-SHA to match). The parser keys on
// candidate commit-sha fields so a FUTURE gbrain build that emits one works unchanged;
// reconciling the pin's SHA-vs-tag identity for real serving is an owner/HITL decision on
// the write-through path, NOT this slice. The SAME Finding covers the index-schema source:
// gbrain's doctor JSON has BOTH a top-level `schema_version` (which the current
// `config/gbrain.pin` stores as `index_schema_ver`, so we match it — avoiding a false
// `index_schema_mismatch`) AND a per-check `schema_version` reporting the DB/index migration
// version; which is the TRUE index-schema identity is confirmed at the HITL pin-recapture,
// not here.
import type { GbrainPin, Result } from "@sow/contracts";
import {
  checkVersionPin,
  type RunningGbrainVersion,
  type VersionPinContext,
  type VersionPinServing,
  type VersionPinDegraded,
} from "./version-pin";

/** Injected port: probes the running gbrain's self-reported version. `undefined` ⇒ gbrain
 *  unavailable / unreadable (fail-closed — the composition degrades). */
export type GbrainVersionProbe = () => Promise<RunningGbrainVersion | undefined>;

/** Candidate commit-SHA keys in a `gbrain doctor --json` payload, in priority order.
 *  gbrain 0.35.1.0 emits NONE of these (see the module Finding note); a future build that
 *  adds one is picked up with no code change. */
const SHA_KEYS = ["sha", "commit", "commit_sha", "git_sha", "revision"] as const;

/** A commit SHA is 7–64 hex chars (an abbreviated git SHA-1 through a full SHA-256). */
const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Best-effort extract the first valid JSON OBJECT from `stdout`: the whole trimmed string
 *  if it parses, else the last non-empty line that parses (defensive against a stderr-merged
 *  log preamble). Fail-closed to `undefined`; never throws. Linear scan (no ReDoS). NOTE: a
 *  PRETTY-PRINTED multi-line JSON body preceded by preamble is not reassembled (the last line
 *  is a lone `}`) — a documented bound, safe (fail-closed): gbrain emits compact single-line
 *  JSON on stdout (the preamble is stderr), so the whole-string parse is the real path. */
function extractJsonObject(stdout: string): Record<string, unknown> | undefined {
  const tryParse = (s: string): Record<string, unknown> | undefined => {
    try {
      const v: unknown = JSON.parse(s);
      return isPlainObject(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(stdout.trim());
  if (whole !== undefined) return whole;
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = tryParse(trimmed);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * PURE fail-closed parser: `gbrain doctor --json` stdout → RunningGbrainVersion | undefined.
 *
 * Returns `undefined` (NEVER throws) on non-JSON / non-object / absent-or-malformed sha /
 * present-but-malformed `schema_version` — a fail-closed "unavailable" that `checkVersionPin`
 * degrades (no fabricated version). `indexSchemaVersion` is read from the top-level
 * `schema_version` — the value the current `config/gbrain.pin` stores as `index_schema_ver`,
 * so matching against it avoids a false `index_schema_mismatch`. (The doctor JSON also carries
 * a per-check `schema_version` = the DB/index migration version, distinct from this top-level
 * field; which is the TRUE index-schema source is part of the deferred HITL pin-recapture
 * Finding — see the module header.) When absent it is omitted (optional — `checkVersionPin`
 * then skips the schema compare).
 */
export function parseGbrainDoctorJson(stdout: string): RunningGbrainVersion | undefined {
  const obj = extractJsonObject(stdout);
  if (obj === undefined) return undefined;

  // Required: a commit SHA. Absent/malformed ⇒ fail-closed undefined (never fabricate one).
  let sha: string | undefined;
  for (const k of SHA_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && COMMIT_SHA_RE.test(v)) {
      sha = v.toLowerCase();
      break;
    }
  }
  if (sha === undefined) return undefined;

  // Optional: the index schema_version. Absent ⇒ omit (checkVersionPin skips the compare);
  // PRESENT-but-not-a-nonneg-integer ⇒ fail-closed undefined (don't trust a malformed report).
  const rawSchema = obj["schema_version"];
  if (rawSchema === undefined) return { sha };
  if (typeof rawSchema === "number" && Number.isInteger(rawSchema) && rawSchema >= 0) {
    return { sha, indexSchemaVersion: rawSchema };
  }
  return undefined;
}

/** The composition's injected surroundings. */
export interface VerifyGbrainStartupDeps {
  /** The typed pin read from `config/gbrain.pin`. */
  readonly pin: GbrainPin;
  /** The running-version probe (fake in unit tests; real adapter in the gated test / boot). */
  readonly probe: GbrainVersionProbe;
  /** Injected clock + audit ref for the degradation HealthItem (no ambient clock enters). */
  readonly ctx: VersionPinContext;
}

/**
 * Verify the running gbrain against the pinned build: await the injected probe, then delegate
 * to the built pure `checkVersionPin`. NEVER throws (§16) — a thrown/rejected probe folds to
 * `undefined` ⇒ the `gbrain_unavailable` degrade. Does NOT re-implement the decision.
 */
export async function verifyGbrainStartup(
  deps: VerifyGbrainStartupDeps,
): Promise<Result<VersionPinServing, VersionPinDegraded>> {
  try {
    const running = await deps.probe();
    return checkVersionPin(deps.pin, running, deps.ctx);
  } catch {
    // A thrown/rejected probe — OR a type-violating probe whose pathological result trips the
    // decision core (e.g. a non-string sha reaching shaMatches) — is an unavailable gbrain;
    // fold to the fail-closed degrade. This totalizes the never-throw guarantee for ANY probe,
    // not just a type-conforming one (§16). `ctx` is trusted composition input, so the
    // re-invocation with `undefined` cannot itself throw here.
    return checkVersionPin(deps.pin, undefined, deps.ctx);
  }
}
