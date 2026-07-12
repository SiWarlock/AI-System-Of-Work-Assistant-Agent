// spec(§13, §12) — task 11.3-a: make the GBrain startup version-pin check REAL over a
// LOCAL probe. `parseGbrainDoctorJson` (pure fail-closed parser of `gbrain doctor --json`),
// the `GbrainVersionProbe` injected port, and `verifyGbrainStartup` (awaits the probe →
// delegates to the ALREADY-BUILT pure `checkVersionPin`, never-throws). Option-A Finding:
// gbrain 0.35.1.0 exposes NO commit sha locally, so the real-machine outcome is a fail-closed
// DEGRADE (gbrain_unavailable) — the parser keys on candidate sha fields so a future build
// that emits one works unchanged.
import { describe, it, expect } from "vitest";
import type { GbrainPin, AuditId } from "@sow/contracts";
import { HealthItemSchema } from "@sow/contracts";
import {
  parseGbrainDoctorJson,
  verifyGbrainStartup,
  type GbrainVersionProbe,
} from "../src/gbrain/startup-verify";
import { createGbrainVersionProbe } from "../src/gbrain/gbrain-version-probe";
import type { RunningGbrainVersion, VersionPinContext } from "../src/gbrain/version-pin";

const SHA40 = "3933eb6a7915cb5495b8057b75567e2b1588b5ac";

function makePin(overrides: Partial<GbrainPin> = {}): GbrainPin {
  return {
    gbrainSha: SHA40,
    gbrainTag: "0.35.1.0",
    gbrainRepo: "https://github.com/example/gbrain",
    indexSchemaVersion: 2,
    validatedOn: "2026-06-30",
    validationRef: "docs/design/gbrain-write-through-divergence.md",
    writeThroughEnabled: false,
    ...overrides,
  };
}

const ctx: VersionPinContext = {
  now: () => "2026-07-12T00:00:00.000Z",
  auditRef: "audit-gv-1" as AuditId,
};

// The REAL `gbrain doctor --json` shape on 0.35.1.0 (top-level schema_version + checks[],
// NO commit sha anywhere; the index version rides `schema_version`). Trimmed to two checks.
const REAL_DOCTOR_JSON_0_35_1_0 = JSON.stringify({
  schema_version: 2,
  status: "warnings",
  health_score: 80,
  checks: [
    { name: "schema_version", status: "ok", message: "Version 66 (latest: 66)" },
    { name: "connection", status: "ok", message: "Connected, 98 pages" },
  ],
});

describe("parseGbrainDoctorJson — pure fail-closed parser of untrusted subprocess output", () => {
  it("parse_real_doctor_json_no_sha_is_undefined — the REAL gbrain 0.35.1.0 doctor --json (schema_version + checks, NO commit sha) → undefined (fail-closed; no local running-SHA source) — spec(§13)", () => {
    expect(parseGbrainDoctorJson(REAL_DOCTOR_JSON_0_35_1_0)).toBeUndefined();
  });

  it("parse_synthetic_doctor_json_with_sha — an EXPLICITLY-SYNTHETIC doctor --json carrying a commit-sha field (intended/future shape; 0.35.1.0 emits none) → { sha, indexSchemaVersion } — spec(§13)", () => {
    const synthetic = JSON.stringify({ schema_version: 2, sha: SHA40, status: "ok", checks: [] });
    expect(parseGbrainDoctorJson(synthetic)).toEqual({ sha: SHA40, indexSchemaVersion: 2 });
  });

  it("parse_sha_without_schema_version → { sha } only (indexSchemaVersion is optional/omitted) — spec(§13)", () => {
    expect(parseGbrainDoctorJson(JSON.stringify({ commit: SHA40 }))).toEqual({ sha: SHA40 });
  });

  it("parse_normalizes_sha_to_lowercase + accepts an abbreviated (≥7-hex) sha — spec(§13)", () => {
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: "3933EB6A" }))).toEqual({ sha: "3933eb6a" });
  });

  it("parse_malformed_or_missing_sha_is_undefined — non-JSON / {} / wrong-type / non-hex / array / present-but-malformed schema_version → undefined, never throws — spec(§13)", () => {
    expect(parseGbrainDoctorJson("not json at all")).toBeUndefined();
    expect(parseGbrainDoctorJson("")).toBeUndefined();
    expect(parseGbrainDoctorJson("{}")).toBeUndefined();
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: 12345, schema_version: 2 }))).toBeUndefined(); // wrong-type sha
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: "nothex!!", schema_version: 2 }))).toBeUndefined(); // non-hex sha
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: "abc" }))).toBeUndefined(); // too short (<7)
    expect(parseGbrainDoctorJson(JSON.stringify([1, 2, 3]))).toBeUndefined(); // array, not an object
    expect(parseGbrainDoctorJson("null")).toBeUndefined();
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: SHA40, schema_version: "two" }))).toBeUndefined(); // present-but-malformed schema
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: SHA40, schema_version: -1 }))).toBeUndefined(); // negative schema
  });

  it("parse_hex_length_fence_and_edge_inputs — 7-hex (min) + 64-hex (max) accept, 65-hex rejects; whitespace-only / CRLF-preamble / non-integer schema handled — spec(§13)", () => {
    const hex64 = "a".repeat(64);
    const hex65 = "a".repeat(65);
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: "abc1234" }))).toEqual({ sha: "abc1234" }); // exactly 7
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: hex64 }))).toEqual({ sha: hex64 }); // exactly 64
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: hex65 }))).toBeUndefined(); // 65 > max ⇒ fail-closed
    expect(parseGbrainDoctorJson("   ")).toBeUndefined(); // whitespace-only
    expect(parseGbrainDoctorJson(`[doctor] log\r\n${JSON.stringify({ sha: SHA40, schema_version: 2 })}`)).toEqual({
      sha: SHA40,
      indexSchemaVersion: 2,
    }); // CRLF-separated preamble
    expect(parseGbrainDoctorJson(JSON.stringify({ sha: SHA40, schema_version: 2.5 }))).toBeUndefined(); // non-integer schema
  });

  it("parse_tolerates_stderr_merged_log_preamble — a JSON object on the LAST line after non-JSON log lines still parses (defensive) — spec(§13)", () => {
    const withPreamble = `[doctor.db_checks] start\n[doctor.db_checks] done\n${JSON.stringify({ sha: SHA40, schema_version: 2 })}`;
    expect(parseGbrainDoctorJson(withPreamble)).toEqual({ sha: SHA40, indexSchemaVersion: 2 });
  });
});

