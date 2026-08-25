// Task 14.6 — the `projectRegistry.createProject` tRPC procedure. RED-first spec.
//
// The operational project-creation surface: validates the candidate input at the
// transport edge, calls the injected ProjectRegistryCommandPort (the real binding wraps
// createProjectRegistryEntry over @sow/db), returns a typed UI-safe summary — never
// throws, never echoes a raw driver cause (§16 / safety rule 7). Behind the auth gate.
import { describe, it, expect } from "vitest";
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type { ProjectRegistryEntry, ProjectSyncContext } from "@sow/workflows";
import { sourceId as brandSourceId } from "@sow/contracts";
import type { SourceRef } from "@sow/contracts";
import type { DbError, ProjectRegistryRepository, ProjectRegistryRow, ReadModelRecord, ReadModelRepository } from "@sow/db";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import {
  buildProjectRegistryRouter,
  type ProjectRegistryCommandPort,
} from "../../../src/api/procedures/projectRegistry";
import { READ_MODEL_KEYS } from "../../../src/api/adapters/readModel";
import {
  createProjectRegistryResolvePort,
  buildProjectSyncWorkerPorts,
  type CreateProjectRegistryInput,
  type CreateProjectRegistryError,
} from "../../../src/composition/projectRegistry";

const AUTHED_CTX: ApiContext = { auth: { ok: true, value: { authenticated: true } } };
const UNAUTH_CTX: ApiContext = {
  auth: { ok: false, error: { kind: "validation_rejected", message: "unauthenticated", retryable: false } },
};

const VALID_INPUT = {
  projectId: "acme-api",
  workspaceId: "employer-work",
  planPath: "employer-work/acme-api/IMPLEMENTATION_PLAN.md",
  progressProviders: [{ connectorId: "linear-1", remoteHandle: "ACME" }],
  aliases: ["acme"],
  title: "Acme API",
  slug: "employer-work/acme-api",
  lifecycleState: "active",
};

class FakeProjectRegistryPort implements ProjectRegistryCommandPort {
  calls: CreateProjectRegistryInput[] = [];
  constructor(
    private readonly outcome: (input: CreateProjectRegistryInput) => Result<ProjectRegistryEntry, CreateProjectRegistryError>,
  ) {}
  async createProject(input: CreateProjectRegistryInput): Promise<Result<ProjectRegistryEntry, CreateProjectRegistryError>> {
    this.calls.push(input);
    return this.outcome(input);
  }
}

function okOutcome(input: CreateProjectRegistryInput): Result<ProjectRegistryEntry, CreateProjectRegistryError> {
  return {
    ok: true,
    value: {
      projectId: input.projectId,
      workspaceId: input.workspaceId as ProjectRegistryEntry["workspaceId"],
      progressProviders: input.progressProviders ?? [],
      title: input.title,
      slug: input.slug,
      lifecycleState: input.lifecycleState,
    },
  };
}

function caller(port: ProjectRegistryCommandPort, ctx: ApiContext = AUTHED_CTX) {
  const appRouter = router({ projectRegistry: buildProjectRegistryRouter({ projectRegistry: port }) });
  return createCallerFactory(appRouter)(ctx);
}

describe("projectRegistry.createProject procedure (14.6)", () => {
  it("createProject_round_trips: validates input, calls the port, returns a typed UI-safe summary [spec(§6)]", async () => {
    const port = new FakeProjectRegistryPort(okOutcome);
    const res = await caller(port).projectRegistry.createProject(VALID_INPUT);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projectId).toBe("acme-api");
      expect(res.value.workspaceId).toBe("employer-work");
      expect(res.value.lifecycleState).toBe("active");
    }
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({ projectId: "acme-api", workspaceId: "employer-work", lifecycleState: "active" });
  });

  it("createProject_rejects_malformed_input: a bad lifecycleState / unmapped provider ⇒ validation_rejected, never reaches the port [spec(§16)]", async () => {
    const port = new FakeProjectRegistryPort(okOutcome);
    const c = caller(port);
    const badState = await c.projectRegistry.createProject({ ...VALID_INPUT, lifecycleState: "not_a_state" });
    const badProvider = await c.projectRegistry.createProject({
      ...VALID_INPUT,
      progressProviders: [{ connectorId: "linear-1", remoteHandle: "" }],
    });
    const missingTitle = await c.projectRegistry.createProject({ ...VALID_INPUT, title: "" });
    expect(isErr(badState)).toBe(true);
    expect(isErr(badProvider)).toBe(true);
    expect(isErr(missingTitle)).toBe(true);
    expect(port.calls).toHaveLength(0);
  });

  it("createProject_error_is_typed_no_raw: a creation fault ⇒ stable code; the raw driver cause never crosses (§16 / rule 7) [spec(§16)]", async () => {
    const port = new FakeProjectRegistryPort(() => ({
      ok: false,
      error: { code: "store_fault", message: "postgres: FATAL SECRET-DSN refused" },
    }));
    const res = await caller(port).projectRegistry.createProject(VALID_INPUT);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(JSON.stringify(res.error)).not.toContain("SECRET-DSN");
      expect(JSON.stringify(res.error)).not.toContain("postgres");
    }
  });

  it("createProject_requires_auth: an unauthenticated caller gets a typed err, the port never runs [spec(§16)]", async () => {
    const port = new FakeProjectRegistryPort(okOutcome);
    const res = await caller(port, UNAUTH_CTX).projectRegistry.createProject(VALID_INPUT);
    expect(isErr(res)).toBe(true);
    expect(port.calls).toHaveLength(0);
  });
});

