// Task 9.21-A (worker producer leg) — RED-first spec.
//
// THE DEFECT: `provisionWorkspace` has five distinct store-side failure points but only three error
// codes (`invalid_workspace` / `workspace_type_immutable` / `store_fault`). Two of those five sites —
// a `registerWorkspace` fault on the CREATE path and on the SAME-TYPE path — leave a durable side
// effect behind (the config row IS written) yet report the generic `store_fault`, identical to "nothing
// happened." The fail-closed ordering (`provisionWorkspace.ts:284-293`, "insert the whole seeded
// aggregate FIRST") already makes this state SAFE (invisible to scoped reads, WS-8 holds) — it is just
// indistinguishable from a no-op, so a caller can't offer resume instead of a dead end.
//
// This slice adds a fourth, distinct `partial_scaffold` outcome for exactly those two sites, and PINS
// the resume path that already works (`provisionWorkspace.ts:275-281` unions into the registry on the
// same-type branch too) — it is not being built here, it is being proven and guarded against regression.
//
// ⚠ THE BOUNDED REVOKE GUARANTEE, restated because 9.21 is what makes re-provision ROUTINE: a
// re-provision can no longer restore a revoked egress ack — durable per workspace ROW, not per VAULT.
// Bounds: #38 (the revoke side is still a whole-aggregate upsert, so a concurrent RENAME can be lost —
// benign direction) and #39 (a foreign `egressPolicy.workspaceId` is detected nowhere; unguarded before
// 9.30 and not opened by it). Never write "the revoke is durable" unqualified.
//
// Sibling-file placement (Step 2.5 Q5): kept separate from `provision-preserves-egress-posture.test.ts`
// (9.23/9.29/9.30) because that file's identity is the egress-POSTURE-preservation invariant and this
// slice's concern is the FAILURE-TAXONOMY / resume-affordance — a different axis, even though test 4
// below touches both. Test 4 stays here rather than splitting the "partial → resume" story across two
// files.
import { describe, it, expect, afterEach } from "vitest";
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type { Workspace } from "@sow/contracts";
import type { DbError, ReadModelRecord, ReadModelRepository } from "@sow/db";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import {
  provisionWorkspace,
  type ProvisionedWorkspace,
  type ProvisionWorkspaceDeps,
  type ProvisionWorkspaceSpec,
} from "../../src/composition/provisionWorkspace";
import { createEgressCommandPort } from "../../src/composition/egressRevoke";
import { READ_MODEL_KEYS } from "../../src/api/adapters/readModel";

const NOW = "2026-07-29T00:00:00.000Z";

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
async function registryIds(b: ProofSpineBackends): Promise<readonly string[]> {
  const r = await b.repos.readModels.get(READ_MODEL_KEYS.registry, null);
  if (isErr(r)) return [];
  const data = r.value.data as { workspaceIds?: unknown };
  return Array.isArray(data.workspaceIds) ? (data.workspaceIds.filter((x) => typeof x === "string") as string[]) : [];
}

/**
 * A `ReadModelRepository` whose `.get` passes straight through to the real backend but whose `.put`
 * always faults — the ONLY read-model write inside `provisionWorkspace`'s call graph is the registry
 * union (`registerWorkspace`), so this isolates a registry-union fault without touching the config
 * store. `driverMessage` is deliberately driver-shaped (test 6: it must never surface).
 */
function registryPutFaultingReadModels(
  b: ProofSpineBackends,
  driverMessage = "registry store down",
): ReadModelRepository {
  return {
    get: (key, workspaceId) => b.repos.readModels.get(key, workspaceId),
    put: (): Promise<Result<ReadModelRecord, DbError>> =>
      Promise.resolve(err({ code: "unavailable", message: driverMessage })),
    clear: (key) => b.repos.readModels.clear(key),
  };
}

