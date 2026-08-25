// Task 11.3b — worker-side pin: `decideWriteThroughEnablement` has a REAL, non-test production
// caller (this module, wired from boot.ts) and the six refusals reach the OBSERVABLE surface
// (the structured logger) when nothing is provisioned. `bootWorker` itself is SOW_API-gated (it
// binds a real loopback port — see test/integration/boot-{provision,degraded}.test.ts) so this
// drives `enablementLegs.ts`'s exported composition directly, plus a source-anchored pin proving
// `boot.ts` genuinely wires it (mirrors the established pattern for an inline boot call site with
// no lightweight extracted seam — worker LESSONS.md #28).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { evaluateWriteThroughEnablement, surfaceEnablementDecision } from "../../src/composition/enablementLegs";

const SIX_LEGS = [
  "pin_not_validated",
  "divergence_not_clean",
  "conformance_not_green",
  "reindex_not_complete",
  "embedding_key_absent",
  "stray_writer_present",
] as const;

describe("the_gate_has_a_production_caller_and_its_refusals_are_surfaced", () => {
  it("evaluateWriteThroughEnablement({}) refuses all six legs, each with its own distinct reason", async () => {
    const decision = await evaluateWriteThroughEnablement({});
    expect(decision.enabled).toBe(false);
    expect(decision.refusals.map((r) => r.leg).sort()).toEqual([...SIX_LEGS].sort());
    const reasons = new Set(decision.refusals.map((r) => r.reason));
    expect(reasons.size).toBe(6); // no catch-all — six DISTINCT reasons
  });

  it("surfaceEnablementDecision logs the six refused legs through the injected logger (the observable surface)", async () => {
    const decision = await evaluateWriteThroughEnablement({});
    const calls: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    surfaceEnablementDecision(decision, {
      info: (event, meta) => {
        calls.push({ event, fields: meta?.fields });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toBe("gbrain.write_through_enablement.evaluated");
    expect(calls[0]?.fields?.enabled).toBe(false);
    expect(calls[0]?.fields?.refusedLegs).toEqual(expect.arrayContaining([...SIX_LEGS]));
    expect((calls[0]?.fields?.refusedLegs as string[]).length).toBe(6);
  });

  it("SOURCE-ANCHORED: boot.ts genuinely calls evaluateWriteThroughEnablement + surfaceEnablementDecision (never removed silently)", () => {
    const bootPath = fileURLToPath(new URL("../../src/boot.ts", import.meta.url));
    const source = readFileSync(bootPath, "utf8");
    expect(source).toMatch(/await evaluateWriteThroughEnablement\(\{\}\)/);
    expect(source).toMatch(/surfaceEnablementDecision\(\s*enablementDecision\s*,\s*backends\.logger\s*\)/);
  });
});

describe("zero-invocation pin — writeThroughEnabled is never SET by any code path this slice adds", () => {
  it("neither enablementLegs.ts nor its boot.ts wiring block ever assigns writeThroughEnabled", () => {
    const enablementLegsPath = fileURLToPath(new URL("../../src/composition/enablementLegs.ts", import.meta.url));
    const legProducersPath = fileURLToPath(
      new URL("../../../../packages/knowledge/src/gbrain/enablement/leg-producers.ts", import.meta.url),
    );
    // An ASSIGNMENT/property-key shape (`writeThroughEnabled:` or `writeThroughEnabled =`) — never a
    // bare-word match, which would also trip on this file's own documenting PROSE ("sets
    // `writeThroughEnabled`") that explains the invariant rather than violating it.
    const ASSIGNMENT_SHAPE = /writeThroughEnabled\s*[:=]/;
    for (const p of [enablementLegsPath, legProducersPath]) {
      const src = readFileSync(p, "utf8");
      expect(src).not.toMatch(ASSIGNMENT_SHAPE);
    }
    // The boot.ts task-11.3b block this slice adds — bounded by its own comment markers — never
    // sets writeThroughEnabled either (it only READS/OBSERVES, per the block's own header comment).
    const bootPath = fileURLToPath(new URL("../../src/boot.ts", import.meta.url));
    const bootSource = readFileSync(bootPath, "utf8");
    const startMarker = "// 1.03) task 11.3b";
    const start = bootSource.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    const end = bootSource.indexOf("// 1.05)", start);
    expect(end).toBeGreaterThan(start);
    const block = bootSource.slice(start, end);
    expect(block).not.toMatch(ASSIGNMENT_SHAPE);
  });
});
