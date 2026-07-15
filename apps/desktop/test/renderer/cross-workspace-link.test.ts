// Task 14.7 (desktop leg) — the renderer cross-workspace-link command-callers. The renderer only
// REQUESTS the owner-approval transitions — the worker (crossWorkspaceLink.create/approve/revoke)
// owns the candidate-data whitelist (a smuggled status/approvedAt is dropped — approval stays a
// separate explicit transition), the immutable-anchor guard, and the UI-safe summary. These
// wrappers fold a typed err / transport throw / malformed ok to { ok: false } (desktop Lesson 6).
// NO pre-approval smuggling: create forwards ONLY the whitelisted create fields.
import { describe, it, expect, vi } from "vitest";
import {
  createCrossWorkspaceLink,
  approveCrossWorkspaceLink,
  revokeCrossWorkspaceLink,
} from "../../renderer/lib/cross-workspace-link";

function fakeClient(paths: Record<string, (input: unknown) => Promise<unknown>>): never {
  return {
    crossWorkspaceLink: {
      create: { mutate: paths["create"] },
      approve: { mutate: paths["approve"] },
      revoke: { mutate: paths["revoke"] },
    },
  } as never;
}

const OK_LINK = {
  linkId: "l1",
  fromWorkspaceId: "ws_a",
  toWorkspaceId: "ws_b",
  scopeProjectionType: "calendar_busy",
  scopeVisibilityLevel: "coordination",
  status: "pending",
  createdAt: "2026-07-15T00:00:00.000Z",
  approvedAt: null,
  revokedAt: null,
};

describe("createCrossWorkspaceLink", () => {
  it("forwards ONLY the whitelisted create fields (no status/approvedAt) and returns the PENDING link", async () => {
    const mutate = vi.fn((_input: unknown) => Promise.resolve({ ok: true, value: OK_LINK }));
    const create = createCrossWorkspaceLink(fakeClient({ create: mutate }));
    const r = await create({
      linkId: "l1",
      fromWorkspaceId: "ws_a",
      toWorkspaceId: "ws_b",
      scopeProjectionType: "calendar_busy",
      scopeVisibilityLevel: "coordination",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.link.status).toBe("pending");
    // NO pre-approval smuggling — exactly the 5 whitelisted create fields, no status/approvedAt.
    expect(mutate).toHaveBeenCalledWith({
      linkId: "l1",
      fromWorkspaceId: "ws_a",
      toWorkspaceId: "ws_b",
      scopeProjectionType: "calendar_busy",
      scopeVisibilityLevel: "coordination",
    });
    const sent = mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("status");
    expect(sent).not.toHaveProperty("approvedAt");
  });

  it("folds a typed err (workspace_unknown / self / invalid_scope / immutable / store_fault) to { ok: false }", async () => {
    const create = createCrossWorkspaceLink(fakeClient({ create: () => Promise.resolve({ ok: false, error: { kind: "validation_rejected", cause: { code: "CWL_SELF" } } }) }));
    expect((await create({ linkId: "l1", fromWorkspaceId: "ws_a", toWorkspaceId: "ws_a", scopeProjectionType: "calendar_busy", scopeVisibilityLevel: "coordination" })).ok).toBe(false);
  });

  it("folds a transport throw + a malformed ok to { ok: false }", async () => {
    const thrown = createCrossWorkspaceLink(fakeClient({ create: () => Promise.reject(new Error("down")) }));
    expect((await thrown({ linkId: "l1", fromWorkspaceId: "ws_a", toWorkspaceId: "ws_b", scopeProjectionType: "calendar_busy", scopeVisibilityLevel: "coordination" })).ok).toBe(false);
    const malformed = createCrossWorkspaceLink(fakeClient({ create: () => Promise.resolve({ ok: true, value: { linkId: "l1" } }) }));
    expect((await malformed({ linkId: "l1", fromWorkspaceId: "ws_a", toWorkspaceId: "ws_b", scopeProjectionType: "calendar_busy", scopeVisibilityLevel: "coordination" })).ok).toBe(false);
  });
});

describe("approveCrossWorkspaceLink / revokeCrossWorkspaceLink", () => {
  it("approve forwards {linkId} and reflects the approved link", async () => {
    const mutate = vi.fn(() => Promise.resolve({ ok: true, value: { ...OK_LINK, status: "approved", approvedAt: "2026-07-15T01:00:00.000Z" } }));
    const approve = approveCrossWorkspaceLink(fakeClient({ approve: mutate }));
    const r = await approve("l1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.link.status).toBe("approved");
    expect(mutate).toHaveBeenCalledWith({ linkId: "l1" });
  });

  it("revoke forwards {linkId} and reflects the revoked link", async () => {
    const mutate = vi.fn(() => Promise.resolve({ ok: true, value: { ...OK_LINK, status: "revoked", revokedAt: "2026-07-15T02:00:00.000Z" } }));
    const revoke = revokeCrossWorkspaceLink(fakeClient({ revoke: mutate }));
    const r = await revoke("l1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.link.status).toBe("revoked");
    expect(mutate).toHaveBeenCalledWith({ linkId: "l1" });
  });

  it("both fold a typed err (link_not_pending / link_unknown) + transport throw to { ok: false }", async () => {
    const notPending = approveCrossWorkspaceLink(fakeClient({ approve: () => Promise.resolve({ ok: false, error: { kind: "validation_rejected", cause: { code: "CWL_NOT_PENDING" } } }) }));
    expect((await notPending("l1")).ok).toBe(false);
    const thrown = revokeCrossWorkspaceLink(fakeClient({ revoke: () => Promise.reject(new Error("x")) }));
    expect((await thrown("l1")).ok).toBe(false);
  });
});
