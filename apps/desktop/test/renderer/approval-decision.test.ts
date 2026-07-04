// §9.8 S3: the renderer approval-decision caller. The renderer only REQUESTS a
// decision — the worker (`command.decideApproval`) owns the exactly-once CAS, the
// one-writer dispatch, and the UI-safe projection. This wrapper carries the fixed
// `mac` channel (this IS the Mac app; Mac+Telegram parity is the worker's job),
// returns the worker's authoritative UI-safe record on ok (folded into the inbox
// with no re-query), and folds a typed err (CAS conflict / not-found / auth) OR any
// transport error to `{ ok: false }` so a failed decision never surfaces anything.
import { describe, it, expect, vi } from "vitest";
import { createApprovalDecision } from "../../renderer/lib/approval-decision";

// A minimal fake tRPC client exposing only command.decideApproval.mutate.
function fakeClient(mutateImpl: (input: unknown) => Promise<unknown>): never {
  return { command: { decideApproval: { mutate: mutateImpl } } } as never;
}

describe("createApprovalDecision", () => {
  it("returns the worker's UI-safe approval + applied flag on an ok decision", async () => {
    const decide = createApprovalDecision(
      fakeClient(() =>
        Promise.resolve({
          ok: true,
          value: { applied: true, approval: { id: "apr_1", actionRef: "act_1", status: "approved", channel: "mac" } },
        }),
      ),
    );
    const r = await decide("apr_1", "approve");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied).toBe(true);
      expect(r.approval.status).toBe("approved");
      expect(r.approval.id).toBe("apr_1");
    }
  });

  it("sends the FIXED `mac` channel + the caller's approvalId/decision (this is the Mac channel)", async () => {
    const mutate = vi.fn(() =>
      Promise.resolve({ ok: true, value: { applied: true, approval: { id: "apr_1", actionRef: "a", status: "deferred", channel: "mac" } } }),
    );
    const decide = createApprovalDecision(fakeClient(mutate));
    await decide("apr_1", "defer");
    expect(mutate).toHaveBeenCalledWith({ approvalId: "apr_1", decision: "defer", channel: "mac" });
  });

  it("surfaces an idempotent no-op (applied:false) as ok with the same record", async () => {
    const decide = createApprovalDecision(
      fakeClient(() =>
        Promise.resolve({ ok: true, value: { applied: false, approval: { id: "apr_1", actionRef: "a", status: "approved", channel: "mac" } } }),
      ),
    );
    const r = await decide("apr_1", "approve");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.applied).toBe(false);
  });

  it("folds a typed err Result (CAS conflict on an expired item) to { ok: false }", async () => {
    const decide = createApprovalDecision(
      fakeClient(() =>
        Promise.resolve({ ok: false, error: { kind: "write_conflict", cause: { code: "APPROVAL_CAS_CONFLICT" } } }),
      ),
    );
    expect((await decide("apr_1", "approve")).ok).toBe(false);
  });

  it("folds a thrown transport error to { ok: false } (fail closed)", async () => {
    const decide = createApprovalDecision(fakeClient(() => Promise.reject(new Error("socket down"))));
    expect((await decide("apr_1", "reject")).ok).toBe(false);
  });

  it("folds a malformed ok-without-approval to { ok: false }", async () => {
    const decide = createApprovalDecision(fakeClient(() => Promise.resolve({ ok: true, value: { applied: true } })));
    expect((await decide("apr_1", "approve")).ok).toBe(false);
  });

  it("DROPS a leaky record (extra actor/payloadHash) — .strict re-validation folds to { ok: false }", async () => {
    // Defense-in-depth: even if a future server-projector regression returned the raw
    // Approval, the client re-validates against UiSafeApprovalSchema (.strict), so a
    // record carrying non-allowlisted `actor`/`payloadHash` is DROPPED, not surfaced.
    const decide = createApprovalDecision(
      fakeClient(() =>
        Promise.resolve({
          ok: true,
          value: {
            applied: true,
            approval: { id: "apr_1", actionRef: "a", status: "approved", channel: "mac", actor: "user:alice", payloadHash: "sha256:leak" },
          },
        }),
      ),
    );
    expect((await decide("apr_1", "approve")).ok).toBe(false);
  });
});
