// Phase-2 task 2.7 — App-version ↔ schema-version compatibility refusal (UNIT).
//
// ARCHITECTURE §4 (Operational Storage, failure modes): "record an app-version ↔
// schema-version compatibility check and refuse to run an incompatible pairing
// (NO silent forward-only break)." §13 restates the refusal; §16 mandates a typed
// result with explicit failure variants + actionable repair (nothing fails
// silently). This unit is the PURE, deterministic predicate behind that startup
// gate — no DB, no clock, no I/O.
//
// Coverage required by the brief: COMPATIBLE pairings + INCOMPATIBLE pairings +
// the TYPED repair-message shape. We also pin the headline invariant explicitly:
// a schema AHEAD of the app must REFUSE (never silently forward-run).
import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@sow/contracts";

import {
  assertSchemaCompatible,
  APP_SCHEMA_COMPAT_TABLE,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_COMPAT_REASONS,
  type AppSchemaCompat,
  type IncompatibleSchema,
} from "../../src/migrate/version-compat";

// A controlled compat table so every branch is exercised deterministically
// without fabricating future production rows. `min < target` opens a "behind but
// migratable" band that the real genesis table (target == min == 1) cannot show.
const TABLE: readonly AppSchemaCompat[] = [
  { appVersion: "1.0.0", targetSchemaVersion: 5, minReadableSchemaVersion: 3 },
];

describe("2.7 assertSchemaCompatible — compatible pairings", () => {
  it("schema exactly at the app's target → ok(void)", () => {
    const r = assertSchemaCompatible("1.0.0", 5, TABLE);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBeUndefined();
  });

  it("schema at the minimum readable version (behind but migratable) → ok", () => {
    expect(isOk(assertSchemaCompatible("1.0.0", 3, TABLE))).toBe(true);
  });

  it("schema between min and target → ok", () => {
    expect(isOk(assertSchemaCompatible("1.0.0", 4, TABLE))).toBe(true);
  });

  it("the table is self-consistent: the CURRENT (latest) app ↔ CURRENT_SCHEMA_VERSION is compatible", () => {
    expect(APP_SCHEMA_COMPAT_TABLE.length).toBeGreaterThan(0);
    // The CURRENT shipping app is the LAST row — genesis ([0]) targets an older schema, so as the schema
    // advances only the latest row is guaranteed compatible with CURRENT_SCHEMA_VERSION.
    const current = APP_SCHEMA_COMPAT_TABLE[APP_SCHEMA_COMPAT_TABLE.length - 1];
    expect(current).toBeDefined();
    if (!current) return;
    expect(current.targetSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(isOk(assertSchemaCompatible(current.appVersion, CURRENT_SCHEMA_VERSION))).toBe(true);
  });

  it("an OLD app opening a NEWER on-disk schema is REFUSED (schema_ahead_of_app) — additive col tolerated only via a new app", () => {
    // genesis app (targets v1) vs the current on-disk v2 → schema is ahead of the app → refuse (fail-closed).
    const genesis = APP_SCHEMA_COMPAT_TABLE[0];
    expect(genesis).toBeDefined();
    if (!genesis) return;
    expect(isOk(assertSchemaCompatible(genesis.appVersion, CURRENT_SCHEMA_VERSION))).toBe(false);
  });
});

describe("2.7 assertSchemaCompatible — incompatible pairings refuse", () => {
  it("schema AHEAD of the app REFUSES (no silent forward-only break) → schema_ahead_of_app", () => {
    const r = assertSchemaCompatible("1.0.0", 6, TABLE);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.reason).toBe("schema_ahead_of_app");
      // The repair must point at the forward-only-safe recovery paths.
      expect(r.error.repair.toLowerCase()).toMatch(/upgrade|restore|backup/);
    }
  });

  it("schema BELOW the minimum readable version → schema_below_minimum", () => {
    const r = assertSchemaCompatible("1.0.0", 2, TABLE);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("schema_below_minimum");
  });

  it("an app version not recorded in the table → unknown_app_version (fail-closed)", () => {
    const r = assertSchemaCompatible("9.9.9", 5, TABLE);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.reason).toBe("unknown_app_version");
      expect(r.error.targetSchemaVersion).toBeNull();
      expect(r.error.minReadableSchemaVersion).toBeNull();
    }
  });

  it("a missing/corrupt schema-version marker → schema_version_unreadable", () => {
    for (const bad of [Number.NaN, 1.5, -1]) {
      const r = assertSchemaCompatible("1.0.0", bad, TABLE);
      expect(isErr(r), `value=${bad}`).toBe(true);
      if (isErr(r)) expect(r.error.reason, `value=${bad}`).toBe("schema_version_unreadable");
    }
  });
});

describe("2.7 IncompatibleSchema — typed repair-message shape", () => {
  it("every refusal carries the full typed shape with a non-empty actionable repair", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["1.0.0", 6], // ahead
      ["1.0.0", 2], // below min
      ["9.9.9", 5], // unknown app
      ["1.0.0", Number.NaN], // unreadable marker
    ];
    for (const [app, schema] of cases) {
      const r = assertSchemaCompatible(app, schema, TABLE);
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) continue;
      const e: IncompatibleSchema = r.error;
      expect(e.kind).toBe("incompatible_schema");
      expect(SCHEMA_COMPAT_REASONS).toContain(e.reason);
      expect(e.appVersion).toBe(app);
      // schemaVersion is echoed verbatim (NaN echoes as NaN).
      if (Number.isNaN(schema)) expect(Number.isNaN(e.schemaVersion)).toBe(true);
      else expect(e.schemaVersion).toBe(schema);
      expect(typeof e.message).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
      expect(typeof e.repair).toBe("string");
      expect(e.repair.length).toBeGreaterThan(0);
      // target/min are numbers for a known app, null for an unknown one.
      for (const v of [e.targetSchemaVersion, e.minReadableSchemaVersion]) {
        expect(v === null || typeof v === "number").toBe(true);
      }
    }
  });

  it("is a pure function — identical inputs yield deeply-equal results", () => {
    expect(assertSchemaCompatible("1.0.0", 6, TABLE)).toStrictEqual(
      assertSchemaCompatible("1.0.0", 6, TABLE),
    );
    expect(assertSchemaCompatible("1.0.0", 5, TABLE)).toStrictEqual(
      assertSchemaCompatible("1.0.0", 5, TABLE),
    );
  });
});
