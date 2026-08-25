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

  it("§9.8 a write_conflict err (the CAS's exactly-once loser) folds to { ok: false, reason: \"already_resolved\" } — client-visible, distinct from a transport failure", async () => {
    const decide = createApprovalDecision(
      fakeClient(() =>
        Promise.resolve({
          ok: false,
          error: {
            kind: "write_conflict",
            message: "approval transition lost the compare-and-set",
            retryable: false,
            cause: { code: "APPROVAL_CAS_CONFLICT" },
          },
        }),
      ),
    );
    const r = await decide("apr_1", "approve");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("already_resolved");
  });

  it("§9.8 a degraded_unavailable err, a validation_rejected err, a malformed ok, and a thrown transport error ALL fold to { ok: false, reason: \"unavailable\" }", async () => {
    const degraded = createApprovalDecision(
      fakeClient(() =>
        Promise.resolve({
          ok: false,
          error: { kind: "degraded_unavailable", message: "approval store retryable", retryable: true },
        }),
      ),
    );
    const r1 = await degraded("apr_1", "approve");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("unavailable");

    const rejected = createApprovalDecision(
      fakeClient(() =>
        Promise.resolve({ ok: false, error: { kind: "validation_rejected", message: "approval not found", retryable: false } }),
      ),
    );
    const r2 = await rejected("apr_1", "approve");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("unavailable");

    const malformed = createApprovalDecision(fakeClient(() => Promise.resolve({ ok: true, value: { applied: true } })));
    const r3 = await malformed("apr_1", "approve");
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe("unavailable");

    const thrown = createApprovalDecision(fakeClient(() => Promise.reject(new Error("socket down"))));
    const r4 = await thrown("apr_1", "reject");
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.reason).toBe("unavailable");
  });

  it("§9.8 the failed-decision shape carries NO error/message/kind/cause key (rule 7 — the worker's enum + prose never leak verbatim)", async () => {
    const decide = createApprovalDecision(
      fakeClient(() =>
        Promise.resolve({
          ok: false,
          error: {
            kind: "write_conflict",
            message: "approval transition lost the compare-and-set — internal store detail",
            retryable: false,
            cause: { code: "APPROVAL_CAS_CONFLICT" },
          },
        }),
      ),
    );
    const r = await decide("apr_1", "approve");
    expect(r.ok).toBe(false);
    expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
  });

  it("§9.8 an ok result with applied:false still returns { ok: true, applied: false, approval } (idempotent no-op, distinct from a fail-closed reason)", async () => {
    const decide = createApprovalDecision(
      fakeClient(() =>
        Promise.resolve({
          ok: true,
          value: { applied: false, approval: { id: "apr_1", actionRef: "a", status: "approved", channel: "mac" } },
        }),
      ),
    );
    const r = await decide("apr_1", "approve");
    expect(r).toEqual({
      ok: true,
      applied: false,
      approval: { id: "apr_1", actionRef: "a", status: "approved", channel: "mac" },
    });
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
