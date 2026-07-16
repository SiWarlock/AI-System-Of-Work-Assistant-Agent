// §9.7 triage-resolution ACTION UI — the renderer triage-disposition caller. The renderer
// only REQUESTS a disposition — the worker (`command.disposeTriage`) re-enters the ingestion
// pipeline REUSING the caller's idempotencyKey (replay-safe, ING-4); the pipeline (via
// TriagePort) is the only writer. This wrapper mints a DETERMINISTIC idempotency key per
// (sourceId, disposition) so a double-click / retry lands the SAME key → one effect, returns
// the reused key on ok, and folds a typed err OR any transport error to `{ ok: false }` so a
// failed disposition surfaces nothing (fail-closed, §16 never-throw at the UI boundary).
import { describe, it, expect, vi } from "vitest";
import {
  createTriageDisposition,
  triageIdempotencyKey,
  buildTriageMutationInput,
} from "../../renderer/lib/triage-disposition";

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

// ── 15.8 reroute payload builder (the deterministic renderer logic) ───────────
describe("buildTriageMutationInput — reroute payload builder (15.8, REQ-F-017 at the edge)", () => {
  it("reroute_submit_builds_pinned_command_payload — item + selected {workspaceId, projectId} ⇒ the pinned shape", () => {
    // spec(§19.2) the shared command contract (brief 105): reroute carries a target {workspaceId, projectId?}.
    const r = buildTriageMutationInput("src_1", "reroute", { workspaceId: "ws_a", projectId: "p_1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input).toEqual({
        sourceId: "src_1",
        idempotencyKey: "src_1:reroute:ws_a:p_1", // target-ENCODED key (deterministic, replay-safe ING-4)
        disposition: "reroute",
        target: { workspaceId: "ws_a", projectId: "p_1" },
      });
    }
  });

  it("reroute_key_encodes_the_target — distinct targets ⇒ distinct keys; same target ⇒ same key (WS-8 no silent misroute)", () => {
    // spec(WS-8) a target-blind key would AlreadyStarted-dedupe a re-submit-to-a-different-workspace onto
    // the earlier target — a silent cross-workspace misroute. Encoding the target makes them distinct ops.
    const key = (t: { workspaceId: string; projectId?: string }): string => {
      const r = buildTriageMutationInput("src_1", "reroute", t);
      return r.ok ? r.input.idempotencyKey : "";
    };
    expect(key({ workspaceId: "ws_a" })).toBe("src_1:reroute:ws_a");
    expect(key({ workspaceId: "ws_b" })).toBe("src_1:reroute:ws_b");
    expect(key({ workspaceId: "ws_a", projectId: "p_1" })).toBe("src_1:reroute:ws_a:p_1");
    expect(key({ workspaceId: "ws_a" })).not.toBe(key({ workspaceId: "ws_b" })); // A vs B both drive
    expect(key({ workspaceId: "ws_a" })).not.toBe(key({ workspaceId: "ws_a", projectId: "p_1" })); // ws vs ws+proj
    expect(key({ workspaceId: "ws_a", projectId: "p_1" })).toBe(key({ workspaceId: "ws_a", projectId: "p_1" })); // same ⇒ one key
  });

  it("reroute_target_workspace_only — projectId omitted (not a `projectId: undefined` key) when no project chosen", () => {
    // spec(§19.2) target.projectId is OPTIONAL; a workspace-only reroute is valid, no undefined key smuggled.
    const r = buildTriageMutationInput("src_1", "reroute", { workspaceId: "ws_a" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.target).toEqual({ workspaceId: "ws_a" });
      expect("projectId" in (r.input.target ?? {})).toBe(false);
    }
  });

  it("reroute_without_target_is_blocked — no target ⇒ typed reject, NO payload (REQ-F-017 no-inference at the edge)", () => {
    // spec(REQ-F-017) the renderer never invents a target — a target-less reroute fails closed, no command built.
    expect(buildTriageMutationInput("src_1", "reroute", undefined)).toEqual({
      ok: false,
      reason: "reroute_target_required",
    });
  });

  it("reroute_empty_workspace_is_blocked — a blank workspaceId ⇒ typed reject (never a defaulted/guessed target)", () => {
    // spec(REQ-F-017) mirror the worker's `reroute_target_required` guard so the round-trips agree.
    expect(buildTriageMutationInput("src_1", "reroute", { workspaceId: "" })).toEqual({
      ok: false,
      reason: "reroute_target_required",
    });
  });

  it("accept_payload_unchanged — accept builds {sourceId, key, disposition} with NO target key (byte-equivalent)", () => {
    // spec(§19.2) additive-optional: a non-reroute disposition is exactly today's payload (worker L15/L35).
    const r = buildTriageMutationInput("src_1", "accept");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input).toEqual({ sourceId: "src_1", idempotencyKey: "src_1:accept", disposition: "accept" });
      expect("target" in r.input).toBe(false);
    }
  });

  it("reject_never_attaches_target — a stray target on a non-reroute disposition is dropped (target forbidden otherwise)", () => {
    // spec(§19.2) contract: target is REQUIRED for reroute, FORBIDDEN otherwise — the builder never smuggles it.
    const r = buildTriageMutationInput("src_1", "reject", { workspaceId: "ws_a" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input).toEqual({ sourceId: "src_1", idempotencyKey: "src_1:reject", disposition: "reject" });
      expect("target" in r.input).toBe(false);
    }
  });
});

// ── 15.8 reroute caller wiring (the command-caller end-to-end) ────────────────
describe("createTriageDisposition — reroute wiring (15.8)", () => {
  it("reroute_calls_mutation_with_target_and_reused_key — sends the pinned reroute payload verbatim", async () => {
    // spec(§19.2) the caller forwards the built reroute command (target + reused key) to command.disposeTriage.
    const mutate = vi.fn(() => Promise.resolve({ ok: true, value: { idempotencyKey: "src_1:reroute:ws_a:p_1" } }));
    const dispose = createTriageDisposition(fakeClient(mutate));
    await dispose("src_1", "reroute", { workspaceId: "ws_a", projectId: "p_1" });
    expect(mutate).toHaveBeenCalledWith({
      sourceId: "src_1",
      idempotencyKey: "src_1:reroute:ws_a:p_1",
      disposition: "reroute",
      target: { workspaceId: "ws_a", projectId: "p_1" },
    });
  });

  it("reroute_without_target_never_calls_mutation — fail-closed at the edge (no target-less reroute leaves the renderer)", async () => {
    // spec(REQ-F-017) the untrusted renderer NEVER dispatches a reroute without a registry-picked target.
    const mutate = vi.fn(() => Promise.resolve({ ok: true, value: { idempotencyKey: "x" } }));
    const dispose = createTriageDisposition(fakeClient(mutate));
    const r = await dispose("src_1", "reroute");
    expect(r.ok).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("accept_still_sends_no_target — the legacy caller path stays byte-equivalent (additive)", async () => {
    // spec(§19.2) an existing accept/reject call is unchanged — the optional target arg defaults absent.
    const mutate = vi.fn(() => Promise.resolve({ ok: true, value: { idempotencyKey: "src_1:accept" } }));
    const dispose = createTriageDisposition(fakeClient(mutate));
    await dispose("src_1", "accept");
    expect(mutate).toHaveBeenCalledWith({ sourceId: "src_1", idempotencyKey: "src_1:accept", disposition: "accept" });
  });
});
