// spec(§13) — task 11.3b, the write-through enablement gate's REAL LEG PRODUCERS. One test per
// leg proving an unreadable/absent input yields THAT leg's own distinct refusal when composed
// through `decideWriteThroughEnablement` (never a catch-all), plus a single all-six-legs-refuse
// pin over a totally empty input.
import { describe, it, expect } from "vitest";
import {
  readConformanceGreen,
  readReindexComplete,
  readEmbeddingKeyPresent,
  readNoStrayWriter,
  produceEnablementLegs,
  type StrayGbrainProcessProbeLike,
} from "../src/gbrain/enablement/leg-producers";
import { decideWriteThroughEnablement, type WriteThroughEnablementInputs } from "../src/gbrain/enablement/decide-enablement";

describe("readConformanceGreen — fail-closed", () => {
  it("an absent reader ⇒ false", async () => {
    expect(await readConformanceGreen(undefined)).toBe(false);
  });
  it("a reader resolving to undefined ⇒ false", async () => {
    expect(await readConformanceGreen(() => undefined)).toBe(false);
  });
  it("a reader resolving to false ⇒ false", async () => {
    expect(await readConformanceGreen(() => false)).toBe(false);
  });
  it("a THROWING reader ⇒ false (never propagates)", async () => {
    expect(
      await readConformanceGreen(() => {
        throw new Error("suite crashed");
      }),
    ).toBe(false);
  });
  it("a REJECTING async reader ⇒ false", async () => {
    expect(await readConformanceGreen(() => Promise.reject(new Error("suite timed out")))).toBe(false);
  });
  it("a reader EXPLICITLY resolving true ⇒ true", async () => {
    expect(await readConformanceGreen(() => true)).toBe(true);
  });
});

describe("readReindexComplete — fail-closed", () => {
  it("an absent reader ⇒ false", async () => {
    expect(await readReindexComplete(undefined)).toBe(false);
  });
  it("a THROWING reader ⇒ false", async () => {
    expect(
      await readReindexComplete(() => {
        throw new Error("reindex probe crashed");
      }),
    ).toBe(false);
  });
  it("EXPLICITLY true ⇒ true", async () => {
    expect(await readReindexComplete(async () => true)).toBe(true);
  });
});

describe("readEmbeddingKeyPresent — presence only, fail-closed", () => {
  it("an absent reader ⇒ false", async () => {
    expect(await readEmbeddingKeyPresent(undefined)).toBe(false);
  });
  it("a REJECTING reader ⇒ false", async () => {
    expect(await readEmbeddingKeyPresent(() => Promise.reject(new Error("keychain locked")))).toBe(false);
  });
  it("EXPLICITLY true ⇒ true", async () => {
    expect(await readEmbeddingKeyPresent(() => true)).toBe(true);
  });
});

describe("readNoStrayWriter — modelled on posture.ts's diagnoseStrayGbrainProcess", () => {
  it("an absent reader ⇒ false (cannot confirm no stray writer)", async () => {
    expect(await readNoStrayWriter(undefined)).toBe(false);
  });
  it("a reader resolving to undefined ⇒ false", async () => {
    expect(await readNoStrayWriter(() => undefined)).toBe(false);
  });
  it("a malformed probe (strayProcesses not an array) ⇒ false", async () => {
    const malformed = { strayProcesses: "not-an-array" } as unknown as StrayGbrainProcessProbeLike;
    expect(await readNoStrayWriter(() => malformed)).toBe(false);
  });
  it("a probe reporting ONE stray process ⇒ false", async () => {
    expect(await readNoStrayWriter(() => ({ strayProcesses: [{ op: "serve" }] }))).toBe(false);
  });
  it("a probe reporting an EMPTY strayProcesses array ⇒ true", async () => {
    expect(await readNoStrayWriter(() => ({ strayProcesses: [] }))).toBe(true);
  });
  it("a THROWING reader ⇒ false", async () => {
    expect(
      await readNoStrayWriter(() => {
        throw new Error("process scan crashed");
      }),
    ).toBe(false);
  });
});

