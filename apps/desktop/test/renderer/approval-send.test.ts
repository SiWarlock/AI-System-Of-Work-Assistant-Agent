// Linear slice 3+4, step 5 — the renderer callers for an approval's details, the unsent list and Send now. The
// renderer only REQUESTS; the worker enforces the workspace rule. Worker output is candidate data here too: an
// error, a thrown transport and an ok value that fails its UI-safe contract all fold to { ok: false }.
import { describe, it, expect } from "vitest";
import { createApprovalDetail, createUnsentApprovals, createSendNow } from "../../renderer/lib/approval-send";

function client(impl: { detail?: unknown; unsent?: unknown; sendNow?: unknown; throws?: boolean }): never {
  const answer = (v: unknown) => (impl.throws === true ? Promise.reject(new Error("transport")) : Promise.resolve(v));
  return {
    approvalSend: {
      detail: { query: () => answer(impl.detail) },
      unsent: { query: () => answer(impl.unsent) },
      sendNow: { mutate: () => answer(impl.sendNow) },
    },
  } as never;
}

describe("createApprovalDetail", () => {
  it("returns a contract-valid detail", async () => {
    const detail = { approvalId: "a", sendState: "writes_off", targetSystem: "linear", title: "T" };
    expect(await createApprovalDetail(client({ detail: { ok: true, value: detail } }))("ws", "a")).toEqual({ ok: true, detail });
  });
  it("⛔ an ok value carrying an extra key (e.g. the payload) is refused — the renderer re-gates", async () => {
    const bad = { approvalId: "a", sendState: "ready", payload: { secret: "x" } };
    expect(await createApprovalDetail(client({ detail: { ok: true, value: bad } }))("ws", "a")).toEqual({ ok: false });
  });
  it("folds an error result and a thrown transport to { ok: false }", async () => {
    expect(await createApprovalDetail(client({ detail: { ok: false, error: { kind: "validation_rejected" } } }))("ws", "a")).toEqual({ ok: false });
    expect(await createApprovalDetail(client({ throws: true }))("ws", "a")).toEqual({ ok: false });
  });
});

describe("createUnsentApprovals / createSendNow", () => {
  it("returns a contract-valid list and send result, and refuses anything else", async () => {
    const card = { id: "a", status: "approved", channel: "mac", targetSystem: "linear" };
    expect(await createUnsentApprovals(client({ unsent: { ok: true, value: [card] } }))("ws")).toEqual({ ok: true, approvals: [card] });
    expect(await createUnsentApprovals(client({ unsent: { ok: true, value: [{ ...card, payload: "x" }] } }))("ws")).toEqual({ ok: false });
    expect(await createSendNow(client({ sendNow: { ok: true, value: { approvalId: "a", sendState: "sent" } } }))("ws", "a")).toEqual({
      ok: true,
      result: { approvalId: "a", sendState: "sent" },
    });
    expect(await createSendNow(client({ sendNow: { ok: true, value: { approvalId: "a", sendState: "sent", payload: "x" } } }))("ws", "a")).toEqual({
      ok: false,
    });
    expect(await createSendNow(client({ sendNow: { ok: true, value: { approvalId: "a", sendState: "launched" } } }))("ws", "a")).toEqual({ ok: false });
    expect(await createSendNow(client({ throws: true }))("ws", "a")).toEqual({ ok: false });
  });
});
