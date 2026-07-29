// Task 9.26 (desktop) — the Copilot answer read path re-validates the worker payload client-side.
//
// The renderer treats worker output as CANDIDATE DATA, not trusted output: `live.ts` re-gates four
// read paths through `safeParse` (approvals · ingestion · calendar · task-rollup). The Copilot answer
// path had ZERO — it checked only `res.value != null` and rendered a server-derived string verbatim.
//
// ⚠ NOT a live defect: the server-side `toUiSafeCopilotAnswer` gate is load-bearing BY DESIGN and
// still is. The value here is SYMMETRY — if that gate ever regressed, all four sibling paths would
// catch it and this one would not, on the single surface that renders a server string into the DOM.
//
// ⚠ Sibling-pattern ADAPTATION (worth stating, since "match the siblings" is the acceptance): the
// four siblings validate ARRAYS and drop the malformed ITEM while keeping the rest. An answer is a
// single object, so there is no per-item drop — the faithful analog is reject-the-whole-payload and
// fold to the existing `{ok:false}` → ASK_FAILED path. Same POSTURE (worker output is candidate
// data; a rejection never renders), different mechanics, because the shape differs.
import { describe, it, expect, vi } from "vitest";
import { UiSafeCopilotAnswerSchema } from "@sow/contracts/api/ui-safe";
import { createAskCopilot } from "../../renderer/lib/copilot-ask";

function fakeClient(copilotAsk: (input: unknown) => Promise<unknown>): never {
  return { query: { copilotAsk: { query: copilotAsk } } } as never;
}

const VALID = { answer: ["A cited answer."], citations: [{ citationId: "c1", title: "A source" }] };

describe("createAskCopilot — client-side re-validation (9.26)", () => {
  it("copilot_answer_is_revalidated_client_side — a schema-invalid payload folds to {ok:false}", async () => {
    // spec(§10) — worker output is candidate data to the renderer too. Each case is a DIFFERENT
    // way the strict schema can reject, so this fails if the re-gate is dropped OR weakened to a
    // shallow shape check (which is what `res.value != null` already was).
    const cases: readonly unknown[] = [
      { answer: [], citations: [] }, // .min(1) — an empty answer is not servable
      { answer: ["ok"], citations: [], extra: "smuggled" }, // .strict() — an unknown key
      { answer: ["ok"], citations: [], egressProcessor: "multi\nline" }, // uiSafeSummaryLine
      { answer: Array.from({ length: 41 }, () => "block"), citations: [] }, // .max(40) chunk-smuggle
      { answer: ["ok"], citations: [{ citationId: "c1" }] }, // a malformed citation
      { answer: "not an array", citations: [] }, // wrong type
    ];
    for (const value of cases) {
      const ask = createAskCopilot(fakeClient(() => Promise.resolve({ ok: true, value })));
      expect((await ask("ws", "q")).ok).toBe(false);
    }
  });

  it("a VALID answer still passes — the re-gate must not reject what the worker legitimately serves", async () => {
    // spec(§10) NON-VACUITY. A re-gate that rejects everything would also "never render a bad
    // answer", and would silently break the surface — the failure mode this pins against.
    const ask = createAskCopilot(fakeClient(() => Promise.resolve({ ok: true, value: VALID })));
    const r = await ask("ws", "q");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer.answer).toEqual(["A cited answer."]);
  });

  it("re_gate_never_over_rejects_producer_output — whatever the WORKER's gate emits, the renderer accepts", async () => {
    // spec(§10) — the sharpest failure mode for this slice, and it is NOT the one the feature is
    // about: an over-strict re-gate silently converts a WORKING answer into ASK_FAILED, which reads
    // as a worker fault and is HARDER to diagnose than having no re-gate at all, because the failure
    // looks legitimate.
    //
    // The fixture is NOT hand-built: `toUiSafeCopilotAnswer` serves exactly `parsed.data` from
    // `UiSafeCopilotAnswerSchema`, so parsing here reproduces the producer's own output shape —
    // by construction, not by my guess at what "valid" means. This pins the real risk (the renderer
    // gate diverging STRICTER than the producer gate); it fails the moment the renderer adds a
    // constraint the contract doesn't have.
    //
    // Driven at the CAP BOUNDARIES (max blocks / max citations / max-length single-line label),
    // because that is precisely where an over-strict re-gate bites first and a mid-sized fixture
    // would sail past.
    const atTheLimits = UiSafeCopilotAnswerSchema.parse({
      answer: Array.from({ length: 40 }, (_, i) => `block ${String(i)}`),
      citations: Array.from({ length: 20 }, (_, i) => ({ citationId: `c${String(i)}`, title: `source ${String(i)}` })),
      egressProcessor: "x".repeat(1024),
    });
    const ask = createAskCopilot(fakeClient(() => Promise.resolve({ ok: true, value: atTheLimits })));
    const r = await ask("ws", "q");
    expect(r.ok).toBe(true); // an ok:false here means the renderer is stricter than the producer
    if (r.ok) {
      expect(r.answer.answer).toHaveLength(40);
      expect(r.answer.citations).toHaveLength(20);
      expect(r.answer.egressProcessor).toHaveLength(1024); // the disclosure survives at the boundary
    }
  });

  it("a valid answer CARRYING the egress notice passes the re-gate with the label intact", async () => {
    // spec(§5) — the re-gate must not strip the disclosure it exists to protect (the 9.24 invariant:
    // a dropped notice would be indistinguishable from "nothing to disclose").
    const withNotice = { ...VALID, egressProcessor: "claude" };
    const ask = createAskCopilot(fakeClient(() => Promise.resolve({ ok: true, value: withNotice })));
    const r = await ask("ws", "q");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer.egressProcessor).toBe("claude");
  });

  it("a typed err / transport throw / null value still fold to {ok:false} (pre-existing, unchanged)", async () => {
    // spec(§16) — the re-gate is ADDITIVE; the existing fail-closed folds must survive it.
    const typedErr = createAskCopilot(fakeClient(() => Promise.resolve({ ok: false, error: { kind: "x" } })));
    expect((await typedErr("ws", "q")).ok).toBe(false);
    const thrown = createAskCopilot(fakeClient(() => Promise.reject(new Error("down"))));
    expect((await thrown("ws", "q")).ok).toBe(false);
    const nullValue = createAskCopilot(fakeClient(() => Promise.resolve({ ok: true, value: null })));
    expect((await nullValue("ws", "q")).ok).toBe(false);
  });
});
