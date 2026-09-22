// bootWorker binds the REAL external-approval dispatcher, per system, in BOTH routing arms. Linear slice 3+4.
//
// ⛔ WHY (review 2026-09-22): nothing pinned the binding's arming input — binding every system as armed would
// have left the whole worker suite green while approved cards for unarmed systems went out through the stub
// or a refusing router. A full boot needs a live port (gated), so the binding is pinned on boot's own source,
// the idiom `proposeArmingStrictEquality.test.ts` already uses for boot's arming locks. The dispatcher's
// behaviour for each input is pinned in test/composition/externalApprovalDispatch.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOOT = readFileSync(join(__dirname, "..", "..", "src", "boot.ts"), "utf8");

function bindingBlock(): string {
  const start = BOOT.indexOf("createExternalApprovalDispatch({");
  expect(start).toBeGreaterThan(-1); // positive control: the binding exists
  return BOOT.slice(start, BOOT.indexOf("\n    }),", start));
}

describe("bootWorker's external-approval dispatch binding", () => {
  it("arms per system from the backends — never a constant, never a single yes/no", () => {
    const block = bindingBlock();
    expect(block).toContain("armedTargets: backends.armedTargets,");
    expect(block).not.toMatch(/armedTargets:\s*new Set/);
  });

  it("sends through the backends' own registry, outbox and receipt store", () => {
    const block = bindingBlock();
    for (const wired of [
      "outbox: backends.repos.outbox,",
      "writeAdapters: backends.writeAdapters,",
      "receiptStore: backends.receiptStore,",
      "workspaceConfig: backends.repos.workspaceConfig,",
    ]) {
      expect(block).toContain(wired);
    }
  });

  it("is used in BOTH routing arms (with and without the proof-spine path)", () => {
    expect(BOOT).toContain("external: externalApprovalDispatch,");
    expect(BOOT).toMatch(/:\s*externalApprovalDispatch;/);
  });
});
