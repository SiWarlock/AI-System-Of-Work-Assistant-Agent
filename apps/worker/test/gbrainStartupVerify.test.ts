// spec(§13, §16) — task 11.3-b: bootWorker's GBrain version-pin verify step. Wires the
// 11.3-a probe/composition into a boot-time, DEGRADED-SAFE step: load the pin, probe the
// running gbrain, delegate to verifyGbrainStartup, and on degrade surface the distinct
// version-pin HealthItem — NEVER throwing, NEVER blocking boot. Serving is a no-op here
// (write-through flip / serving-oracle stay HITL). Unit-tested with injected fakes.
import { describe, it, expect } from "vitest";
import type { HealthItem } from "@sow/contracts";
import type { GbrainVersionProbe } from "@sow/knowledge";
import { gbrainStartupVerify, type GbrainStartupVerifyDeps } from "../src/gbrainStartupVerify";

const SHA40 = "3933eb6a7915cb5495b8057b75567e2b1588b5ac";
const NOW = "2026-07-12T00:00:00.000Z";

// A valid `config/gbrain.pin` text (the real repo format), validatedOn a PENDING sentinel.
const PIN_TEXT = [
  `gbrain_sha            = ${SHA40}`,
  "gbrain_tag            = 0.35.1.0",
  "gbrain_repo           = https://github.com/garrytan/gbrain.git",
  "index_schema_ver      = 2",
  "write_through_enabled = false",
  "validated_on          = PENDING_PHASE12",
  "validation_ref        = docs/design/gbrain-write-through-divergence.md",
].join("\n");

// The same pin but LIVE-validated (validatedOn a real date) for the serving branch.
const PIN_TEXT_VALIDATED = PIN_TEXT.replace(
  "validated_on          = PENDING_PHASE12",
  "validated_on          = 2026-06-30",
);

function makeDeps(
  over: Partial<GbrainStartupVerifyDeps> & { readonly probe: GbrainVersionProbe },
): { deps: GbrainStartupVerifyDeps; surfaced: HealthItem[] } {
  const surfaced: HealthItem[] = [];
  const deps: GbrainStartupVerifyDeps = {
    readPinText: () => Promise.resolve(PIN_TEXT),
    surfaceHealth: (item) => {
      surfaced.push(item);
      return Promise.resolve();
    },
    now: () => NOW,
    auditRef: "audit-boot-gv",
    ...over,
  };
  return { deps, surfaced };
}

describe("gbrainStartupVerify — boot version-pin verify step (degraded-safe, never blocks boot)", () => {
  it("boot_verify_degrade_surfaces_health_item — an undefined probe ⇒ the distinct gbrain_unavailable version-pin HealthItem surfaces + no throw — spec(§13)", async () => {
    const { deps, surfaced } = makeDeps({ probe: () => Promise.resolve(undefined) });
    await expect(gbrainStartupVerify(deps)).resolves.toBeUndefined();
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.failureClass).toBe("connector_unreachable"); // gbrain_unavailable class
    expect(surfaced[0]?.id).toBe("gbrain-version-pin:gbrain_unavailable");
    expect(surfaced[0]?.openedAt).toBe(NOW);
    expect(surfaced[0]?.state).toBe("open");
  });

  it("boot_verify_degrade_on_sha_mismatch — a mismatched probe ⇒ the sha_mismatch version-pin HealthItem surfaces — spec(§13)", async () => {
    const { deps, surfaced } = makeDeps({
      probe: () => Promise.resolve({ sha: "ffffffffffffffffffffffffffffffffffffffff" }),
    });
    await gbrainStartupVerify(deps);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.failureClass).toBe("write_through_failed");
    expect(surfaced[0]?.id).toBe("gbrain-version-pin:sha_mismatch");
  });

  it("boot_verify_never_crashes_boot — a probe that THROWS is caught; the gbrain_unavailable item surfaces, no propagation — spec(§16)", async () => {
    const { deps, surfaced } = makeDeps({ probe: () => Promise.reject(new Error("boom")) });
    await expect(gbrainStartupVerify(deps)).resolves.toBeUndefined();
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.failureClass).toBe("connector_unreachable");
  });

  it("boot_verify_pin_load_failure_surfaces_and_continues — a pin read-throw / parse-failure ⇒ a distinct pin_load_failed item, no crash, verify NOT attempted — spec(§16)", async () => {
    let probeCalls = 0;
    const probe: GbrainVersionProbe = () => {
      probeCalls += 1;
      return Promise.resolve({ sha: SHA40 });
    };
    // (a) fs read throws
    const a = makeDeps({ probe, readPinText: () => Promise.reject(new Error("ENOENT")) });
    await expect(gbrainStartupVerify(a.deps)).resolves.toBeUndefined();
    expect(a.surfaced).toHaveLength(1);
    expect(a.surfaced[0]?.id).toBe("gbrain-version-pin:pin_load_failed");
    expect(a.surfaced[0]?.failureClass).toBe("write_through_failed");
    expect(a.surfaced[0]?.openedAt).toBe(NOW);
    expect(a.surfaced[0]?.state).toBe("open");
    // (b) unparseable text
    const b = makeDeps({ probe, readPinText: () => Promise.resolve("garbage with no equals sign") });
    await gbrainStartupVerify(b.deps);
    expect(b.surfaced[0]?.id).toBe("gbrain-version-pin:pin_load_failed");
    // verify (and thus the probe) is never attempted without a loaded pin.
    expect(probeCalls).toBe(0);
  });

  it("boot_verify_serving_does_not_flip_write_through — a matched sha + LIVE-validated pin ⇒ NO health item surfaced; the step carries NO write-through seam (serving stays HITL) — spec(§13)", async () => {
    const { deps, surfaced } = makeDeps({
      probe: () => Promise.resolve({ sha: SHA40, indexSchemaVersion: 2 }),
      readPinText: () => Promise.resolve(PIN_TEXT_VALIDATED),
    });
    await gbrainStartupVerify(deps);
    expect(surfaced).toHaveLength(0);
  });

  it("boot_verify_surface_fault_never_crashes — a surfaceHealth that THROWS is swallowed (a health-sink fault must not crash boot) — spec(§16)", async () => {
    const { deps } = makeDeps({
      probe: () => Promise.resolve(undefined),
      surfaceHealth: () => Promise.reject(new Error("store down")),
    });
    await expect(gbrainStartupVerify(deps)).resolves.toBeUndefined();
  });

  it("boot_verify_logs_serving_and_degrade_paths — an injected logger sees the serving info + the degrade warn events — spec(§16)", async () => {
    const events: string[] = [];
    const logger = {
      warn: (event: string) => events.push(`warn:${event}`),
      info: (event: string) => events.push(`info:${event}`),
    };
    // serving branch → an info log, no surfaced item.
    const s = makeDeps({
      probe: () => Promise.resolve({ sha: SHA40, indexSchemaVersion: 2 }),
      readPinText: () => Promise.resolve(PIN_TEXT_VALIDATED),
      logger,
    });
    await gbrainStartupVerify(s.deps);
    expect(s.surfaced).toHaveLength(0);
    expect(events).toContain("info:gbrain.version_pin.serving");
    // degrade branch → a warn log.
    events.length = 0;
    const d = makeDeps({ probe: () => Promise.resolve(undefined), logger });
    await gbrainStartupVerify(d.deps);
    expect(events).toContain("warn:gbrain.version_pin.degraded");
  });
});