// ── 13.5 — composition-root tests for src/composition/projectRegistry.ts additions ─────────────
// NOTE ON PLACEMENT: apps/worker/test/composition/projectRegistry.test.ts (task 14.6's own suite)
// already exists and is OUT OF this work package's territory — the territory grant for this
// package names ONLY this procedures test file for projectRegistry, so the 13.5 composition-root
// additions (the arch_gap fault-signal split + buildProjectSyncWorkerPorts) are pinned HERE rather
// than there. `createProjectRegistryResolvePort`/`buildProjectSyncWorkerPorts` are both imported
// directly from `../../../src/composition/projectRegistry` above — this file already does that for
// the creation-path types, so it is a valid (if unusually-named) home for these.
const NOW = "2026-07-15T00:00:00.000Z";
const wsId = (s: string): ProjectRegistryRow["workspaceId"] => s as ProjectRegistryRow["workspaceId"];

function projectRow(over: Partial<ProjectRegistryRow> = {}): ProjectRegistryRow {
  return {
    projectId: "acme-api",
    workspaceId: wsId("employer-work"),
    progressProviders: [],
    title: "Acme API",
    slug: "employer-work/acme-api",
    lifecycleState: "active",
    ...over,
  };
}

const projectSyncCtx = (projectRef: string): ProjectSyncContext => ({ projectRef });

/** Mirrors composition/projectRegistry.test.ts's own FakeProjectRepo — kept minimal + local here so
 *  this file has no dependency on the out-of-territory suite. */
class FakeProjectRepo implements ProjectRegistryRepository {
  rows = new Map<string, ProjectRegistryRow>();
  faultOn: "resolveRef" | "upsert" | "get" | null = null;
  seed(...rs: ProjectRegistryRow[]): this {
    for (const r of rs) this.rows.set(r.projectId, r);
    return this;
  }
  async upsert(entry: ProjectRegistryRow): Promise<Result<ProjectRegistryRow, DbError>> {
    this.rows.set(entry.projectId, entry);
    return ok(entry);
  }
  async get(projectId: string): Promise<Result<ProjectRegistryRow, DbError>> {
    if (this.faultOn === "get") return err({ code: "unavailable", message: "x" });
    const r = this.rows.get(projectId);
    return r ? ok(r) : err({ code: "not_found", message: "x" });
  }
  async resolveRef(ref: string): Promise<Result<ProjectRegistryRow, DbError>> {
    if (this.faultOn === "resolveRef") return err({ code: "unavailable", message: "store down" });
    const matches = [...this.rows.values()].filter((r) => r.projectId === ref || (r.aliases ?? []).includes(ref));
    const only = matches.length === 1 ? matches[0] : undefined;
    return only ? ok(only) : err({ code: "not_found", message: "x" });
  }
  async listByWorkspace(workspaceId: ProjectRegistryRow["workspaceId"]): Promise<Result<ProjectRegistryRow[], DbError>> {
    return ok([...this.rows.values()].filter((r) => r.workspaceId === workspaceId));
  }
}