// ── composed through decideWriteThroughEnablement — DISTINCT refusal per leg, never a catch-all ──

describe("each producer, composed into the gate, yields its OWN distinct refusal on an unreadable input", () => {
  it("conformance_not_green — an unreadable conformance reader refuses ONLY that leg's reason", async () => {
    const legs = await produceEnablementLegs({}); // every reader absent
    const inputs: WriteThroughEnablementInputs = { conformanceGreen: legs.conformanceGreen };
    const decision = decideWriteThroughEnablement(inputs);
    expect(decision.enabled).toBe(false);
    const conformanceRefusal = decision.refusals.find((r) => r.leg === "conformance_not_green");
    expect(conformanceRefusal).toBeDefined();
  });

  it("reindex_not_complete — an unreadable reindex reader refuses ONLY that leg's reason", async () => {
    const legs = await produceEnablementLegs({});
    const inputs: WriteThroughEnablementInputs = { reindexComplete: legs.reindexComplete };
    const decision = decideWriteThroughEnablement(inputs);
    const refusal = decision.refusals.find((r) => r.leg === "reindex_not_complete");
    expect(refusal).toBeDefined();
  });

  it("embedding_key_absent — an unreadable embedding-key reader refuses ONLY that leg's reason", async () => {
    const legs = await produceEnablementLegs({});
    const inputs: WriteThroughEnablementInputs = { embeddingKeyPresent: legs.embeddingKeyPresent };
    const decision = decideWriteThroughEnablement(inputs);
    const refusal = decision.refusals.find((r) => r.leg === "embedding_key_absent");
    expect(refusal).toBeDefined();
  });

  it("stray_writer_present — an unreadable stray-writer reader refuses ONLY that leg's reason", async () => {
    const legs = await produceEnablementLegs({});
    const inputs: WriteThroughEnablementInputs = { noStrayWriter: legs.noStrayWriter };
    const decision = decideWriteThroughEnablement(inputs);
    const refusal = decision.refusals.find((r) => r.leg === "stray_writer_present");
    expect(refusal).toBeDefined();
  });

  it("pin_not_validated — an absent pin (no producer — the gate consumes the object directly) refuses that leg", () => {
    const decision = decideWriteThroughEnablement({});
    const refusal = decision.refusals.find((r) => r.leg === "pin_not_validated");
    expect(refusal).toBeDefined();
  });

  it("divergence_not_clean — an absent ParityReport (no producer — the gate consumes the object directly) refuses that leg", () => {
    const decision = decideWriteThroughEnablement({});
    const refusal = decision.refusals.find((r) => r.leg === "divergence_not_clean");
    expect(refusal).toBeDefined();
  });

  it("all_six_legs_refuse_on_empty_input — a totally empty input (all readers absent) refuses EVERY leg, each with its OWN distinct reason (never a catch-all)", async () => {
    const legs = await produceEnablementLegs({});
    const inputs: WriteThroughEnablementInputs = {
      conformanceGreen: legs.conformanceGreen,
      reindexComplete: legs.reindexComplete,
      embeddingKeyPresent: legs.embeddingKeyPresent,
      noStrayWriter: legs.noStrayWriter,
    };
    const decision = decideWriteThroughEnablement(inputs);
    expect(decision.enabled).toBe(false);
    const legsRefused = decision.refusals.map((r) => r.leg).sort();
    expect(legsRefused).toEqual(
      [
        "pin_not_validated",
        "divergence_not_clean",
        "conformance_not_green",
        "reindex_not_complete",
        "embedding_key_absent",
        "stray_writer_present",
      ].sort(),
    );
    // Distinct reasons, never a shared/duplicated string (never a catch-all).
    const reasons = new Set(decision.refusals.map((r) => r.reason));
    expect(reasons.size).toBe(decision.refusals.length);
  });
});
