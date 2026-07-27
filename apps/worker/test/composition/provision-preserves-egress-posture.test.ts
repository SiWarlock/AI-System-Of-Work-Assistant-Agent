// spec(§5) spec(§16) — task 9.23 (⚠ rule-5 FAIL-OPEN closure): provisioning may seed only what it CREATES.
//
// THE DEFECT: `provisionWorkspace` seeded the egress allowlist BEFORE its existence check, and the
// same-type branch deliberately falls through to `workspaceConfig.upsert(workspace)` — so a re-provision
// wrote the freshly-seeded policy over the stored one. For `employer_work` that seed sets
// `employerRawEgressAcknowledged: true` + a fresh `acknowledgedAt`, which means the 9.10-B owner REVOKE
// was not durable: any later `onboarding.createWorkspace` for the same workspace silently restored
// ack=true, with NO audit row (provisioning doesn't audit a restoration) and NO owner confirm.
//
// This is worker L30 UNDER-APPLIED, not a missing rule. L30 already requires get-before-upsert on a
// workspace-bound record's binding anchor, naming "a field deriving the isolation class / egress-veto
// applicability" — which `employerRawEgressAcknowledged` is. The `get` was already happening; its result
// was simply only used for the `type` check while the SAME upsert overwrote egress state too.
//
// These run over the REAL backends (in-memory sqlite `WorkspaceConfigRepository`) and the REAL 9.10-B
// revoke command, so the pin exercises the actual owner path rather than a fake's idea of it.
import { describe, it, expect, afterEach } from "vitest";
import { isErr, isOk, processorId } from "@sow/contracts";
import type { Result, Workspace } from "@sow/contracts";
import type { DbError, WorkspaceConfigRepository } from "@sow/db";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import {
  provisionWorkspace,
  type ProvisionWorkspaceDeps,
  type ProvisionWorkspaceSpec,
} from "../../src/composition/provisionWorkspace";
import { createEgressCommandPort } from "../../src/composition/egressRevoke";

const NOW = "2026-07-26T00:00:00.000Z";

const EMPLOYER: ProvisionWorkspaceSpec = {
  id: "employer-work",
  name: "Employer Work",
  type: "employer_work",
  vaultRoot: "/vaults/employer-work",
  gbrainBrainId: "brain-employer",
  preset: "professional",
};
const PERSONAL: ProvisionWorkspaceSpec = {
  id: "personal-business",
  name: "Side Business",
  type: "personal_business",
  vaultRoot: "/vaults/personal-business",
  gbrainBrainId: "brain-side",
  preset: "founder",
};

const open: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of open.splice(0)) b.close();
});
async function fresh(): Promise<ProofSpineBackends> {
  const b = await assembleBackends({ now: () => NOW });
  open.push(b);
  return b;
}
function deps(b: ProofSpineBackends): ProvisionWorkspaceDeps {
  return { workspaceConfig: b.repos.workspaceConfig, readModels: b.repos.readModels, now: b.now };
}
async function storedPolicy(b: ProofSpineBackends, id: string): Promise<Workspace["egressPolicy"]> {
  const cfg = await b.repos.workspaceConfig.get(id as Workspace["id"]);
  if (!isOk(cfg)) throw new Error(`workspace ${id} not stored`);
  return cfg.value.egressPolicy;
}