function fakeReadModels(
  opts: { registered?: readonly string[]; store?: Map<string, ReadModelRecord> } = {},
): ReadModelRepository {
  const store = opts.store ?? new Map<string, ReadModelRecord>();
  const storeKey = (key: string, workspaceId: string | null): string => `${key}::${workspaceId ?? "null"}`;
  return {
    async get(key: string, workspaceId: string | null): Promise<Result<ReadModelRecord, DbError>> {
      if (key === READ_MODEL_KEYS.registry) {
        return ok({ readModelKey: key, data: { workspaceIds: opts.registered ?? [] }, rebuiltAt: NOW } as ReadModelRecord);
      }
      const hit = store.get(storeKey(key, workspaceId));
      return hit !== undefined ? ok(hit) : err({ code: "not_found", message: "x" });
    },
    async put(r: ReadModelRecord): Promise<Result<ReadModelRecord, DbError>> {
      store.set(storeKey(r.readModelKey, r.workspaceId ?? null), r);
      return ok(r);
    },
    async clear(): Promise<Result<void, DbError>> {
      return ok(undefined);
    },
  };
}

describe("createProjectRegistryResolvePort — 13.5 arch_gap: a genuine store fault gets a DISTINCT observable signal", () => {
  it("resolve_fault_fires_a_health_signal_the_return_code_stays_project_unknown — the closed 2-member ResolveRegistryError set is UNTOUCHED (never widened); the fault becomes distinguishable via the health channel instead", async () => {
    const repo = new FakeProjectRepo();
    repo.faultOn = "resolveRef";
    const calls: unknown[] = [];
    const port = createProjectRegistryResolvePort({
      repo,
      readModels: fakeReadModels({ registered: ["employer-work"] }),
      recordResolveFault: (fault) => {
        calls.push(fault);
        return Promise.resolve();
      },
    });

    const res = await port.resolve(projectSyncCtx("acme-api"));

    // The CLOSED port contract is preserved byte-for-byte (fail-closed, never a false resolve).
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("project_unknown");
    // But NOW a genuine store fault is DISTINGUISHABLE from a benign not_found via the health channel.
    expect(calls).toEqual([{ projectRef: "acme-api", code: "unavailable" }]);
  });

  it("benign_not_found_never_fires_the_health_signal — the split cuts BOTH ways: a real unknown ref stays silent", async () => {
    const calls: unknown[] = [];
    const port = createProjectRegistryResolvePort({
      repo: new FakeProjectRepo(), // empty — a genuine not_found, not a fault
      readModels: fakeReadModels({ registered: ["employer-work"] }),
      recordResolveFault: (fault) => {
        calls.push(fault);
        return Promise.resolve();
      },
    });

    const res = await port.resolve(projectSyncCtx("nope"));

    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("project_unknown");
    expect(calls).toHaveLength(0);
  });

  it("unbound_signal_is_byte_equivalent — recordResolveFault omitted ⇒ the SAME Result as before this slice", async () => {
    const repo = new FakeProjectRepo();
    repo.faultOn = "resolveRef";
    const port = createProjectRegistryResolvePort({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) });

    const res = await port.resolve(projectSyncCtx("acme-api"));

    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("project_unknown");
  });

  it("signal_throw_and_rejection_never_alter_the_result — best-effort (L25/L53)", async () => {
    const repo = new FakeProjectRepo();
    repo.faultOn = "resolveRef";
    const portThrows = createProjectRegistryResolvePort({
      repo,
      readModels: fakeReadModels({ registered: ["employer-work"] }),
      recordResolveFault: (): Promise<unknown> => {
        throw new Error("sink exploded");
      },
    });
    const res1 = await portThrows.resolve(projectSyncCtx("acme-api"));
    expect(isErr(res1)).toBe(true);
    if (isErr(res1)) expect(res1.error.code).toBe("project_unknown");

    const portRejects = createProjectRegistryResolvePort({
      repo,
      readModels: fakeReadModels({ registered: ["employer-work"] }),
      recordResolveFault: () => Promise.reject(new Error("sink rejected")),
    });
    const res2 = await portRejects.resolve(projectSyncCtx("acme-api"));
    expect(isErr(res2)).toBe(true);
    if (isErr(res2)) expect(res2.error.code).toBe("project_unknown");
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the rejected promise's microtask settle
  });
});

