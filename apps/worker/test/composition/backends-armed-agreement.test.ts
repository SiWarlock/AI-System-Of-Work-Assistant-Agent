// `isWriteTransportArmed` must never disagree with what `selectAdapterTransport` actually selects.
// Linear slice 3+4.
//
// ⛔ WHY: the Approvals-screen dispatch reads `writeArmedFor(system, workspace)` to decide whether to send or refuse as
// `writes_off`. If it said "armed" while the stub was selected, an approved card would be "sent" through the
// stub and recorded with a FABRICATED receipt, which the owner ruled out (2026-09-22). The two share their
// locks by value, not by reference (a source-scan test pins the locks inside `selectAdapterTransport`'s own
// body), so this test is what keeps them in step — malformed input included.
import { describe, it, expect } from "vitest";
import type { AdapterTransport } from "@sow/integrations";
import { writeArmedFor, isWriteTransportArmed, selectAdapterTransport, type WriteTransportGate } from "../../src/composition/backends";
import { TargetSystem } from "@sow/contracts";

const REAL: AdapterTransport = () => Promise.resolve({ ok: true, object: null });
const make = (): AdapterTransport => REAL;

const GATES: ReadonlyArray<readonly [string, WriteTransportGate | undefined]> = [
  ["unset", undefined],
  ["empty", {}],
  ["enabled without make", { enabled: true }],
  ["make without enabled", { make }],
  ["disabled with make", { enabled: false, make }],
  ["string 'true'", { enabled: "true" as unknown as boolean, make }],
  ["number 1", { enabled: 1 as unknown as boolean, make }],
  ["make not a function", { enabled: true, make: "x" as unknown as () => AdapterTransport }],
  ["armed", { enabled: true, make }],
];

describe("isWriteTransportArmed agrees with selectAdapterTransport on every gate shape", () => {
  for (const [name, gate] of GATES) {
    it(name, () => {
      const selectedReal = selectAdapterTransport(gate) === REAL;
      expect(isWriteTransportArmed(gate)).toBe(selectedReal);
    });
  }

  it("positive control: exactly one shape arms", () => {
    expect(GATES.filter(([, g]) => isWriteTransportArmed(g)).map(([n]) => n)).toEqual(["armed"]);
  });
});

describe("writeArmedFor — does THIS system in THIS workspace have a REAL sender (per system + per workspace)", () => {
  const WS = ["employer-work", "personal-life", "personal-business"];
  it("is false for everything whenever the gate does not arm, whatever it declares", () => {
    for (const [, gate] of GATES.filter(([n]) => n !== "armed")) {
      for (const t of TargetSystem) for (const w of WS) expect(writeArmedFor(gate)(t, w)).toBe(false);
    }
    expect(writeArmedFor({ enabled: false, make, targets: ["linear"], workspaces: ["employer-work"] })("linear", "employer-work")).toBe(false);
  });
  it("⛔ is exactly the declared systems AND workspaces when the gate declares them (the Linear gate declares both)", () => {
    const armed = writeArmedFor({ enabled: true, make, targets: ["linear"], workspaces: ["employer-work"] });
    expect(armed("linear", "employer-work")).toBe(true);
    expect(armed("linear", "personal-life")).toBe(false); // no key there: the card must wait, not be closed as rejected
    expect(armed("todoist", "employer-work")).toBe(false);
  });
  it("is every system in every workspace when an armed gate declares neither (a test's fake sender serves all)", () => {
    const armed = writeArmedFor({ enabled: true, make });
    for (const t of TargetSystem) for (const w of WS) expect(armed(t, w)).toBe(true);
  });
});