describe("provisionWorkspace — the partial-scaffold outcome (9.21-A)", () => {
  it("create_path_registry_fault_returns_partial_not_store_fault", async () => {
    const b = await fresh();
    const res = await provisionWorkspace(
      { workspaceConfig: b.repos.workspaceConfig, readModels: registryPutFaultingReadModels(b), now: b.now },
      EMPLOYER,
    );
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.code).toBe("partial_scaffold");
      if (res.error.code === "partial_scaffold") {
        expect(res.error.configWritten).toBe(true);
        expect(res.error.incompleteStep).toBe("registry_union");
      }
    }
    // The config row IS durably written (the fail-closed insert-first ordering, :256-259) …
    const cfg = await b.repos.workspaceConfig.get(EMPLOYER.id as Workspace["id"]);
    expect(isOk(cfg)).toBe(true);
    // … but NOT registered — a scoped read still fails closed (WS-8 holds).
    expect(await registryIds(b)).not.toContain(EMPLOYER.id);
  });

  it("same_type_path_registry_fault_returns_partial", async () => {
    const b = await fresh();
    expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);

    const renamed: ProvisionWorkspaceSpec = { ...EMPLOYER, name: "Employer Work (renamed)" };
    const res = await provisionWorkspace(
      { workspaceConfig: b.repos.workspaceConfig, readModels: registryPutFaultingReadModels(b), now: b.now },
      renamed,
    );
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("partial_scaffold");

    // The same-type update itself durably landed even though the registry union faulted afterward —
    // the repair path (:249-252) runs the union AFTER the config write, same ordering as create.
    const cfg = await b.repos.workspaceConfig.get(EMPLOYER.id as Workspace["id"]);
    expect(isOk(cfg) && cfg.value.name).toBe("Employer Work (renamed)");
  });

  it("resume_after_partial_completes_the_union", async () => {
    const b = await fresh();
    const first = await provisionWorkspace(
      { workspaceConfig: b.repos.workspaceConfig, readModels: registryPutFaultingReadModels(b), now: b.now },
      EMPLOYER,
    );
    expect(isErr(first)).toBe(true);
    if (isErr(first)) expect(first.error.code).toBe("partial_scaffold");
    expect(await registryIds(b)).not.toContain(EMPLOYER.id);

    // Resume: re-provision same-type with a HEALTHY registry — the Done-when clause that is already
    // satisfied by shipped code (:249-252); this test is what keeps it satisfied.
    const second = await provisionWorkspace(deps(b), EMPLOYER);
    expect(isOk(second)).toBe(true);
    if (isOk(second)) expect(second.value.registryMember).toBe(true);
    expect(await registryIds(b)).toContain(EMPLOYER.id);
  });

  it("resume_does_not_restore_a_revoked_ack", async () => {
    const b = await fresh();
    // 1) a create left config-written-but-unregistered (the ack seed IS in the durably-written row).
    const first = await provisionWorkspace(
      { workspaceConfig: b.repos.workspaceConfig, readModels: registryPutFaultingReadModels(b), now: b.now },
      EMPLOYER,
    );
    expect(isErr(first)).toBe(true);

    // 2) the OWNER revokes, through the real 9.10-B command, on the durably-written (unregistered) row.
    const revoke = createEgressCommandPort({
      workspaceConfig: b.repos.workspaceConfig,
      audit: b.repos.audit,
      now: () => NOW,
    });
    expect(isOk(await revoke.revokeEgressAck({ workspaceId: EMPLOYER.id }))).toBe(true);
    const revoked = await b.repos.workspaceConfig.get(EMPLOYER.id as Workspace["id"]);
    expect(isOk(revoked)).toBe(true);
    if (!isOk(revoked)) return;
    expect(revoked.value.egressPolicy.employerRawEgressAcknowledged).toBe(false);

    // 3) resume via a same-type re-provision, now with a healthy registry — 9.21 makes this ROUTINE,
    //    which is exactly what the 9.23/9.30 guarantee must hold under (bounded per ROW, not per VAULT).
    const resume = await provisionWorkspace(deps(b), EMPLOYER);
    expect(isOk(resume)).toBe(true);

    const after = await b.repos.workspaceConfig.get(EMPLOYER.id as Workspace["id"]);
    expect(isOk(after)).toBe(true);
    if (isOk(after)) expect(after.value.egressPolicy).toEqual(revoked.value.egressPolicy);
    expect(await registryIds(b)).toContain(EMPLOYER.id);
  });

  it("a_partial_is_not_constructible_as_ok", () => {
    // worker L31: `ProvisionedWorkspace.registryMember` is the literal `true` — "registry-member by
    // construction." A partial is a failed operation with a durable side effect, not a success; widening
    // this to `boolean` would delete that structural guarantee to model a failure as a success (Q1).
    // Non-vacuity verified by mutation (per 9.34 / worker L28): temporarily aliasing the literal to
    // `boolean` in provisionWorkspace.ts makes the directive below go UNUSED, which `tsc` reports as its
    // own error (`reportUnusedTsExpectErrorDirective` is on by default) — verified by hand, reverted,
    // never committed. Reported in Step 9, not re-run here (a committed mutation would defeat the pin).
    // @ts-expect-error — registryMember is the literal `true`; `false` must not typecheck.
    const partial: ProvisionedWorkspace = { id: "x", registryMember: false, preset: "simple" };
    expect(partial).toBeDefined();
  });

  it("partial_outcome_carries_no_raw_cause", async () => {
    const b = await fresh();
    const driverMessage = "ECONNREFUSED 10.0.0.1:5432 — raw driver detail, must never surface";
    const res = await provisionWorkspace(
      { workspaceConfig: b.repos.workspaceConfig, readModels: registryPutFaultingReadModels(b, driverMessage), now: b.now },
      EMPLOYER,
    );
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.code).toBe("partial_scaffold");
      expect(JSON.stringify(res.error)).not.toContain(driverMessage);
      expect(JSON.stringify(res.error)).not.toContain("ECONNREFUSED");
    }
  });

  // ── totality across every store-side fault site (never a throw) ────────────────────────────────
  const permutations: {
    readonly name: string;
    readonly seedFirst?: true;
    readonly build: (b: ProofSpineBackends) => ProvisionWorkspaceDeps;
  }[] = [
    {
      name: "existence_check_get_fault",
      build: (b) => ({
        workspaceConfig: { ...b.repos.workspaceConfig, get: async () => err({ code: "unavailable", message: "x" }) },
        readModels: b.repos.readModels,
        now: b.now,
      }),
    },
    {
      name: "create_insert_fault",
      build: (b) => ({
        workspaceConfig: { ...b.repos.workspaceConfig, insertIfAbsent: async () => err({ code: "unavailable", message: "x" }) },
        readModels: b.repos.readModels,
        now: b.now,
      }),
    },
    {
      name: "create_concurrent_row",
      build: (b) => ({
        workspaceConfig: { ...b.repos.workspaceConfig, insertIfAbsent: async () => ok(false) },
        readModels: b.repos.readModels,
        now: b.now,
      }),
    },
    {
      name: "create_registry_union_fault",
      build: (b) => ({ workspaceConfig: b.repos.workspaceConfig, readModels: registryPutFaultingReadModels(b), now: b.now }),
    },
    {
      name: "same_type_update_fault",
      seedFirst: true,
      build: (b) => ({
        workspaceConfig: { ...b.repos.workspaceConfig, updateProvisioningFields: async () => err({ code: "unavailable", message: "x" }) },
        readModels: b.repos.readModels,
        now: b.now,
      }),
    },
    {
      name: "same_type_registry_union_fault",
      seedFirst: true,
      build: (b) => ({ workspaceConfig: b.repos.workspaceConfig, readModels: registryPutFaultingReadModels(b), now: b.now }),
    },
  ];

  for (const perm of permutations) {
    it(`every_fault_permutation_is_total — ${perm.name}`, async () => {
      const b = await fresh();
      if (perm.seedFirst) expect(isOk(await provisionWorkspace(deps(b), EMPLOYER))).toBe(true);
      const d = perm.build(b);
      let threw = false;
      let res: Result<ProvisionedWorkspace, unknown> | undefined;
      try {
        res = await provisionWorkspace(d, EMPLOYER);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(res !== undefined && isErr(res)).toBe(true);
      if (res !== undefined && isErr(res)) {
        expect(["store_fault", "partial_scaffold"]).toContain((res.error as { code: string }).code);
      }
    });
  }

  it("unrelated_store_faults_keep_their_code — existence-check, insert, concurrent-row, and same-type-update faults remain store_fault", async () => {
    const b = await fresh();

    const getFault = await provisionWorkspace(
      {
        workspaceConfig: { ...b.repos.workspaceConfig, get: async () => err({ code: "unavailable", message: "x" }) },
        readModels: b.repos.readModels,
        now: b.now,
      },
      EMPLOYER,
    );
    expect(isErr(getFault) && getFault.error.code).toBe("store_fault");

    const insertFault = await provisionWorkspace(
      {
        workspaceConfig: { ...b.repos.workspaceConfig, insertIfAbsent: async () => err({ code: "unavailable", message: "x" }) },
        readModels: b.repos.readModels,
        now: b.now,
      },
      EMPLOYER,
    );
    expect(isErr(insertFault) && insertFault.error.code).toBe("store_fault");

    const concurrentRow = await provisionWorkspace(
      {
        workspaceConfig: { ...b.repos.workspaceConfig, insertIfAbsent: async () => ok(false) },
        readModels: b.repos.readModels,
        now: b.now,
      },
      EMPLOYER,
    );
    expect(isErr(concurrentRow) && concurrentRow.error.code).toBe("store_fault");

    expect(isOk(await provisionWorkspace(deps(b), PERSONAL))).toBe(true);
    const updateFault = await provisionWorkspace(
      {
        workspaceConfig: { ...b.repos.workspaceConfig, updateProvisioningFields: async () => err({ code: "unavailable", message: "x" }) },
        readModels: b.repos.readModels,
        now: b.now,
      },
      PERSONAL,
    );
    expect(isErr(updateFault) && updateFault.error.code).toBe("store_fault");
  });
});
