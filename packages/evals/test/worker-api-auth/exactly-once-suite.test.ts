// spec(§12) — APPROVAL EXACTLY-ONCE (cross-channel) §12 named suite runner spec
// (Task 8.7, REQ-F-012). Runs the exactly-once suite against the REAL 8.4 command
// router and asserts the DoD gate: a Mac + Telegram double-apply of the same
// decision collapses to EXACTLY ONE transition at the API boundary — one
// applied:true, one dispatch, one durable write. A single failing case fails it.
import { describe, it, expect } from "vitest";
import {
  runExactlyOnceSuite,
  EXACTLY_ONCE_SUITE_NAME,
} from "../../src/worker-api-auth/exactly-once-suite";

describe("§12 APPROVAL EXACTLY-ONCE suite — worker-api-auth.approval-exactly-once", () => {
  it("passes every case (the DoD gate for phase-exit 8)", async () => {
    const result = await runExactlyOnceSuite();
    const failed = result.cases.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail ?? ""}`);
    expect(failed, `failing cases:\n${failed.join("\n")}`).toEqual([]);
    expect(result.allPassed).toBe(true);
    expect(result.suite).toBe(EXACTLY_ONCE_SUITE_NAME);
  });

  it("collapses the cross-channel double-apply to exactly one transition + one dispatch", async () => {
    const result = await runExactlyOnceSuite();
    const byId = new Map(result.cases.map((c) => [c.id, c] as const));
    expect(byId.get("xchan.exactly-one-applied-flag")?.passed).toBe(true);
    expect(byId.get("xchan.one-durable-transition")?.passed).toBe(true);
    expect(byId.get("xchan.one-dispatch")?.passed).toBe(true);
  });

  it("holds exactly-once even under repeated cross-channel re-drive", async () => {
    const result = await runExactlyOnceSuite();
    const byId = new Map(result.cases.map((c) => [c.id, c] as const));
    expect(byId.get("xchan.replay-still-one-apply")?.passed).toBe(true);
  });
});
