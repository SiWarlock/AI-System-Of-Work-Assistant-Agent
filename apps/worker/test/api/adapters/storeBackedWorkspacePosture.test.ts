// spec(§5) spec(§16) — task 9.10-A: the store-backed WorkspacePosture resolver (unit).
//
// The Employer-Work egress veto (rule 5) reads the workspace posture's
// `employerRawEgressAcknowledged`. This adapter makes that input come from the DURABLE
// per-workspace `WorkspaceConfigRepository.egressPolicy` instead of a hardcoded constant
// (or the retired `type==="employer_work"` fail-open hack). Absence / any store fault is
// FAIL-CLOSED (typed err, mirrors `createLocalWorkspacePosture`'s miss) — NEVER a
// synthesized ack=true posture.
import { describe, it, expect } from "vitest";
import { isOk, ok } from "@sow/contracts";
import type { Result, Workspace, WorkspaceType } from "@sow/contracts";
import { defaultWorkspace } from "@sow/contracts";
import type { WorkspaceConfigRepository, DbResult } from "@sow/db";
import { createStoreBackedWorkspacePosture } from "../../../src/api/adapters/storeBackedWorkspacePosture";

const WS = "ws-employer";

/** A persisted Workspace with a chosen type + acknowledged flag (ack⇒acknowledgedAt, EgressPolicy refine). */
function workspaceWith(type: WorkspaceType, ack: boolean): Workspace {
  const base = defaultWorkspace({ id: WS, name: "W", type, markdownRepoPath: "/vault", gbrainBrainId: "brain" });
  return {
    ...base,
    egressPolicy: {
      ...base.egressPolicy,
      employerRawEgressAcknowledged: ack,
      ...(ack ? { acknowledgedAt: "2026-07-25T00:00:00.000Z" } : {}),
    },
  };
}

/** A fake WorkspaceConfigRepository whose `get` returns the supplied DbResult. */
function repoGetting(get: () => DbResult<Workspace>): WorkspaceConfigRepository {
  return {
    get,
    list: () => Promise.resolve({ ok: false, error: { code: "unknown", message: "n/a" } }),
    upsert: (w: Workspace) => Promise.resolve(ok(w)),
  };
}

describe("§5 createStoreBackedWorkspacePosture — durable ack read, fail-closed on absence", () => {
  it("resolver_reads_durable_ack_from_store — persisted ack true→posture ack true; false→false", async () => {
    const rTrue = createStoreBackedWorkspacePosture(repoGetting(() => Promise.resolve(ok(workspaceWith("employer_work", true)))));
    const pTrue = await rTrue.resolve(WS);
    expect(isOk(pTrue)).toBe(true);
    if (isOk(pTrue)) expect(pTrue.value.egress.employerRawEgressAcknowledged).toBe(true);

    const rFalse = createStoreBackedWorkspacePosture(repoGetting(() => Promise.resolve(ok(workspaceWith("employer_work", false)))));
    const pFalse = await rFalse.resolve(WS);
    expect(isOk(pFalse)).toBe(true);
    if (isOk(pFalse)) {
      expect(pFalse.value.egress.employerRawEgressAcknowledged).toBe(false);
      // type + dataOwner PROJECTED from the persisted workspace (never synthesized).
      expect(pFalse.value.type).toBe("employer_work");
      expect(pFalse.value.dataOwner).toBe("employer");
    }
  });

  it("resolver_absence_fails_closed — get not_found ⇒ typed err, NEVER a synthesized ack=true posture", async () => {
    const r = createStoreBackedWorkspacePosture(
      repoGetting(() => Promise.resolve({ ok: false, error: { code: "not_found", message: "no workspace" } })),
    );
    const p = await r.resolve("ws-missing");
    expect(isOk(p)).toBe(false); // fail closed — no posture crosses, no default-true
  });

  it("resolver_store_fault_fails_closed — ANY get fault ⇒ err (fault ≠ benign absence, still no default-true)", async () => {
    const r = createStoreBackedWorkspacePosture(
      repoGetting(() => Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } })),
    );
    const p = await r.resolve(WS);
    expect(isOk(p)).toBe(false);
  });

  it("resolver_foreign_readback_fails_closed — a store row whose id ≠ the requested id is REJECTED (WS-8 re-gate)", async () => {
    // A buggy/malicious `get` returns a FOREIGN (more-permissive) workspace's row for the requested id.
    const foreign = defaultWorkspace({ id: "ws-OTHER", name: "Other", type: "personal_business", markdownRepoPath: "/v", gbrainBrainId: "b" });
    const r = createStoreBackedWorkspacePosture(repoGetting(() => Promise.resolve(ok(foreign))));
    const p = await r.resolve(WS); // requested id ("ws-employer") ≠ returned row id ("ws-OTHER")
    expect(isOk(p)).toBe(false); // fail closed — no foreign posture crosses into the veto
  });
});
