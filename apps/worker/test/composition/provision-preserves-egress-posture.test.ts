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
//
// The final `describe` block is task 9.29 — the SIBLING fields (`providerMatrix`/`defaultVisibility`/
// `dataOwner`), which a re-provision also rebuilds. That slice deliberately ships no carry-forward; see
// `provisionWorkspace.ts` branch 2b for the traced decision and the per-field safety asymmetry.
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("a_corrupt_stored_policy_can_never_re_cross_into_a_write — 9.23's re-gate, superseded (9.30)", async () => {
    // ⚠ THIS PIN CHANGED MEANING AT 9.30, deliberately. Under 9.23 the same-type branch carried the
    // stored `egressPolicy` into a whole-aggregate write, so a row bearing a FOREIGN
    // `egressPolicy.workspaceId` could have been grafted onto this workspace — and the
    // `WorkspaceSchema.parse` re-gate existed to refuse that (the only validation a blob read through
    // the repo's unchecked `row as Workspace` cast would ever get).
    //
    // Option A removes the premise instead of the protection: provisioning now writes three
    // caller-derived primitives and never reads the stored blob into a write at all. So the re-gate is
    // not "dropped" — the thing it guarded cannot occur. This asserts that stronger property directly:
    // whatever corruption the row carries, NO whole-aggregate write happens and nothing from the blob
    // is echoed back.
    //
    // Out of scope, still true, tracked elsewhere: a corrupt row is still SERVED on the read path
    // (`storeBackedWorkspacePosture` compares `ws.id` but not `ws.egressPolicy.workspaceId`). This
    // slice hardens the write; the read-side re-gate is its own follow-up.
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
    const narrowWrites: { readonly name: string; readonly markdownRepoPath: string; readonly gbrainBrainId: string }[] = [];
    const injected: WorkspaceConfigRepository = {
      get: (): Promise<Result<Workspace, DbError>> => Promise.resolve({ ok: true, value: corrupt }),
      list: (): Promise<Result<Workspace[], DbError>> => Promise.resolve({ ok: true, value: [corrupt] }),
      upsert: (w: Workspace): Promise<Result<Workspace, DbError>> => {
        upserted = w;
        return b.repos.workspaceConfig.upsert(w);
      },
      insertIfAbsent: () => Promise.resolve({ ok: true, value: false } as const),
      updateProvisioningFields: (_id, fields): Promise<Result<Workspace, DbError>> => {
        narrowWrites.push({ name: fields.name, markdownRepoPath: fields.markdownRepoPath, gbrainBrainId: String(fields.gbrainBrainId) });
        return Promise.resolve({ ok: true, value: corrupt });
      },
    };

    const res = await provisionWorkspace(
      { workspaceConfig: injected, readModels: b.repos.readModels, now: b.now },
      EMPLOYER,
    );

    // Under Option A the corrupt row is simply not this write's business: provisioning updates its own
    // fields and succeeds. It neither launders the corruption nor pretends to repair it.
    expect(isOk(res)).toBe(true);
    // THE load-bearing assertions: no whole-aggregate write happened…
    expect(upserted).toBeUndefined();
    // …and the only write carried caller-derived values, never anything read off the corrupt blob.
    expect(narrowWrites).toEqual([
      { name: EMPLOYER.name, markdownRepoPath: EMPLOYER.vaultRoot, gbrainBrainId: EMPLOYER.gbrainBrainId },
    ]);
  });

  it("revoke_preserves_provisioning_owned_fields — the OTHER writer resets nothing (9.29)", async () => {
    // The second of the two config writers. It spreads the stored aggregate and touches only
    // `egressPolicy`, so it cannot reset — or introduce — a provisioning-owned value. Pinned
    // behaviourally so the census below is not the only thing holding this.
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), PERSONAL))).toBe(true);
    const cfg = await b.repos.workspaceConfig.get(PERSONAL.id as Workspace["id"]);
    expect(isOk(cfg)).toBe(true);
    if (!isOk(cfg)) return;

    // A stored aggregate carrying NON-default values in all three provisioning-owned fields.
    const configured: Workspace = {
      ...cfg.value,
      defaultVisibility: "coordination",
      dataOwner: "employer",
      providerMatrix: {
        ...cfg.value.providerMatrix,
        allowedProviders: ["ollama"],
        rawCloudEgressEnabled: true,
      },
      egressPolicy: {
        ...cfg.value.egressPolicy,
        employerRawEgressAcknowledged: true,
        acknowledgedAt: NOW,
      },
    };
    expect(isOk(await b.repos.workspaceConfig.upsert(configured))).toBe(true);

    const revoke = createEgressCommandPort({
      workspaceConfig: b.repos.workspaceConfig,
      audit: b.repos.audit,
      now: () => NOW,
    });
    expect(isOk(await revoke.revokeEgressAck({ workspaceId: PERSONAL.id }))).toBe(true);

    const after = await b.repos.workspaceConfig.get(PERSONAL.id as Workspace["id"]);
    expect(isOk(after)).toBe(true);
    if (!isOk(after)) return;
    expect(after.value.defaultVisibility).toBe("coordination");
    expect(after.value.dataOwner).toBe("employer");
    expect(after.value.providerMatrix.allowedProviders).toEqual(["ollama"]);
    expect(after.value.providerMatrix.rawCloudEgressEnabled).toBe(true);
    expect(after.value.egressPolicy.employerRawEgressAcknowledged).toBe(false); // the revoke's own job
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
      // Counted too: the pin proves NO write of any kind happens on an unknown prior state.
      insertIfAbsent: () => Promise.resolve({ ok: true, value: false } as const),
      updateProvisioningFields: (): Promise<Result<Workspace, DbError>> => {
        upserts += 1;
        return Promise.resolve({ ok: false, error: { code: "unavailable", message: "unreachable" } as DbError });
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

describe("provisionWorkspace — the write is narrowed to provisioning-owned fields (9.30)", () => {
  it("interleaved_revoke_is_not_silently_reverted — a revoke between the get and the write SURVIVES", async () => {
    // THE RACE 9.23 left. `provisionWorkspace` reads the row (existence/type check), then writes. A
    // `revokeEgressAck` landing in that window was silently clobbered by the write carrying the
    // pre-revoke policy — 9.23's own defect narrowed to a race, still with no audit row.
    //
    // ⚠ The sibling `workspaceRegistry`'s `arch_gap (concurrency)` note does NOT justify accepting this
    // one: it accepts its race because the direction is fail-SAFE (a dropped id goes invisible) and "a
    // re-provision repairs it". Here a lost update reverts a revoke — fail-OPEN — and a re-provision is
    // what CAUSES it. Option A closes it by construction: provisioning no longer writes the egress
    // column at all, so there is nothing for a concurrent revoke to lose.
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);
    expect((await storedPolicy(b, EMPLOYER.id)).employerRawEgressAcknowledged).toBe(true);

    const revoke = createEgressCommandPort({
      workspaceConfig: b.repos.workspaceConfig,
      audit: b.repos.audit,
      now: () => NOW,
    });

    // Interleave for real: fire the revoke from inside the repo `get` the provisioner is awaiting, so
    // the revoke is durably committed BEFORE the provisioner reaches its write.
    let raced = false;
    const racing: WorkspaceConfigRepository = {
      get: async (id) => {
        const r = await b.repos.workspaceConfig.get(id);
        if (!raced) {
          raced = true;
          await revoke.revokeEgressAck({ workspaceId: EMPLOYER.id });
        }
        return r;
      },
      list: () => b.repos.workspaceConfig.list(),
      upsert: (w) => b.repos.workspaceConfig.upsert(w),
      insertIfAbsent: () => Promise.resolve({ ok: true, value: false } as const),
      updateProvisioningFields: (id, fields) =>
        b.repos.workspaceConfig.updateProvisioningFields(id, fields),
    };

    const res = await provisionWorkspace(
      { workspaceConfig: racing, readModels: b.repos.readModels, now: b.now },
      EMPLOYER,
    );
    expect(isOk(res)).toBe(true);
    expect(raced).toBe(true); // non-vacuity: the interleave really happened

    // The owner's revoke WINS. Before Option A this read `true` — the revoke silently reverted.
    const after = await storedPolicy(b, EMPLOYER.id);
    expect(after.employerRawEgressAcknowledged).toBe(false);
    expect(after.acknowledgedAt).toBeUndefined();
  });

  it("create_branch_conflict_does_not_restore_a_revoked_ack — the OTHER half of the same race", async () => {
    // Caught in review: narrowing the same-type write closed the race on ONE branch, while the CREATE
    // branch kept the identical shape — `get` says not_found, then a blind
    // `INSERT … ON CONFLICT DO UPDATE SET <every column>`. If the row appears in that window and the
    // owner revokes, the conflict-update writes the freshly-seeded `ack=true` straight back over the
    // revoke. Same defect, same function, on the branch nobody narrowed — and the slice's own comment
    // claimed the race was closed. A create must never silently adopt an existing row's identity.
    const b = await fresh();

    let raced = false;
    const racing: WorkspaceConfigRepository = {
      get: async (id) => {
        const r = await b.repos.workspaceConfig.get(id);
        if (!raced) {
          raced = true;
          // The row appears AFTER our not_found, then the owner revokes on it.
          await provisionWorkspace(deps(b), EMPLOYER);
          await createEgressCommandPort({
            workspaceConfig: b.repos.workspaceConfig,
            audit: b.repos.audit,
            now: () => NOW,
          }).revokeEgressAck({ workspaceId: EMPLOYER.id });
        }
        return r; // …but WE still hold the stale not_found
      },
      list: () => b.repos.workspaceConfig.list(),
      upsert: (w) => b.repos.workspaceConfig.upsert(w),
      insertIfAbsent: () => Promise.resolve({ ok: true, value: false } as const),
      updateProvisioningFields: (id, f) => b.repos.workspaceConfig.updateProvisioningFields(id, f),
    };

    const res = await provisionWorkspace(
      { workspaceConfig: racing, readModels: b.repos.readModels, now: b.now },
      EMPLOYER,
    );
    expect(raced).toBe(true); // non-vacuity: the interleave really happened

    // Either the create fails loudly, or it must not have clobbered the revoke. What it may NOT do is
    // report success while silently restoring `ack=true`.
    const after = await storedPolicy(b, EMPLOYER.id);
    expect(after.employerRawEgressAcknowledged).toBe(false);
    expect(after.acknowledgedAt).toBeUndefined();
    if (isErr(res)) expect(res.error.code).toBe("store_fault");
  });

  it("provisioning_write_cannot_touch_egress_state — the carry-forward is dead BY CONSTRUCTION", async () => {
    // 9.23 carried `egressPolicy` forward on the same-type branch. Under Option A provisioning never
    // writes that column, so the carry is moot — and this pin is why deleting it is safe to read as
    // deliberate rather than as a dropped safety mechanism: the write path structurally cannot reach
    // egress state, whatever it was carrying.
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);

    // Set a posture no re-provision could reproduce from spec defaults.
    const cfg = await b.repos.workspaceConfig.get(EMPLOYER.id as Workspace["id"]);
    expect(isOk(cfg)).toBe(true);
    if (!isOk(cfg)) return;
    const marked: Workspace = {
      ...cfg.value,
      egressPolicy: {
        ...cfg.value.egressPolicy,
        allowedProcessors: [processorId("ollama")],
        rawContentAllowedProcessors: [],
        employerRawEgressAcknowledged: false,
      },
    };
    delete (marked.egressPolicy as { acknowledgedAt?: string }).acknowledgedAt;
    expect(isOk(await b.repos.workspaceConfig.upsert(marked))).toBe(true);

    // Re-provision with DIFFERENT provisioning-owned values, so the write definitely runs.
    expect(
      isOk(await provisionWorkspace(deps(b), { ...EMPLOYER, name: "Renamed", vaultRoot: "/moved" })),
    ).toBe(true);

    expect(await storedPolicy(b, EMPLOYER.id)).toEqual(marked.egressPolicy);
  });

  it("same_type_write_updates_only_provisioning_owned_fields — name/vaultRoot/brain move, nothing else", async () => {
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), PERSONAL))).toBe(true);
    const before = await b.repos.workspaceConfig.get(PERSONAL.id as Workspace["id"]);
    expect(isOk(before)).toBe(true);
    if (!isOk(before)) return;

    expect(
      isOk(
        await provisionWorkspace(deps(b), {
          ...PERSONAL,
          name: "Renamed Side Business",
          vaultRoot: "/vaults/moved",
          gbrainBrainId: "brain-moved",
        }),
      ),
    ).toBe(true);

    const after = await b.repos.workspaceConfig.get(PERSONAL.id as Workspace["id"]);
    expect(isOk(after)).toBe(true);
    if (!isOk(after)) return;
    // Provisioning-owned ⇒ updated.
    expect(after.value.name).toBe("Renamed Side Business");
    expect(after.value.markdownRepoPath).toBe("/vaults/moved");
    expect(after.value.gbrainBrainId).toBe("brain-moved");
    // NOT provisioning-owned ⇒ byte-identical (this is 9.29's invariant, now structural).
    expect(after.value.egressPolicy).toEqual(before.value.egressPolicy);
    expect(after.value.providerMatrix).toEqual(before.value.providerMatrix);
    expect(after.value.defaultVisibility).toBe(before.value.defaultVisibility);
    expect(after.value.dataOwner).toBe(before.value.dataOwner);
    expect(after.value.type).toBe(before.value.type);
  });
});

