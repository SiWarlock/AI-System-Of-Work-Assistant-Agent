// Task 14.1 (worker leg) — the PRODUCTION workspace-provisioning path. RED-first spec.
//
// `provisionWorkspace` is the production replacement for the dev-only
// `provisionDevWorkspace` fixture: it builds a VALIDATED `Workspace` via the
// safe-default `defaultWorkspace()` factory (egress CLOSED, `isolated` visibility —
// safety rule 5), upserts it into the durable `WorkspaceConfigRepository`
// (OPERATIONAL TRUTH), and unions its id into the fail-closed WS-8 `{workspaceIds}`
// registry read-model — the SOLE visibility authority (lead ruling #1). No dev
// checkbox-parse, no read-model card seeding (that stays `provisionDev`-only).
//
// SAFETY-CRITICAL (WS-8 / safety rule 4 & 5). The load-bearing invariant: the
// REGISTRY — never the config store — decides whether a workspace-scoped read
// resolves. A `WorkspaceConfig` row that was never unioned into the registry is
// still ZERO read path. A genuine registry store fault is a typed err, NEVER a
// fold-to-empty (that would DROP known workspaces → fail their scoped reads closed).
//
// The happy-path + WS-8 pins run over the REAL @sow/db backends (`assembleBackends`,
// in-memory sqlite) exercising the REAL `WorkspaceConfigRepository`, the REAL
// registry, and the REAL `resolveKnownWorkspace` (through `createDbReadModelQueryPort`).
// The store-fault pin injects a faulting `ReadModelRepository` fake.
import { describe, it, expect, afterEach } from "vitest";
import { ok, err, isErr, isOk, type Result, type Workspace } from "@sow/contracts";
import type { DbError, ReadModelRepository, ReadModelRecord, WorkspaceConfigRepository } from "@sow/db";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { createDbReadModelQueryPort, READ_MODEL_KEYS } from "../../src/api/adapters/readModel";
import {
  provisionWorkspace,
  type ProvisionWorkspaceDeps,
  type ProvisionWorkspaceSpec,
} from "../../src/composition/provisionWorkspace";

const NOW = "2026-07-15T00:00:00.000Z";

const SPEC_A: ProvisionWorkspaceSpec = {
  id: "employer-work",
  name: "Employer Work",
  type: "employer_work",
  vaultRoot: "/vaults/employer-work",
  gbrainBrainId: "brain-employer",
  preset: "professional",
};
const SPEC_B: ProvisionWorkspaceSpec = {
  id: "personal-business",
  name: "Side Business",
  type: "personal_business",
  vaultRoot: "/vaults/personal-business",
  gbrainBrainId: "brain-side",
  preset: "founder",
};

// ── real-backends harness (mirrors provision-dev.test.ts) ─────────────────────
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
function port(b: ProofSpineBackends): ReturnType<typeof createDbReadModelQueryPort> {
  return createDbReadModelQueryPort({ readModels: b.repos.readModels, approvals: b.repos.approvals });
}
/** Read the registry row's `workspaceIds` set directly (null-scoped global read-model). */
async function registryIds(b: ProofSpineBackends): Promise<readonly string[]> {
  const r = await b.repos.readModels.get(READ_MODEL_KEYS.registry, null);
  if (isErr(r)) return [];
  const data = r.value.data as { workspaceIds?: unknown };
  return Array.isArray(data.workspaceIds) ? (data.workspaceIds.filter((x) => typeof x === "string") as string[]) : [];
}

