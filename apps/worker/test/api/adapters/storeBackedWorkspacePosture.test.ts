// spec(§5) spec(§16) — task 9.10-A: the store-backed WorkspacePosture resolver (unit).
//
// The Employer-Work egress veto (rule 5) reads the workspace posture's
// `employerRawEgressAcknowledged`. This adapter makes that input come from the DURABLE
// per-workspace `WorkspaceConfigRepository.egressPolicy` instead of a hardcoded constant
// (or the retired `type==="employer_work"` fail-open hack). Absence / any store fault is
// FAIL-CLOSED (typed err, mirrors `createLocalWorkspacePosture`'s miss) — NEVER a
// synthesized ack=true posture.
import { describe, it, expect } from "vitest";
import { isErr, isOk, ok } from "@sow/contracts";
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
    // 9.30 — this suite exercises the READ path only; the mutator is present to satisfy the interface.
    insertIfAbsent: () => Promise.resolve(ok(false)),
    updateProvisioningFields: () =>
      Promise.resolve({ ok: false, error: { code: "unknown", message: "n/a" } }),
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
    // 24.101 — CAUSE CODE, not bare falsity: proves this is `unknownWorkspace()`'s generic
    // WORKSPACE_NOT_FOUND, not merely "some failure occurred" (which a bare `isOk===false` can't
    // distinguish from, say, a thrown/degraded fault or the WS-8 re-gate below).
    expect(isErr(p)).toBe(true);
    if (isErr(p)) expect(p.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("resolver_store_fault_fails_closed — ANY get fault ⇒ err (fault ≠ benign absence, still no default-true)", async () => {
    const r = createStoreBackedWorkspacePosture(
      repoGetting(() => Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } })),
    );
    const p = await r.resolve(WS);
    // 24.101 — deliberately the SAME code as the absence case above (a generic store fault
    // collapses into `unknownWorkspace()` too, per this resolver's own header — "any store fault");
    // the assertion still discriminates a WORKSPACE_NOT_FOUND-shaped failure from any other kind
    // (a thrown exception, a degraded_unavailable, or the WS-8 mismatch below), which bare falsity
    // could not.
    expect(isErr(p)).toBe(true);
    if (isErr(p)) expect(p.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("resolver_stored_row_schema_violation_fails_closed — task 9.36's new DbErrorCode is ALREADY covered by the existing any-fault fail-closed (no code change needed here)", async () => {
    // The repository read boundary (task 9.36) can now reject a stored row as
    // `stored_row_schema_violation` — verify this resolver (`if (!isOk(got)) return err(...)`) already
    // fails closed on it, exactly as it does on any other DbError code (regression pin, not a fix:
    // this file needed no change for 9.36 — confirmed by reading the source, contradicting the
    // brief's file list, which listed it as one to modify).
    const r = createStoreBackedWorkspacePosture(
      repoGetting(() =>
        Promise.resolve({ ok: false, error: { code: "stored_row_schema_violation", message: "corrupt row" } }),
      ),
    );
    const p = await r.resolve(WS);
    // 24.101 — same rationale as resolver_store_fault_fails_closed above: a schema violation is
    // ANOTHER store-fault variant, so it collapses to the SAME WORKSPACE_NOT_FOUND by design (this
    // test's own title already says "no code change needed here" — the assertion below confirms
    // it, rather than merely confirming SOME failure happened).
    expect(isErr(p)).toBe(true);
    if (isErr(p)) expect(p.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("resolver_foreign_readback_fails_closed — a store row whose id ≠ the requested id is REJECTED (WS-8 re-gate)", async () => {
    // A buggy/malicious `get` returns a FOREIGN (more-permissive) workspace's row for the requested id.
    const foreign = defaultWorkspace({ id: "ws-other", name: "Other", type: "personal_business", markdownRepoPath: "/v", gbrainBrainId: "b" });
    const r = createStoreBackedWorkspacePosture(repoGetting(() => Promise.resolve(ok(foreign))));
    const p = await r.resolve(WS); // requested id ("ws-employer") ≠ returned row id ("ws-other")
    // 24.101 — THE discriminating assertion this test previously couldn't make: a bare
    // `isOk(p)===false` cannot tell "the WS-8 re-gate caught a foreign row" apart from "the
    // workspace simply doesn't exist" (resolver_absence_fails_closed above) or any other failure.
    // The resolver now emits a DISTINCT cause code for exactly this branch — asserting it here
    // proves the re-gate fired, not merely that resolution failed for some unspecified reason.
    expect(isErr(p)).toBe(true);
    if (isErr(p)) {
      expect(p.error.cause?.code).toBe("WORKSPACE_READBACK_MISMATCH");
      expect(p.error.cause?.code).not.toBe("WORKSPACE_NOT_FOUND"); // discriminates from the absence case
    }
  });
});
