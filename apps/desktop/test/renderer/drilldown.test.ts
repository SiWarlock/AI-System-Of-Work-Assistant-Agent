// §9.4 slice 5: the renderer drill-down caller. The renderer only REQUESTS — the
// worker enforces the visibility gate. A permitted drill yields workspace cards; a
// denial (err Result) or a transport error folds to { ok: false } so nothing raw is
// ever surfaced on a non-permitted drill.
import { describe, it, expect } from "vitest";
import { createDrillDown } from "../../renderer/lib/drilldown";

// A minimal fake tRPC client exposing only query.globalDrillDown.query.
function fakeClient(queryImpl: (input: unknown) => Promise<unknown>): never {
  return { query: { globalDrillDown: { query: queryImpl } } } as never;
}

describe("createDrillDown", () => {
  it("returns the workspace-scoped cards on a PERMITTED (ok) drill", async () => {
    const drill = createDrillDown(
      fakeClient(() => Promise.resolve({ ok: true, value: [{ cardId: "c1" }, { cardId: "c2" }] })),
    );
    const r = await drill("ws-employer", "calendar_busy");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cards.map((c) => c.cardId)).toEqual(["c1", "c2"]);
  });

  it("folds a DENIAL (err Result) to { ok: false } — no raw context surfaced", async () => {
    const drill = createDrillDown(
      fakeClient(() =>
        Promise.resolve({ ok: false, error: { kind: "validation_rejected", cause: { code: "DRILL_NOT_PERMITTED" } } }),
      ),
    );
    expect((await drill("ws-employer", "calendar_busy")).ok).toBe(false);
  });

  it("folds a thrown transport error to { ok: false } (fail closed)", async () => {
    const drill = createDrillDown(fakeClient(() => Promise.reject(new Error("socket down"))));
    expect((await drill("ws-employer", "calendar_busy")).ok).toBe(false);
  });

  it("folds a malformed ok-without-array to { ok: false }", async () => {
    const drill = createDrillDown(fakeClient(() => Promise.resolve({ ok: true, value: "not-an-array" })));
    expect((await drill("ws-employer", "calendar_busy")).ok).toBe(false);
  });
});
