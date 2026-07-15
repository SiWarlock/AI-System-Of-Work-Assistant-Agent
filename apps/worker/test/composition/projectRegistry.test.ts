// Task 14.6 — the production ResolveRegistryPort + the operational project-creation
// path. RED-first spec.
//
// SAFETY-CRITICAL (WS-8 rule 4 + one-writer rule 1). The port resolves a projectRef
// (projectId OR alias) → the stored entry, with the WS-8 controls: the resolved
// workspaceId ALWAYS comes from the STORED row (never a caller field — the projectSync
// context carries no workspaceId), and resolution is GATED on that workspace being KNOWN
// in the 14.1 registry (fail-closed). The creation path writes ONLY the operational
// registry row — its deps carry no KnowledgeWriter/vault (structurally incapable of a
// Markdown write, rule 1).
//
// The port + creation fn are unit-tested over a fake repo + a fake workspace registry
// (the projectSync WORKFLOW that consumes the port is dormant — deferred to the spine).
import { describe, it, expect } from "vitest";
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type { DbError, ProjectRegistryRepository, ProjectRegistryRow, ReadModelRecord, ReadModelRepository } from "@sow/db";
import type { ProjectSyncContext } from "@sow/workflows";
import { READ_MODEL_KEYS } from "../../src/api/adapters/readModel";
import {
  createProjectRegistryResolvePort,
  createProjectRegistryEntry,
  type CreateProjectRegistryInput,
} from "../../src/composition/projectRegistry";

const NOW = "2026-07-15T00:00:00.000Z";
const wsId = (s: string): ProjectRegistryRow["workspaceId"] => s as ProjectRegistryRow["workspaceId"];

function row(over: Partial<ProjectRegistryRow> = {}): ProjectRegistryRow {
  return {
    projectId: "acme-api",
    workspaceId: wsId("employer-work"),
    planPath: "employer-work/acme-api/IMPLEMENTATION_PLAN.md",
    progressProviders: [{ connectorId: "linear-1", remoteHandle: "ACME" }],
    aliases: ["acme"],
    title: "Acme API",
    slug: "employer-work/acme-api",
    lifecycleState: "active",
    ...over,
  };
}

const ctx = (projectRef: string): ProjectSyncContext => ({ projectRef });

/** An in-memory fake repo whose resolveRef mirrors the real exactly-one-match semantics. */
class FakeProjectRepo implements ProjectRegistryRepository {
  rows = new Map<string, ProjectRegistryRow>();
  upsertCalls = 0;
  faultOn: "resolveRef" | "upsert" | "get" | null = null;
  seed(...rs: ProjectRegistryRow[]): this {
    for (const r of rs) this.rows.set(r.projectId, r);
    return this;
  }
  async upsert(entry: ProjectRegistryRow): Promise<Result<ProjectRegistryRow, DbError>> {
    this.upsertCalls += 1;
    if (this.faultOn === "upsert") return err({ code: "unavailable", message: "x" });
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

/** A fake ReadModelRepository whose registry row lists `registered` workspace ids. */
function fakeReadModels(opts: { registered?: readonly string[]; faultOnRegistry?: boolean } = {}): ReadModelRepository {
  return {
    async get(key: string): Promise<Result<ReadModelRecord, DbError>> {
      if (key === READ_MODEL_KEYS.registry) {
        if (opts.faultOnRegistry) return err({ code: "unavailable", message: "registry down" });
        return ok({ readModelKey: key, data: { workspaceIds: opts.registered ?? [] }, rebuiltAt: NOW } as ReadModelRecord);
      }
      return err({ code: "not_found", message: "x" });
    },
    async put(r: ReadModelRecord): Promise<Result<ReadModelRecord, DbError>> {
      return ok(r);
    },
    async clear(): Promise<Result<void, DbError>> {
      return ok(undefined);
    },
  };
}

describe("createProjectRegistryResolvePort (14.6 — production ResolveRegistryPort)", () => {
  it("resolve_known_ref_returns_entry: a stored projectId ref resolves to its entry [spec(§6)]", async () => {
    const repo = new FakeProjectRepo().seed(row());
    const port = createProjectRegistryResolvePort({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) });
    const res = await port.resolve(ctx("acme-api"));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.projectId).toBe("acme-api");
  });

  it("resolve_alias_returns_entry: an alias resolves to the same entry [spec(§6)]", async () => {
    const repo = new FakeProjectRepo().seed(row());
    const port = createProjectRegistryResolvePort({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) });
    const res = await port.resolve(ctx("acme"));
    expect(isOk(res) && res.value.projectId).toBe("acme-api");
  });

