// §9.7 triage-resolution ACTION UI — the renderer triage-disposition caller. The renderer
// only REQUESTS a disposition — the worker (`command.disposeTriage`) re-enters the ingestion
// pipeline REUSING the caller's idempotencyKey (replay-safe, ING-4); the pipeline (via
// TriagePort) is the only writer. This wrapper mints a DETERMINISTIC idempotency key per
// (sourceId, disposition) so a double-click / retry lands the SAME key → one effect, returns
// the reused key on ok, and folds a typed err OR any transport error to `{ ok: false }` so a
// failed disposition surfaces nothing (fail-closed, §16 never-throw at the UI boundary).
import { describe, it, expect, vi } from "vitest";
import { createTriageDisposition, triageIdempotencyKey } from "../../renderer/lib/triage-disposition";

// A minimal fake tRPC client exposing only command.disposeTriage.mutate.
function fakeClient(mutateImpl: (input: unknown) => Promise<unknown>): never {
  return { command: { disposeTriage: { mutate: mutateImpl } } } as never;
}

describe("createTriageDisposition", () => {
  it("dispose_calls_mutation_with_stable_key — sends {sourceId, deterministic key, disposition} (ING-4)", async () => {
    // spec(§10) command.disposeTriage input; the key is caller-minted + stable (9.7 replay-safe re-entry).
    const mutate = vi.fn(() => Promise.resolve({ ok: true, value: { idempotencyKey: "src_1:accept" } }));
    const dispose = createTriageDisposition(fakeClient(mutate));
    await dispose("src_1", "accept");
    expect(mutate).toHaveBeenCalledWith({
      sourceId: "src_1",
      idempotencyKey: triageIdempotencyKey("src_1", "accept"),
      disposition: "accept",
    });
    // The minted key is the deterministic (sourceId, disposition) join — not a fresh-per-click value.
    expect(triageIdempotencyKey("src_1", "accept")).toBe("src_1:accept");
  });

  it("dispose_same_input_same_key — two calls with the same (sourceId, disposition) reuse ONE key (ING-4)", async () => {
    // spec(ING-4) double-click / cross-channel replay → the SAME key → the pipeline dedupes to one effect.
    const keys: unknown[] = [];
    const mutate = vi.fn((input: unknown) => {
      keys.push((input as { idempotencyKey: string }).idempotencyKey);
      return Promise.resolve({ ok: true, value: { idempotencyKey: "src_1:accept" } });
    });
    const dispose = createTriageDisposition(fakeClient(mutate));
    await dispose("src_1", "accept");
    await dispose("src_1", "accept");
    expect(keys[0]).toBe(keys[1]);
    // A DIFFERENT disposition on the same source mints a DISTINCT key (re-dispositionable → new dispatch).
    expect(triageIdempotencyKey("src_1", "accept")).not.toBe(triageIdempotencyKey("src_1", "reject"));
  });

  it("dispose_ok_returns_key — a well-formed ok folds to { ok: true, idempotencyKey } (the drain signal)", async () => {
    // spec(§11) the ok result is what tells the surface to drain the disposed item.
    const dispose = createTriageDisposition(
      fakeClient(() => Promise.resolve({ ok: true, value: { idempotencyKey: "src_1:reject" } })),
    );
    const r = await dispose("src_1", "reject");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idempotencyKey).toBe("src_1:reject");
  });

  it("dispose_typed_err_fails_closed — a typed err Result folds to { ok: false }", async () => {
    // spec(§16) a failed disposition surfaces nothing (mirror approval-decision fail-closed).
    const dispose = createTriageDisposition(
      fakeClient(() => Promise.resolve({ ok: false, error: { kind: "degraded_unavailable", message: "down", retryable: true } })),
    );
    expect((await dispose("src_1", "accept")).ok).toBe(false);
  });

  it("dispose_transport_throw_fails_closed — a thrown transport error folds to { ok: false }", async () => {
    // spec(§16) never-throw at the UI boundary — a socket failure never white-screens / surfaces partial state.
    const dispose = createTriageDisposition(fakeClient(() => Promise.reject(new Error("socket down"))));
    expect((await dispose("src_1", "reject")).ok).toBe(false);
  });

  it("dispose_malformed_ok_fails_closed — an ok WITHOUT a string idempotencyKey folds to { ok: false }", async () => {
    // spec(§16) defense-in-depth: a malformed/leaky result from a future server regression is DROPPED.
    const dispose = createTriageDisposition(fakeClient(() => Promise.resolve({ ok: true, value: {} })));
    expect((await dispose("src_1", "accept")).ok).toBe(false);
  });
});
