// Task 9.10-C (desktop leg) — the renderer egress-posture callers. READ = systemHealth.egressStatus
// (visibility, REQ-S-002); WRITE = the single fail-SAFE egressCommand.revokeEgressAck (worker #53).
// The renderer NEVER flips policy locally: it only requests, and folds a typed err / transport throw /
// malformed ok to { ok: false } (desktop Lesson 6) so an UNKNOWN posture can never read as permission.
// Both callers reconstruct from the 3-field allowlist (workspaceId / employerRawEgressAcknowledged /
// zeroEgressOnly), so an over-broad server result cannot leak an extra field into the UI (rule 7).
import { describe, it, expect, vi } from "vitest";
import * as egressModule from "../../renderer/lib/egress-status";
import { createEgressStatus, createRevokeEgressAck } from "../../renderer/lib/egress-status";

function fakeClient(paths: {
  egressStatus?: (input: unknown) => Promise<unknown>;
  revokeEgressAck?: (input: unknown) => Promise<unknown>;
}): never {
  return {
    systemHealth: { egressStatus: { query: paths.egressStatus } },
    egressCommand: { revokeEgressAck: { mutate: paths.revokeEgressAck } },
  } as never;
}

const OK_STATUS = {
  workspaceId: "ws_employer",
  employerRawEgressAcknowledged: true,
  zeroEgressOnly: false,
};

describe("createEgressStatus (READ — the per-workspace posture)", () => {
  it("forwards {workspaceId} to systemHealth.egressStatus and returns the 3 allowlisted fields", async () => {
    // spec(§16) REQ-S-002 — the Employer-Work raw-egress posture is SURFACED per workspace.
    const query = vi.fn((_input: unknown) => Promise.resolve({ ok: true, value: OK_STATUS }));
    const read = createEgressStatus(fakeClient({ egressStatus: query }));
    const r = await read("ws_employer");
    expect(query).toHaveBeenCalledWith({ workspaceId: "ws_employer" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toEqual({
        workspaceId: "ws_employer",
        employerRawEgressAcknowledged: true,
        zeroEgressOnly: false,
      });
    }
  });

  it("DROPS any field outside the 3-field allowlist (rule 7 — no leak past the UI-safe projection)", async () => {
    // spec(§5) — the renderer reconstructs from the allowlist; a server-projector regression that
    // widened the payload (raw content / a secret ref / an absolute path) never reaches the UI.
    const leaky = {
      ...OK_STATUS,
      rawEmployerContent: "confidential board deck bytes",
      allowlist: ["claude"],
      vaultPath: "/Users/owner/vault",
    };
    const read = createEgressStatus(fakeClient({ egressStatus: () => Promise.resolve({ ok: true, value: leaky }) }));
    const r = await read("ws_employer");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.status).sort()).toEqual([
        "employerRawEgressAcknowledged",
        "workspaceId",
        "zeroEgressOnly",
      ]);
      expect(JSON.stringify(r.status)).not.toMatch(/confidential|vault|claude/i);
    }
  });

  it("folds a typed err / transport throw / malformed ok to {ok:false} — UNKNOWN is never 'acknowledged'", async () => {
    // spec(§16) fail-closed presentation (safety rule 5's presentation analog): an unavailable
    // posture must surface as unknown, NEVER as the permissive value. Desktop Lesson 6.
    const typedErr = createEgressStatus(
      fakeClient({
        egressStatus: () =>
          Promise.resolve({ ok: false, error: { kind: "validation_rejected", cause: { code: "WORKSPACE_NOT_FOUND" } } }),
      }),
    );
    expect((await typedErr("ws_employer")).ok).toBe(false);
    const thrown = createEgressStatus(fakeClient({ egressStatus: () => Promise.reject(new Error("worker down")) }));
    expect((await thrown("ws_employer")).ok).toBe(false);
    // A malformed ok whose ack field is missing/non-boolean must NOT default to true (or to false-as-truth).
    const malformed = createEgressStatus(
      fakeClient({ egressStatus: () => Promise.resolve({ ok: true, value: { workspaceId: "ws_employer" } }) }),
    );
    expect((await malformed("ws_employer")).ok).toBe(false);
    const coerced = createEgressStatus(
      fakeClient({
        egressStatus: () =>
          Promise.resolve({ ok: true, value: { ...OK_STATUS, employerRawEgressAcknowledged: "true" } }),
      }),
    );
    expect((await coerced("ws_employer")).ok).toBe(false);
  });
});