describe("verifyGbrainStartup — composition over the built pure checkVersionPin (never-throws)", () => {
  it("verify_serving_on_matched_pin — an injected probe returning a matching sha + a LIVE-validated pin → serving (writeThroughEligible = pin.writeThroughEnabled) — spec(§13)", async () => {
    const probe: GbrainVersionProbe = () => Promise.resolve({ sha: SHA40, indexSchemaVersion: 2 });
    const r = await verifyGbrainStartup({ pin: makePin(), probe, ctx });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe("serving");
    expect(r.value.pinnedSha).toBe(SHA40);
    expect(r.value.indexSchemaVersion).toBe(2);
    expect(r.value.writeThroughEligible).toBe(false);

    const rOn = await verifyGbrainStartup({ pin: makePin({ writeThroughEnabled: true }), probe, ctx });
    expect(rOn.ok && rOn.value.writeThroughEligible).toBe(true);
  });

  it("verify_degrades_on_mismatch_and_unavailable — mismatched sha → sha_mismatch; undefined probe → gbrain_unavailable; each carries the distinct HealthItem — spec(§13)", async () => {
    const mismatch = await verifyGbrainStartup({
      pin: makePin(),
      probe: () => Promise.resolve({ sha: "ffffffffffffffffffffffffffffffffffffffff" }),
      ctx,
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.error.reason).toBe("sha_mismatch");
    expect(mismatch.error.healthItem.failureClass).toBe("write_through_failed");

    const unavail = await verifyGbrainStartup({ pin: makePin(), probe: () => Promise.resolve(undefined), ctx });
    expect(unavail.ok).toBe(false);
    if (unavail.ok) return;
    expect(unavail.error.reason).toBe("gbrain_unavailable");
    expect(unavail.error.healthItem.failureClass).toBe("connector_unreachable");
    expect(() => HealthItemSchema.parse(unavail.error.healthItem)).not.toThrow();
  });

  it("verify_never_throws_on_thrown_probe — a probe that REJECTS or throws SYNCHRONOUSLY folds to the gbrain_unavailable degrade, never throws (§16) — spec(§13)", async () => {
    const rejects: GbrainVersionProbe = () => Promise.reject(new Error("boom"));
    const rr = await verifyGbrainStartup({ pin: makePin(), probe: rejects, ctx });
    expect(rr.ok).toBe(false);
    if (rr.ok) return;
    expect(rr.error.reason).toBe("gbrain_unavailable");

    const syncThrow = (() => {
      throw new Error("sync");
    }) as GbrainVersionProbe;
    const rs = await verifyGbrainStartup({ pin: makePin(), probe: syncThrow, ctx });
    expect(rs.ok).toBe(false);
    if (rs.ok) return;
    expect(rs.error.reason).toBe("gbrain_unavailable");

    // A type-violating probe that RESOLVES a pathological object (non-string sha) also folds to
    // the degrade — the never-throw guarantee is TOTAL for any probe, not just a conforming one.
    const pathological = (() =>
      Promise.resolve({ sha: 42 } as unknown as RunningGbrainVersion)) as GbrainVersionProbe;
    const rp = await verifyGbrainStartup({ pin: makePin(), probe: pathological, ctx });
    expect(rp.ok).toBe(false);
    if (rp.ok) return;
    expect(rp.error.reason).toBe("gbrain_unavailable");
  });
});

// Gated real-adapter case — only runs under SOW_GBRAIN_REAL=1 (a dev machine with gbrain).
// The default suite NEVER shells out. A PENDING/degrade outcome is EXPECTED (0.35.1.0 exposes
// no commit sha ⇒ gbrain_unavailable) — asserted well-formed, NOT serving.
const REAL_GBRAIN = process.env.SOW_GBRAIN_REAL === "1";
describe("createGbrainVersionProbe — real LOCAL gbrain doctor --json adapter (gated)", () => {
  (REAL_GBRAIN ? it : it.skip)("real_gbrain_version_probe — the real adapter yields a well-formed DEGRADE (never a fabricated serving) on this machine — spec(§13)", async () => {
    const probe = createGbrainVersionProbe();
    const r = await verifyGbrainStartup({ pin: makePin({ validatedOn: "PENDING_PHASE12" }), probe, ctx });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(["gbrain_unavailable", "sha_mismatch", "pending_validation", "index_schema_mismatch"]).toContain(
      r.error.reason,
    );
    expect(() => HealthItemSchema.parse(r.error.healthItem)).not.toThrow();
  });
});