describe("provisionWorkspace — seeds only what it CREATES (9.23)", () => {
  it("re_provision_preserves_a_revoked_ack — the owner's revoke survives a later re-provision", async () => {
    const b = await fresh();
    // 1) fresh create → the 9.10 employer default-seed (ack ON).
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);
    expect((await storedPolicy(b, EMPLOYER.id)).employerRawEgressAcknowledged).toBe(true);

    // 2) the OWNER revokes, through the real 9.10-B command.
    const revoke = createEgressCommandPort({
      workspaceConfig: b.repos.workspaceConfig,
      audit: b.repos.audit,
      now: () => NOW,
    });
    expect(isOk(await revoke.revokeEgressAck({ workspaceId: EMPLOYER.id }))).toBe(true);
    expect((await storedPolicy(b, EMPLOYER.id)).employerRawEgressAcknowledged).toBe(false);

    // 3) a later re-provision of the SAME workspace must not undo the owner's decision.
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);

    const after = await storedPolicy(b, EMPLOYER.id);
    expect(after.employerRawEgressAcknowledged).toBe(false);
    // The paired timestamp must not come back either — a stale `acknowledgedAt` is exactly what a
    // later reader mistakes for consent (9.10-B / L45).
    expect(after.acknowledgedAt).toBeUndefined();
  });

  it("fresh_create_still_seeds — a genuine not_found create seeds exactly as before (non-vacuity)", async () => {
    // Without this, a "fix" that simply stopped seeding would pass every preservation test above
    // while silently regressing the owner-authorized 9.10 flip.
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);
    expect(isOk(await provisionWorkspace(deps(b), PERSONAL))).toBe(true);

    const employer = await storedPolicy(b, EMPLOYER.id);
    expect(employer.allowedProcessors).toEqual([processorId("claude")]);
    expect(employer.rawContentAllowedProcessors).toEqual([processorId("claude")]);
    expect(employer.employerRawEgressAcknowledged).toBe(true);
    expect(employer.acknowledgedAt).toBe(NOW);

    const personal = await storedPolicy(b, PERSONAL.id);
    expect(personal.allowedProcessors).toEqual([processorId("claude")]);
    expect(personal.employerRawEgressAcknowledged).toBe(false); // employer veto never bites for personal
  });

  it("same_type_overwrite_carries_policy_verbatim — the stored policy survives field-for-field", async () => {
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);

    // A deliberately NON-default stored posture — the shape a later owner edit could produce.
    const cfg = await b.repos.workspaceConfig.get(EMPLOYER.id as Workspace["id"]);
    expect(isOk(cfg)).toBe(true);
    if (!isOk(cfg)) return;
    const custom: Workspace = {
      ...cfg.value,
      egressPolicy: {
        ...cfg.value.egressPolicy,
        allowedProcessors: [processorId("ollama"), processorId("claude")],
        rawContentAllowedProcessors: [],
        employerRawEgressAcknowledged: false,
      },
    };
    delete (custom.egressPolicy as { acknowledgedAt?: string }).acknowledgedAt; // refine: absent IFF ack false
    expect(isOk(await b.repos.workspaceConfig.upsert(custom))).toBe(true);

    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);

    // VERBATIM — not merged, not re-seeded, not partially defaulted. A partial default is the same
    // class of silent rewrite as a full re-seed.
    expect(await storedPolicy(b, EMPLOYER.id)).toEqual(custom.egressPolicy);
  });

  it("carried_ack_timestamp_is_the_STORED_one_not_a_fresh_stamp — carried, not re-stamped", async () => {
    // The other pins all run on a single frozen clock, so they cannot tell "carried the stored
    // `acknowledgedAt`" apart from "re-stamped it at provisioning time". That distinction is the whole
    // of L45: a REFRESHED consent timestamp on a still-acknowledged workspace is exactly what a later
    // reader (or an audit) mistakes for a fresh owner decision. Drive the re-provision on a LATER clock
    // and require the ORIGINAL instant to survive.
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);
    const seeded = await storedPolicy(b, EMPLOYER.id);
    expect(seeded.employerRawEgressAcknowledged).toBe(true);
    expect(seeded.acknowledgedAt).toBe(NOW);

    const LATER = "2027-01-01T00:00:00.000Z";
    const res = await provisionWorkspace(
      { workspaceConfig: b.repos.workspaceConfig, readModels: b.repos.readModels, now: () => LATER },
      EMPLOYER,
    );
    expect(isOk(res)).toBe(true);

    const after = await storedPolicy(b, EMPLOYER.id);
    expect(after.employerRawEgressAcknowledged).toBe(true); // still acknowledged (nothing revoked it)
    expect(after.acknowledgedAt).toBe(NOW); // …but the ORIGINAL consent instant, never re-stamped
  });

  it("same_type_overwrite_still_updates_name_and_vaultroot — the fix must not make re-provision a no-op", async () => {
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);

    const renamed: ProvisionWorkspaceSpec = {
      ...EMPLOYER,
      name: "Employer Work (renamed)",
      vaultRoot: "/vaults/employer-work-moved",
    };
    expect(isOk(await provisionWorkspace(deps(b), renamed))).toBe(true);

    const cfg = await b.repos.workspaceConfig.get(EMPLOYER.id as Workspace["id"]);
    expect(isOk(cfg)).toBe(true);
    if (isOk(cfg)) {
      expect(cfg.value.name).toBe("Employer Work (renamed)");
      expect(cfg.value.markdownRepoPath).toBe("/vaults/employer-work-moved");
    }
  });

  it("personal_posture_also_preserved — the rule is about provisioning's authority, not employer specifically", async () => {
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), PERSONAL))).toBe(true);

    const cfg = await b.repos.workspaceConfig.get(PERSONAL.id as Workspace["id"]);
    expect(isOk(cfg)).toBe(true);
    if (!isOk(cfg)) return;
    const narrowed: Workspace = {
      ...cfg.value,
      egressPolicy: { ...cfg.value.egressPolicy, allowedProcessors: [], rawContentAllowedProcessors: [] },
    };
    expect(isOk(await b.repos.workspaceConfig.upsert(narrowed))).toBe(true);

    expect(isOk(await provisionWorkspace(deps(b), PERSONAL))).toBe(true);

    // A personal workspace's posture is equally not provisioning's to rewrite.
    expect((await storedPolicy(b, PERSONAL.id)).allowedProcessors).toEqual([]);
  });

  it("different_type_still_rejected — L30's existing type-immutability guard is untouched", async () => {
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);
    const before = await storedPolicy(b, EMPLOYER.id);

    const retyped: ProvisionWorkspaceSpec = { ...EMPLOYER, type: "personal_life" };
    const res = await provisionWorkspace(deps(b), retyped);

    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("workspace_type_immutable");
    // Rejected means NOTHING was written — the stored posture is byte-identical.
    expect(await storedPolicy(b, EMPLOYER.id)).toEqual(before);
  });

  it("carried_policy_with_a_foreign_workspaceid_does_not_land — the carry re-gates identity", async () => {
    // Carrying the stored `egressPolicy` object wholesale (rather than copying named fields) is the
    // right call — a field-by-field copy silently drops any field added later. But it lands the object
    // AFTER `defaultWorkspace` already parsed, so nothing re-checks the aggregate's identity refinement
    // (`WorkspaceSchema`: id === egressPolicy.workspaceId === providerMatrix.workspaceId).
    //
    // Fail CLOSED rather than normalize: a stored policy bearing a foreign workspaceId means the row is
    // already inconsistent, and rewriting its id to `spec.id` would quietly graft ANOTHER workspace's
    // allowlist + ack onto this one, stamped as if it belonged here — a WS-8-adjacent write that would
    // look entirely legitimate afterwards. Refusing is the same posture as the store-fault branch:
    // never proceed over an unknown/contradictory prior state.
    const b = await fresh();
    const base = await b.repos.workspaceConfig.get(EMPLOYER.id as Workspace["id"]);
    expect(isErr(base)).toBe(true); // nothing stored yet
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);
    const stored = await b.repos.workspaceConfig.get(EMPLOYER.id as Workspace["id"]);
    expect(isOk(stored)).toBe(true);
    if (!isOk(stored)) return;

    // A CORRUPT prior row: the policy names a different workspace. Built by cast because the schema
    // would (correctly) refuse to construct it — this models a row that got there some other way.
    const corrupt = {
      ...stored.value,
      egressPolicy: { ...stored.value.egressPolicy, workspaceId: "some-other-workspace" },
    } as unknown as Workspace;

    // A COMPLETE literal, not a spread over the real repo: spreading would silently inherit any method
    // `provisionWorkspace` starts calling later, turning a future compile error into a fake that
    // half-hits the real store. No cast either — the annotation must be what catches a missing member.
    let upserted: Workspace | undefined;
    const injected: WorkspaceConfigRepository = {
      get: (): Promise<Result<Workspace, DbError>> => Promise.resolve({ ok: true, value: corrupt }),
      list: (): Promise<Result<Workspace[], DbError>> => Promise.resolve({ ok: true, value: [corrupt] }),
      upsert: (w: Workspace): Promise<Result<Workspace, DbError>> => {
        upserted = w;
        return b.repos.workspaceConfig.upsert(w);
      },
    };

    const res = await provisionWorkspace(
      { workspaceConfig: injected, readModels: b.repos.readModels, now: b.now },
      EMPLOYER,
    );

    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("invalid_workspace"); // failed for the RIGHT reason
    // The load-bearing assertion, whichever disposition is chosen: no workspace may be written whose
    // own id disagrees with its egress policy's.
    expect(upserted).toBeUndefined();
  });

  it("store_fault_fails_closed_no_upsert — an unknown prior state never falls through to create", async () => {
    const b = await fresh();
    let upserts = 0;
    const faulting: WorkspaceConfigRepository = {
      ...b.repos.workspaceConfig,
      get: (): Promise<Result<Workspace, DbError>> =>
        Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } as DbError }),
      upsert: (w: Workspace): Promise<Result<Workspace, DbError>> => {
        upserts += 1;
        return b.repos.workspaceConfig.upsert(w);
      },
    } as WorkspaceConfigRepository;

    const res = await provisionWorkspace(
      { workspaceConfig: faulting, readModels: b.repos.readModels, now: b.now },
      EMPLOYER,
    );

    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("store_fault");
    expect(upserts).toBe(0); // a transient fault must never bypass the guard
  });
});