  it("resolve_unknown_ref_is_project_unknown: no matching row ⇒ project_unknown [spec(§16)]", async () => {
    const port = createProjectRegistryResolvePort({ repo: new FakeProjectRepo(), readModels: fakeReadModels() });
    const res = await port.resolve(ctx("nope"));
    expect(isErr(res) && res.error.code).toBe("project_unknown");
  });

  it("resolve_unmapped_provider_is_provider_unmapped: a declared provider with an empty mapping ⇒ provider_unmapped, never a guess [spec(§6)]", async () => {
    const repo = new FakeProjectRepo().seed(row({ progressProviders: [{ connectorId: "linear-1", remoteHandle: "" }] }));
    const port = createProjectRegistryResolvePort({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) });
    const res = await port.resolve(ctx("acme-api"));
    expect(isErr(res) && res.error.code).toBe("provider_unmapped");
  });

  it("resolve_store_fault_is_typed_err_never_throws: a repo fault ⇒ project_unknown fail-closed, returns a Result (never throws) [spec(§16)]", async () => {
    const repo = new FakeProjectRepo();
    repo.faultOn = "resolveRef";
    const port = createProjectRegistryResolvePort({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) });
    // Returns a Result — assert UNCONDITIONALLY (Lesson 15, no assertions-only-in-catch).
    const res = await port.resolve(ctx("acme-api"));
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("project_unknown");
  });

  it("resolve_workspaceId_from_entry_not_caller: the resolved workspaceId is the STORED one (anti-smuggle — ctx carries none) [spec(§5)]", async () => {
    const repo = new FakeProjectRepo().seed(row({ workspaceId: wsId("employer-work") }));
    const port = createProjectRegistryResolvePort({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) });
    const res = await port.resolve(ctx("acme-api"));
    expect(isOk(res) && res.value.workspaceId).toBe("employer-work");
  });

  it("resolve_unregistered_workspace_fails_closed: an entry whose workspace is ABSENT from the 14.1 registry ⇒ project_unknown (safety rule 4) [spec(§5)]", async () => {
    // The row exists, but its workspace is NOT registered ⇒ no resolution.
    const repo = new FakeProjectRepo().seed(row({ workspaceId: wsId("employer-work") }));
    const port = createProjectRegistryResolvePort({ repo, readModels: fakeReadModels({ registered: [] }) });
    const res = await port.resolve(ctx("acme-api"));
    expect(isErr(res) && res.error.code).toBe("project_unknown");
  });

  it("resolve_registry_fault_fails_closed: a WS-8 registry read fault ⇒ project_unknown (never a false resolve) [spec(§5)]", async () => {
    const repo = new FakeProjectRepo().seed(row());
    const port = createProjectRegistryResolvePort({ repo, readModels: fakeReadModels({ faultOnRegistry: true }) });
    const res = await port.resolve(ctx("acme-api"));
    expect(isErr(res) && res.error.code).toBe("project_unknown");
  });

  it("resolve_ref_is_selector_not_identity: ctx.projectRef (an alias) only SELECTS the row — the identity fields come from the STORED entry, not the ref [spec(§6)]", async () => {
    // The ref "alias-x" differs from the entry's projectId/title — a regression that let the
    // ref leak into the identity would fail here (pairs with the driver's identity-derivation
    // pin `derives the build IDENTITY from the registry-bound entry` in project-sync.test.ts).
    const repo = new FakeProjectRepo().seed(row({ projectId: "proj-xyz", title: "Real Title", slug: "employer-work/xyz", aliases: ["alias-x"] }));
    const port = createProjectRegistryResolvePort({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) });
    const res = await port.resolve(ctx("alias-x"));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projectId).toBe("proj-xyz");
      expect(res.value.title).toBe("Real Title");
      expect(res.value.projectId).not.toBe("alias-x");
    }
  });
});