// ── 9.29: the provisioning-owned-fields invariant, as a TRIPWIRE ────────────────────────────────
//
// WHY A CENSUS AND NOT A BEHAVIOURAL TEST — the one argument that is genuinely test-local. A
// "stored == defaults after re-provision" test passes both BEFORE and AFTER a post-provision writer
// appears, so it could never warn anyone. A WRITER CENSUS fails at exactly the moment the
// carry-forward question becomes real.
//
// The decision this guards (why no carry-forward, and the per-field FAIL-CLOSED/FAIL-OPEN asymmetry
// that makes `dataOwner` the field it really exists for) is stated ONCE, at the decision site:
// `provisionWorkspace.ts` branch 2b. Do not restate it here — two copies drift.

/**
 * Every mutating method on `WorkspaceConfigRepository`. ⚠ 9.30 added `updateProvisioningFields`; the
 * classifier keyed only on `.upsert(` and would have silently STOPPED seeing `provisionWorkspace` once
 * it switched — a census that quietly loses a writer is worse than none. Grow this list whenever the
 * repo grows a mutator, or the tripwire rots into a pass-by-omission.
 */
const WORKSPACE_CONFIG_WRITE_METHODS = ["insertIfAbsent", "updateProvisioningFields", "upsert"] as const;

/** Is `source` a production file that both knows the repo type AND writes through it? */
function isWorkspaceConfigWriter(source: string): boolean {
  if (!source.includes("WorkspaceConfigRepository")) return false;
  return WORKSPACE_CONFIG_WRITE_METHODS.some((m) => new RegExp(`\\.${m}\\(`).test(source));
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Every TRACKED production `.ts` under apps/ + packages/ (test files excluded). */
function trackedProductionSources(): string[] {
  let out = "";
  try {
    out = execSync("git ls-files -- 'apps/**/*.ts' 'packages/**/*.ts'", {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch {
    out = "";
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !p.includes(".test.") && !p.includes("/test/"));
}

/**
 * Repo-relative paths of every production workspace-config writer. Anchored to `git ls-files` rather
 * than a working-tree grep: tracked-only is deterministic across machines and CI, and needs no
 * exclude-list to chase (this checkout carries `graphify-out/`, `out/`, `.turbo/` … any of which
 * could otherwise yield a false red that has nothing to do with a new writer).
 */
function workspaceConfigWriters(): string[] {
  return trackedProductionSources()
    .map((p) => {
      try {
        return isWorkspaceConfigWriter(readFileSync(resolve(repoRoot, p), "utf8")) ? p : null;
      } catch {
        // Unreadable ⇒ surface rather than silently drop a possible writer, and say WHY in the value
        // so the failure diff self-explains instead of looking like a mystery third writer.
        return `${p} (unreadable)`;
      }
    })
    .filter((p): p is string => p !== null)
    .sort();
}

const REVISIT_PER_FIELD =
  "a 3rd workspace-config writer appeared — re-decide the carry-forward PER FIELD at provisionWorkspace branch 2b; " +
  "`dataOwner` is the one whose reset is FAIL-OPEN (it removes the employer branch of the §5 egress veto)";

describe("workspace-config writer census — the 9.29 tripwire", () => {
  it("writers_are_exactly_the_two_known — a third writer makes the carry-forward question real", () => {
    // Scoped by the repo TYPE rather than the string `workspaceConfig.upsert(`, so renaming the local
    // variable cannot slip a writer past this.
    expect(workspaceConfigWriters(), REVISIT_PER_FIELD).toEqual([
      "apps/worker/src/composition/egressRevoke.ts",
      "apps/worker/src/composition/provisionWorkspace.ts",
    ]);
  });

  it("direct_table_writers_are_the_two_adapters — the census's structural blind spot, pinned", () => {
    // The census above can only see files that name `WorkspaceConfigRepository`. A writer going
    // straight to drizzle (`db.insert(schema.workspaceConfig)`) — a future seeder, migration, or repair
    // path — would be invisible to it. That surface is small and enumerable, so pin it directly.
    const direct = trackedProductionSources()
      .filter((p) => {
        try {
          const src = readFileSync(resolve(repoRoot, p), "utf8");
          return src.includes("schema.workspaceConfig") && /\.(insert|update|delete)\(/.test(src);
        } catch {
          return true;
        }
      })
      .sort();
    expect(direct, REVISIT_PER_FIELD).toEqual([
      "packages/db/src/adapters/postgres/index.ts",
      "packages/db/src/adapters/sqlite/index.ts",
    ]);
  });

  it("no_sql_migration_writes_workspace_config — the other blind spot both censuses share", () => {
    // Both censuses above scan `.ts` only, yet the second one's own comment names "a migration" as a
    // shape it is meant to catch. A data migration (`UPDATE workspace_config SET …`) is neither a
    // repo-type writer nor a drizzle call, so it would be invisible to both. The table may be CREATEd;
    // it may not be written.
    let sql = "";
    try {
      sql = execSync("git ls-files -- 'packages/db/migrations/**/*.sql'", {
        cwd: repoRoot,
        encoding: "utf8",
      });
    } catch {
      sql = "";
    }
    const writers = sql
      .split("\n")
      .filter(Boolean)
      .filter((p) => {
        try {
          const src = readFileSync(resolve(repoRoot, p), "utf8");
          return /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+["'`]?workspace_config\b/i.test(src);
        } catch {
          return true;
        }
      });
    expect(writers, REVISIT_PER_FIELD).toEqual([]);
  });

  it("census_discovery_really_scans — the scan is non-empty and sees known read-only consumers", () => {
    // The vacuity mode that matters for a filesystem census is DISCOVERY returning nothing (bad
    // repoRoot, a grep that matched no files, an over-broad filter) — in which case the writer list is
    // trivially short and the pin passes while proving nothing. Assert the scan really ran: it must
    // include a file that names the repo type but never upserts.
    const scanned = trackedProductionSources();
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned).toContain("apps/worker/src/api/adapters/storeBackedWorkspacePosture.ts");
  });

  it("markdownRepoPath_has_no_production_consumer — the 9.31 bound, pinned (not just asserted)", () => {
    // 9.23 + 9.30 make the revoke durable per workspace ROW. They do NOT make it durable per VAULT: a
    // NEW workspace id pointed at the same vault root is a fresh create, and a fresh create seeds
    // ack=true. That is a BOUND rather than a hole only because nothing reads the field — the running
    // worker's vault comes from boot config, so two workspaces "sharing a vault root" is not a state
    // anything can act on.
    //
    // That premise is exactly the kind that rots silently, so pin it instead of trusting the prose:
    // the day a consumer reads `markdownRepoPath` to bind work to a workspace, this fires and the
    // vault-scope question becomes real.
    const readers = trackedProductionSources().filter((p) => {
      // The model, the db (de)serialization, and provisioning WRITING it are not consumers.
      // Narrow, FILE-level exclusions only — the model, the two db (de)serializers, and the writer.
      // ⚠ Deliberately NOT excluding `backends.ts` or all of `packages/db/`: those are the two places a
      // real consumer would most plausibly appear (`createFsVault(ws.markdownRepoPath)`, or a
      // lookup-by-vault-path query), i.e. exactly what this pin exists to catch.
      const EXEMPT = [
        "packages/contracts/src/models/workspace.ts",
        "packages/db/src/schema/workspace-config.ts",
        "packages/db/src/schema/pg/workspace-config.ts",
        "packages/db/src/adapters/sqlite/index.ts",
        "packages/db/src/adapters/postgres/index.ts",
        "apps/worker/src/composition/provisionWorkspace.ts",
        // DECLARATION sites, not consumers: the write-side field list 9.30 added, and a sample
        // Workspace. Neither binds work to a vault path — which is the only thing this pin is about.
        "packages/db/src/repositories/interfaces.ts",
        "packages/contracts/src/fixtures/valid.ts",
      ];
      if (EXEMPT.includes(p)) return false;
      try {
        // Strip comments first: prose mentioning the field (this slice added some) is not a consumer,
        // and excluding whole files to accommodate prose would disarm the pin where it matters most.
        const src = readFileSync(resolve(repoRoot, p), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        return src.includes("markdownRepoPath");
      } catch {
        return true;
      }
    });
    expect(
      readers,
      "something now reads Workspace.markdownRepoPath — the 9.31 vault-scope bound may have become a real second door onto a revoked egress posture; re-read provisionWorkspace branch 2b",
    ).toEqual([]);
  });

  it("census_covers_every_repo_write_method — the classifier cannot rot into pass-by-omission", () => {
    // The failure mode 9.30 nearly caused: the repo grows a mutator, the classifier still keys on the
    // old one, and a real writer stops being counted — the census passes because it went BLIND, not
    // because the invariant holds. Pin the method list against the interface itself.
    const iface = readFileSync(
      resolve(repoRoot, "packages/db/src/repositories/interfaces.ts"),
      "utf8",
    );
    const block = iface.slice(iface.indexOf("interface WorkspaceConfigRepository"));
    const body = block.slice(0, block.indexOf("\n}"));
    const declared = [...body.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
    const mutators = declared.filter((m) => m !== "get" && m !== "list");
    expect([...mutators].sort()).toEqual([...WORKSPACE_CONFIG_WRITE_METHODS].sort());
  });

  it("census_classifier_catches_a_writer_and_spares_a_reader — catch-power", () => {
    const synthetic = [
      'import type { WorkspaceConfigRepository } from "@sow/db";',
      "export async function repairWorkspace(repo: WorkspaceConfigRepository, ws: Workspace) {",
      "  return repo.upsert({ ...ws, defaultVisibility: 'coordination' });",
      "}",
    ].join("\n");
    expect(isWorkspaceConfigWriter(synthetic)).toBe(true);

    const readOnly = [
      'import type { WorkspaceConfigRepository } from "@sow/db";',
      "export const posture = (repo: WorkspaceConfigRepository, id: string) => repo.get(id);",
    ].join("\n");
    expect(isWorkspaceConfigWriter(readOnly)).toBe(false);
  });
});