describe("createRevokeEgressAck (WRITE — the ONLY mutating egress affordance, fail-SAFE OFF)", () => {
  it("forwards ONLY {workspaceId} to egressCommand.revokeEgressAck and returns the NEW status", async () => {
    // spec(§5) safety rule 5 — the renderer REQUESTS the audited worker command; the worker owns the
    // policy write. The command's returned status is the post-revoke truth the surface re-renders from.
    const mutate = vi.fn((_input: unknown) =>
      Promise.resolve({ ok: true, value: { ...OK_STATUS, employerRawEgressAcknowledged: false } }),
    );
    const revoke = createRevokeEgressAck(fakeClient({ revokeEgressAck: mutate }));
    const r = await revoke("ws_employer");
    expect(mutate).toHaveBeenCalledWith({ workspaceId: "ws_employer" });
    // No ack/allowlist/acknowledgedAt smuggling — exactly the one input field.
    expect(Object.keys(mutate.mock.calls[0]![0] as Record<string, unknown>)).toEqual(["workspaceId"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status.employerRawEgressAcknowledged).toBe(false);
  });

  it("folds a typed err / transport throw / malformed ok to {ok:false} — never a false 'revoked'", async () => {
    // spec(§16) — the fail-SAFE direction must still be HONEST about failing (no optimistic flip).
    const storeFault = createRevokeEgressAck(
      fakeClient({
        revokeEgressAck: () =>
          Promise.resolve({ ok: false, error: { kind: "degraded_unavailable", cause: { code: "EGRESS_REVOKE_STORE_FAULT" } } }),
      }),
    );
    expect((await storeFault("ws_employer")).ok).toBe(false);
    const thrown = createRevokeEgressAck(fakeClient({ revokeEgressAck: () => Promise.reject(new Error("x")) }));
    expect((await thrown("ws_employer")).ok).toBe(false);
    const malformed = createRevokeEgressAck(
      fakeClient({ revokeEgressAck: () => Promise.resolve({ ok: true, value: { workspaceId: "ws_employer" } }) }),
    );
    expect((await malformed("ws_employer")).ok).toBe(false);
  });

  it("rejects a status for a DIFFERENT workspace than the one requested (both callers)", async () => {
    // spec(§5) WS-8 + rule 5 — the posture is only meaningful bound to its workspace. A server-side
    // projector/command regression that answers with another workspace's posture must fold to UNKNOWN,
    // never render one workspace's "acknowledged" under another workspace's label.
    const foreign = { ...OK_STATUS, workspaceId: "ws_other" };
    const read = createEgressStatus(fakeClient({ egressStatus: () => Promise.resolve({ ok: true, value: foreign }) }));
    expect((await read("ws_employer")).ok).toBe(false);
    const revoke = createRevokeEgressAck(
      fakeClient({ revokeEgressAck: () => Promise.resolve({ ok: true, value: foreign }) }),
    );
    expect((await revoke("ws_employer")).ok).toBe(false);
  });

  it("the module exposes NO ack-ON caller — the ack direction is an owner-gated rule-5 crossing", () => {
    // spec(§5) safety rule 5 — turning employer raw-cloud egress ON is a provisioning-time owner crossing
    // (`bcde3d61`); the worker exposes no re-ack command. Pin the ABSENCE so a later "complete the toggle"
    // slice can't quietly re-open it from the renderer.
    const exported = Object.keys(egressModule).sort();
    expect(exported).toEqual(["createEgressStatus", "createRevokeEgressAck"]);
    for (const name of exported) {
      expect(name).not.toMatch(/acknowledge|grant|enable|allow|setAck|reAck/i);
    }
  });
});