describe("createProjectRegistryEntry (14.6 — operational creation path, rule 1)", () => {
  const input = (over: Partial<CreateProjectRegistryInput> = {}): CreateProjectRegistryInput => ({
    projectId: "acme-api",
    workspaceId: "employer-work",
    planPath: "employer-work/acme-api/IMPLEMENTATION_PLAN.md",
    progressProviders: [{ connectorId: "linear-1", remoteHandle: "ACME" }],
    aliases: ["acme"],
    title: "Acme API",
    slug: "employer-work/acme-api",
    lifecycleState: "active",
    ...over,
  });

  it("create_registry_entry_round_trips: creation persists an entry that then RESOLVES back [spec(§6)]", async () => {
    const repo = new FakeProjectRepo();
    const readModels = fakeReadModels({ registered: ["employer-work"] });
    const created = await createProjectRegistryEntry({ repo, readModels }, input());
    expect(isOk(created)).toBe(true);
    // It resolves back through the production port.
    const port = createProjectRegistryResolvePort({ repo, readModels });
    const resolved = await port.resolve(ctx("acme-api"));
    expect(isOk(resolved) && resolved.value.title).toBe("Acme API");
  });

  it("create_rejects_unregistered_workspace: a project can't bind to a non-14.1-registered workspace (fail-closed) [spec(§5)]", async () => {
    const repo = new FakeProjectRepo();
    const created = await createProjectRegistryEntry({ repo, readModels: fakeReadModels({ registered: [] }) }, input());
    expect(isErr(created) && created.error.code).toBe("workspace_unknown");
    expect(repo.upsertCalls).toBe(0); // nothing persisted
  });

  it("create_registry_get_fault_fails_closed: a WS-8 registry read fault ⇒ store_fault, NO upsert (fail-closed) [spec(§5)]", async () => {
    const repo = new FakeProjectRepo();
    const created = await createProjectRegistryEntry({ repo, readModels: fakeReadModels({ faultOnRegistry: true }) }, input());
    expect(isErr(created) && created.error.code).toBe("store_fault");
    expect(repo.upsertCalls).toBe(0);
  });

  it("create_writes_no_markdown_or_kw: the creation path writes ONLY the registry row — exactly one upsert, no other write sink (safety rule 1) [spec(§6)]", async () => {
    const repo = new FakeProjectRepo();
    // The deps type is {repo, readModels} ONLY — there is NO KnowledgeWriter/vault to write
    // Markdown with (structural rule-1 boundary). Behaviorally: exactly one repo write, nothing else.
    const created = await createProjectRegistryEntry({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) }, input());
    expect(isOk(created)).toBe(true);
    expect(repo.upsertCalls).toBe(1); // the ONLY write the creation path performs
  });

  it("recreate_changing_workspace_is_rejected: re-creating an existing projectId with a DIFFERENT workspaceId ⇒ project_workspace_immutable; the WS-2 anchor is preserved; same-workspace re-create stays idempotent [spec(§5)]", async () => {
    const repo = new FakeProjectRepo();
    const readModels = fakeReadModels({ registered: ["employer-work", "personal-business"] });
    // Create A bound to employer-work.
    expect(isOk(await createProjectRegistryEntry({ repo, readModels }, input({ projectId: "a", workspaceId: "employer-work" })))).toBe(true);
    // Re-create A bound to a DIFFERENT (also registered) workspace ⇒ rejected (silent rebind would
    // move A across the isolation boundary / redirect its WS-2 durable-write target).
    const rebind = await createProjectRegistryEntry({ repo, readModels }, input({ projectId: "a", workspaceId: "personal-business" }));
    expect(isErr(rebind) && rebind.error.code).toBe("project_workspace_immutable");
    // The WS-2 anchor is preserved — A still bound to employer-work.
    const got = await repo.get("a");
    expect(isOk(got) && got.value.workspaceId).toBe("employer-work");
    // Same-workspace re-create is idempotent (title update, no rejection).
    const same = await createProjectRegistryEntry({ repo, readModels }, input({ projectId: "a", workspaceId: "employer-work", title: "A v2" }));
    expect(isOk(same)).toBe(true);
    const sameGot = await repo.get("a");
    expect(isOk(sameGot) && sameGot.value.title).toBe("A v2");
  });

  it("create_get_fault_fails_closed: the pre-upsert existence-check get faulting ⇒ store_fault, NO upsert (the guard's fault branch fails closed) [spec(§5)]", async () => {
    const repo = new FakeProjectRepo();
    repo.faultOn = "get";
    const created = await createProjectRegistryEntry(
      { repo, readModels: fakeReadModels({ registered: ["employer-work"] }) },
      input(),
    );
    expect(isErr(created)).toBe(true);
    if (isErr(created)) expect(created.error.code).toBe("store_fault");
    expect(repo.upsertCalls).toBe(0); // fails closed — never falls through to the write
  });
});
