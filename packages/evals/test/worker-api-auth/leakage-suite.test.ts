// spec(§12) — UI-SAFE LEAKAGE §12 named suite runner spec (Task 8.7 / WS-8). Runs
// the leakage suite against the REAL 8.2 projectors + 8.5 stream and asserts the
// DoD gate: driven with domain records carrying injected Keychain refs, provider
// prompts, AgentResult.logs, raw Employer-Work content, and secrets, NONE cross
// the field allowlist on either the query responses or the stream payloads. A
// single failing case fails the gate.
import { describe, it, expect } from "vitest";
import {
  runLeakageSuite,
  LEAKAGE_SUITE_NAME,
} from "../../src/worker-api-auth/leakage-suite";
import {
  ALL_SENTINELS,
  taintedApproval,
  findLeakedSentinel,
} from "../../src/worker-api-auth/fixtures";
import { toUiSafeApproval } from "@sow/worker/api/projections/uiSafe";

describe("§12 UI-SAFE LEAKAGE suite — worker-api-auth.ui-safe-leakage", () => {
  it("passes every case (the DoD gate for phase-exit 8)", () => {
    const result = runLeakageSuite();
    const failed = result.cases.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail ?? ""}`);
    expect(failed, `failing cases:\n${failed.join("\n")}`).toEqual([]);
    expect(result.allPassed).toBe(true);
    expect(result.suite).toBe(LEAKAGE_SUITE_NAME);
  });

  it("covers BOTH the query-response surface AND the stream surface for all 4 classes", () => {
    const result = runLeakageSuite();
    const ids = result.cases.map((c) => c.id);
    // Query (projector) surface.
    for (const kind of ["approval", "health", "workflow", "dashboard"]) {
      expect(ids.some((id) => id.startsWith(`leak.query.${kind}.`))).toBe(true);
    }
    // Stream surface (all 4 event classes) + the strict-schema re-validation.
    for (const name of ["workflow.status", "approval.update", "system.health", "read_model.change"]) {
      expect(ids.some((id) => id.startsWith(`leak.stream.${name}.`))).toBe(true);
      expect(ids).toContain(`leak.stream.${name}.schema-strict`);
    }
  });

  it("the tainted fixtures REALLY carry the 5 sentinel classes (the suite is not vacuous)", () => {
    // Guard: the tainted record itself must contain every sentinel — else the
    // leakage checks would pass trivially against a clean record.
    const taintedJson = JSON.stringify(taintedApproval());
    for (const s of ALL_SENTINELS) {
      expect(taintedJson).toContain(s);
    }
  });

  it("RED control: the leak scanner catches a deliberately-broken (spread) projector", () => {
    // A broken projector that spreads the whole record WOULD leak the sentinels —
    // proving the scanner (and therefore the suite) can actually FAIL, not just
    // rubber-stamp. The REAL projector below is clean; the broken one is not.
    const brokenSpread = (r: object): object => ({ ...r });
    const tainted = taintedApproval();
    expect(findLeakedSentinel(brokenSpread(tainted))).toBeDefined();
    // The REAL projector drops every sentinel.
    expect(findLeakedSentinel(toUiSafeApproval(tainted))).toBeUndefined();
  });
});
