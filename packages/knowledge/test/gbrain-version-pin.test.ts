// spec(§6) — startup GBrain version-pin check: SHA/schema match enables the
// read/index surface; mismatch, schema drift, PENDING sentinel, or an
// unavailable gbrain fail CLOSED to read-only/index-only + a System-Health item.
import { describe, it, expect } from "vitest";
import type { GbrainPin, AuditId } from "@sow/contracts";
import { HealthItemSchema } from "@sow/contracts";
import {
  checkVersionPin,
  isPendingSentinel,
  type RunningGbrainVersion,
  type VersionPinContext,
} from "../src/gbrain/version-pin";

const SHA40 = "3933eb6a3933eb6a3933eb6a3933eb6a3933eb6a";

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
  now: () => "2026-07-01T00:00:00.000Z",
  auditRef: "audit-vp-1" as AuditId,
};

describe("checkVersionPin — serving (pin matches, LIVE-validated)", () => {
  it("full-SHA match + real validatedOn ⇒ serving; write-through NOT eligible when the gate is OFF", () => {
    const running: RunningGbrainVersion = { sha: SHA40, indexSchemaVersion: 2 };
    const r = checkVersionPin(makePin(), running, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe("serving");
    expect(r.value.pinnedSha).toBe(SHA40);
    expect(r.value.indexSchemaVersion).toBe(2);
    expect(r.value.writeThroughEligible).toBe(false);
  });

  it("write-through is eligible only when the per-workspace gate is ON and the pin is LIVE-validated", () => {
    const running: RunningGbrainVersion = { sha: SHA40 };
    const r = checkVersionPin(makePin({ writeThroughEnabled: true }), running, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.writeThroughEligible).toBe(true);
  });

  it("accepts an abbreviated running SHA that prefixes the pinned SHA", () => {
    const running: RunningGbrainVersion = { sha: "3933eb6a" };
    const r = checkVersionPin(makePin(), running, ctx);
    expect(r.ok).toBe(true);
  });

  it("skips schema comparison when the running build does not report a schema version", () => {
    const running: RunningGbrainVersion = { sha: SHA40 };
    const r = checkVersionPin(makePin({ indexSchemaVersion: 9 }), running, ctx);
    expect(r.ok).toBe(true);
  });
});

describe("checkVersionPin — degrade fail-closed (read-only/index-only + HealthItem)", () => {
  it("SHA mismatch ⇒ degraded, reason sha_mismatch, write_through_failed HealthItem", () => {
    const running: RunningGbrainVersion = { sha: "ffffffffffffffffffffffffffffffffffffffff" };
    const r = checkVersionPin(makePin(), running, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.mode).toBe("read_only_index_only");
    expect(r.error.reason).toBe("sha_mismatch");
    expect(r.error.healthItem.failureClass).toBe("write_through_failed");
    expect(r.error.healthItem.state).toBe("open");
    expect(r.error.healthItem.openedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(r.error.healthItem.auditRef).toBe("audit-vp-1");
  });

  it("an unavailable gbrain ⇒ degraded, reason gbrain_unavailable, connector_unreachable HealthItem", () => {
    const r = checkVersionPin(makePin(), undefined, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("gbrain_unavailable");
    expect(r.error.healthItem.failureClass).toBe("connector_unreachable");
  });

  it("a PENDING sentinel degrades even when the SHA matches (validation still owed)", () => {
    const running: RunningGbrainVersion = { sha: SHA40, indexSchemaVersion: 2 };
    const r = checkVersionPin(
      makePin({ validatedOn: "PENDING_PHASE12" }),
      running,
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("pending_validation");
    expect(r.error.healthItem.failureClass).toBe("write_through_failed");
  });

  it("an index-schema drift ⇒ degraded, reason index_schema_mismatch", () => {
    const running: RunningGbrainVersion = { sha: SHA40, indexSchemaVersion: 3 };
    const r = checkVersionPin(makePin({ indexSchemaVersion: 2 }), running, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("index_schema_mismatch");
  });

  it("emits a HealthItem that PASSES the frozen HealthItem contract schema", () => {
    const r = checkVersionPin(makePin(), undefined, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(() => HealthItemSchema.parse(r.error.healthItem)).not.toThrow();
  });
});

describe("isPendingSentinel", () => {
  it("recognizes the two spec sentinels and rejects a real ISO date", () => {
    expect(isPendingSentinel("PENDING_PHASE12")).toBe(true);
    expect(isPendingSentinel("PENDING_LIVE_VALIDATION")).toBe(true);
    expect(isPendingSentinel("2026-06-30")).toBe(false);
  });
});