describe("provisionWorkspace (14.1 — production workspace provisioning path)", () => {
  it("provision_upserts_workspace_and_registers: upserts a validated Workspace AND unions the id into the registry [spec(§19.1)][spec(§5)]", async () => {
    const b = await fresh();
    const res = await provisionWorkspace(deps(b), SPEC_A);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.id).toBe("employer-work");
      expect(res.value.registryMember).toBe(true);
    }
    // Upserted into the durable operational store (data-about the workspace).
    const cfg = await b.repos.workspaceConfig.get("employer-work" as Workspace["id"]);
    expect(isOk(cfg)).toBe(true);
    if (isOk(cfg)) {
      expect(cfg.value.markdownRepoPath).toBe("/vaults/employer-work"); // vaultRoot → markdownRepoPath (no frozen-seam change)
      expect(cfg.value.gbrainBrainId).toBe("brain-employer");
    }
    // Unioned into the fail-closed registry — the SOLE visibility authority.
    expect(await registryIds(b)).toContain("employer-work");
  });

  it("config_row_without_registry_is_zero_read_path: a persisted WorkspaceConfig NOT unioned into the registry is still fail-closed (lead ruling #1) [spec(§5)]", async () => {
    const b = await fresh();
    // Seed ONLY the config store — the config row is data-ABOUT, never a read path.
    const { defaultWorkspace } = await import("@sow/contracts");
    await b.repos.workspaceConfig.upsert(
      defaultWorkspace({
        id: SPEC_A.id,
        name: SPEC_A.name,
        type: SPEC_A.type,
        markdownRepoPath: SPEC_A.vaultRoot,
        gbrainBrainId: SPEC_A.gbrainBrainId,
      }),
    );
    // The registry (SOLE authority) has no such id → a scoped read still fails closed.
    expect(await registryIds(b)).not.toContain("employer-work");
    const read = await port(b).workspaceCards("employer-work");
    expect(isErr(read)).toBe(true); // config row ⇒ ZERO read path (registry never populated)
  });

  it("scoped_read_fails_closed_before_resolves_after: a workspace-scoped read fails closed BEFORE provisioning, resolves AFTER [spec(§5)]", async () => {
    const b = await fresh();
    const before = await port(b).workspaceCards("employer-work");
    expect(isErr(before)).toBe(true); // unknown workspace → fail-closed
    await provisionWorkspace(deps(b), SPEC_A);
    const after = await port(b).workspaceCards("employer-work");
    expect(isOk(after)).toBe(true); // now a registry member → resolves (empty, un-seeded)
  });

  it("registry_union_preserves_prior_members: provisioning B after A leaves A known (no-drop union) [spec(§5)]", async () => {
    const b = await fresh();
    await provisionWorkspace(deps(b), SPEC_A);
    await provisionWorkspace(deps(b), SPEC_B);
    const ids = await registryIds(b);
    expect(ids).toContain("employer-work");
    expect(ids).toContain("personal-business");
    // Both scoped reads resolve (both registry members).
    expect(isOk(await port(b).workspaceCards("employer-work"))).toBe(true);
    expect(isOk(await port(b).workspaceCards("personal-business"))).toBe(true);
  });

  it("registry_union_idempotent: re-provisioning A is a no-op union (no duplicate id) + an overwrite upsert [spec(§5)]", async () => {
    const b = await fresh();
    await provisionWorkspace(deps(b), SPEC_A);
    const second = await provisionWorkspace(deps(b), { ...SPEC_A, name: "Renamed Employer" });
    expect(isOk(second)).toBe(true);
    // Registry carries A exactly once — no duplicate.
    expect((await registryIds(b)).filter((id) => id === "employer-work")).toHaveLength(1);
    // Upsert overwrote the config row (name updated) — one row, latest wins.
    const cfg = await b.repos.workspaceConfig.get("employer-work" as Workspace["id"]);
    expect(isOk(cfg) && cfg.value.name).toBe("Renamed Employer");
  });

  it("reonboard_changing_type_is_rejected: re-onboarding an existing id with a DIFFERENT type ⇒ workspace_type_immutable; config + registry UNCHANGED (the isolation/dataOwner class is immutable) [spec(§5)]", async () => {
    const b = await fresh();
    await provisionWorkspace(deps(b), SPEC_A); // employer_work → dataOwner "employer"
    // Attempt to re-onboard the SAME id with a different type — would flip dataOwner
    // employer→user (a latent rule-5 egress-veto downgrade). MUST be rejected.
    const res = await provisionWorkspace(deps(b), { ...SPEC_A, type: "personal_life" });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("workspace_type_immutable");
    // The existing config row is UNCHANGED — type + dataOwner (the isolation anchor) preserved.
    const after = await b.repos.workspaceConfig.get("employer-work" as Workspace["id"]);
    expect(isOk(after) && after.value.type).toBe("employer_work");
    expect(isOk(after) && after.value.dataOwner).toBe("employer");
    // Registry unchanged — A still known exactly once, nothing else added.
    expect((await registryIds(b)).filter((id) => id === "employer-work")).toHaveLength(1);
  });

  it("reonboard_get_fault_fails_closed: a fault on the pre-upsert existence-check get ⇒ store_fault, NO upsert, nothing unioned (the guard's fault branch fails closed) [spec(§5)]", async () => {
    const b = await fresh();
    let upsertCalls = 0;
    const faultingGetConfig: WorkspaceConfigRepository = {
      async get(): Promise<Result<Workspace, DbError>> {
        return err({ code: "unavailable", message: "config store down" }); // genuine fault, NOT not_found
      },
      async list(): Promise<Result<Workspace[], DbError>> {
        return ok([]);
      },
      async upsert(w: Workspace): Promise<Result<Workspace, DbError>> {
        upsertCalls += 1;
        return ok(w);
      },
    };
    // Returns a Result (never throws) — assert UNCONDITIONALLY (Lesson 15, no assertions-only-in-catch).
    const res = await provisionWorkspace(
      { workspaceConfig: faultingGetConfig, readModels: b.repos.readModels, now: b.now },
      SPEC_A,
    );
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("store_fault");
    // A transient existence-check fault MUST fail closed — never fall through to create/overwrite.
    expect(upsertCalls).toBe(0);
    expect(await registryIds(b)).not.toContain("employer-work");
  });

  it("registry_get_fault_is_typed_err_not_empty: a store fault on the registry get ⇒ typed store_fault err, NEVER a fold-to-empty [spec(§5)]", async () => {
    // Upsert succeeds; the registry GET faults (unavailable, NOT not_found).
    const okConfig: WorkspaceConfigRepository = {
      async get(): Promise<Result<Workspace, DbError>> {
        return err({ code: "not_found", message: "x" });
      },
      async list(): Promise<Result<Workspace[], DbError>> {
        return ok([]);
      },
      async upsert(w: Workspace): Promise<Result<Workspace, DbError>> {
        return ok(w);
      },
    };
    const faultingReadModels: ReadModelRepository = {
      async get(): Promise<Result<ReadModelRecord, DbError>> {
        return err({ code: "unavailable", message: "registry store down" }); // genuine fault, not a benign miss
      },
      async put(r: ReadModelRecord): Promise<Result<ReadModelRecord, DbError>> {
        return ok(r);
      },
      async clear(): Promise<Result<void, DbError>> {
        return ok(undefined);
      },
    };
    const res = await provisionWorkspace(
      { workspaceConfig: okConfig, readModels: faultingReadModels, now: () => NOW },
      SPEC_A,
    );
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("store_fault"); // fault degrades loudly, never a silent empty
  });

  it("upsert_fault_registers_nothing: a config upsert fault ⇒ typed err AND the id is NEVER unioned (upsert precedes union; no registry-known config-less workspace — rule-5 fail-safe) [spec(§5)]", async () => {
    // Real registry read-model (starts empty); the config upsert faults BEFORE the union.
    const b = await fresh();
    const faultingConfig: WorkspaceConfigRepository = {
      async get(): Promise<Result<Workspace, DbError>> {
        return err({ code: "not_found", message: "x" });
      },
      async list(): Promise<Result<Workspace[], DbError>> {
        return ok([]);
      },
      async upsert(): Promise<Result<Workspace, DbError>> {
        return err({ code: "unavailable", message: "config store down" });
      },
    };
    const res = await provisionWorkspace(
      { workspaceConfig: faultingConfig, readModels: b.repos.readModels, now: b.now },
      SPEC_A,
    );
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("store_fault");
    // The union never happened — a partial failure yields NO registry-known workspace.
    expect(await registryIds(b)).not.toContain("employer-work");
    // ...and the read path stays fail-closed (no config-less "known" workspace).
    expect(isErr(await port(b).workspaceCards("employer-work"))).toBe(true);
  });

  it("no_read_model_card_seeding: provisionWorkspace writes NO workspace/project/recent-change rows (production ≠ dev seeding) [spec(§19.1)]", async () => {
    const b = await fresh();
    await provisionWorkspace(deps(b), SPEC_A);
    // Known workspace (registry member) ⇒ scoped reads resolve, but EMPTY — nothing was seeded.
    const cards = await port(b).workspaceCards("employer-work");
    const projects = await port(b).projectDashboards("employer-work");
    const changes = await port(b).recentChanges("employer-work");
    expect(isOk(cards) && cards.value).toEqual([]);
    expect(isOk(projects) && projects.value).toEqual([]);
    expect(isOk(changes) && changes.value).toEqual([]);
  });

  it("default_egress_closed: the upserted Workspace defaults egress CLOSED + isolated visibility (safety rule 5) [spec(§5)]", async () => {
    const b = await fresh();
    await provisionWorkspace(deps(b), SPEC_A);
    const cfg = await b.repos.workspaceConfig.get("employer-work" as Workspace["id"]);
    expect(isOk(cfg)).toBe(true);
    if (isOk(cfg)) {
      const w = cfg.value;
      expect(w.egressPolicy.employerRawEgressAcknowledged).toBe(false);
      expect(w.egressPolicy.rawContentAllowedProcessors).toEqual([]);
      expect(w.egressPolicy.allowedProcessors).toEqual([]);
      expect(w.defaultVisibility).toBe("isolated");
      expect(w.providerMatrix.rawCloudEgressEnabled).toBe(false);
    }
  });

  it("invalid_workspace_input_is_typed_err_not_throw: a Workspace that fails validation ⇒ typed invalid_workspace err, never a throw (§16 total) [spec(§5)]", async () => {
    const b = await fresh();
    // An empty name fails WorkspaceSchema (name.min(1)) — `defaultWorkspace` would throw;
    // provisionWorkspace must contain it as a typed err (never let a throw cross the boundary).
    const res = await provisionWorkspace(deps(b), { ...SPEC_A, name: "" });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("invalid_workspace");
    // And nothing was registered (fail-closed — no partial visibility).
    expect(await registryIds(b)).not.toContain("employer-work");
  });
});