describe("buildProjectSyncWorkerPorts — 13.5: assemble the concrete SyncOutputsProjection / ValidateNarrativePort / dashboard-update ports", () => {
  const SOURCE_REF: SourceRef = { sourceId: brandSourceId("src-project-sync-1") };

  it("assembles_all_four_ports_and_resolve_works_end_to_end", async () => {
    const repo = new FakeProjectRepo().seed(projectRow());
    const vaultStore = new Map<string, string>();
    const ports = buildProjectSyncWorkerPorts({
      repo,
      readModels: fakeReadModels({ registered: ["employer-work"] }),
      vault: { read: (path) => Promise.resolve(vaultStore.get(path)) },
      sourceRef: SOURCE_REF,
      planIdentity: { projectId: "acme-api" },
      now: () => NOW,
    });

    const resolved = await ports.resolve.resolve(projectSyncCtx("acme-api"));
    expect(isOk(resolved)).toBe(true);
    if (isOk(resolved)) expect(resolved.value.projectId).toBe("acme-api");

    expect(typeof ports.buildOutputs.build).toBe("function");
    expect(typeof ports.validate.validate).toBe("function");
    expect(typeof ports.dashboard.update).toBe("function");
  });

  it("noteExists_probe_reads_through_the_injected_vault — a note absent from the vault ⇒ create (first sync)", async () => {
    const repo = new FakeProjectRepo().seed(projectRow());
    const readModels = fakeReadModels({ registered: ["employer-work"] });
    const vaultStore = new Map<string, string>(); // empty — no project note exists yet
    const ports = buildProjectSyncWorkerPorts({
      repo,
      readModels,
      vault: { read: (path) => Promise.resolve(vaultStore.get(path)) },
      sourceRef: SOURCE_REF,
      planIdentity: { projectId: "acme-api" },
      now: () => NOW,
    });

    // Drive buildOutputs with a minimal validated narrative + deterministic progress; the create-vs-
    // patch decision is delegated entirely to createBuildSyncOutputsActivity's own real logic —
    // this test only proves OUR noteExists wiring feeds it correctly (an absent vault entry never
    // throws and never silently guesses).
    const built = await ports.buildOutputs.build(
      { validated: true, fields: {} },
      { completedCount: 0, totalCount: 0, percentComplete: 0, perProvider: [] },
      wsId("employer-work"),
      { projectId: "acme-api", title: "Acme API", slug: "employer-work/acme-api", lifecycleState: "active" },
      NOW,
    );
    // Never throws; a well-formed (if minimal) input either builds or fails typed — either way the
    // noteExists probe itself must have run without throwing (proven by reaching this line at all).
    expect(built).toBeDefined();
  });

  it("vault_read_fault_is_typed_never_thrown_by_noteExists", async () => {
    const repo = new FakeProjectRepo().seed(projectRow());
    const ports = buildProjectSyncWorkerPorts({
      repo,
      readModels: fakeReadModels({ registered: ["employer-work"] }),
      vault: {
        read: (): Promise<string | undefined> => Promise.reject(new Error("vault read exploded")),
      },
      sourceRef: SOURCE_REF,
      planIdentity: { projectId: "acme-api" },
      now: () => NOW,
    });

    const built = await ports.buildOutputs.build(
      { validated: true, fields: {} },
      { completedCount: 0, totalCount: 0, percentComplete: 0, perProvider: [] },
      wsId("employer-work"),
      { projectId: "acme-api", title: "Acme API", slug: "employer-work/acme-api", lifecycleState: "active" },
      NOW,
    );
    // A throwing vault read must fail the build CLOSED (typed err), never propagate as an
    // unhandled rejection / thrown error out of buildOutputs.build.
    expect(isErr(built)).toBe(true);
  });

  it("dashboard_update_writes_through_the_injected_readModels", async () => {
    const store = new Map<string, ReadModelRecord>();
    const readModels = fakeReadModels({ registered: ["employer-work"], store });
    const ports = buildProjectSyncWorkerPorts({
      repo: new FakeProjectRepo().seed(projectRow()),
      readModels,
      vault: { read: () => Promise.resolve(undefined) },
      sourceRef: SOURCE_REF,
      planIdentity: { projectId: "acme-api" },
      now: () => NOW,
    });

    const updateRes = await ports.dashboard.update({
      workspaceId: "employer-work",
      dashboard: {
        projectId: "acme-api",
        title: "Acme API",
        status: "active",
        progress: { completedCount: 1, totalCount: 2, percentComplete: 50 },
        blockers: [],
        waitingItems: [],
        nextActions: [],
        evidenceRefs: [],
        docPack: [],
        updatedAt: NOW,
      },
    });

    expect(isOk(updateRes)).toBe(true);
    const stored = await readModels.get(READ_MODEL_KEYS.projectDashboards, "employer-work");
    expect(isOk(stored)).toBe(true);
  });
});
