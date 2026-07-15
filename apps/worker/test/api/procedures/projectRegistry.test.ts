// Task 14.6 — the `projectRegistry.createProject` tRPC procedure. RED-first spec.
//
// The operational project-creation surface: validates the candidate input at the
// transport edge, calls the injected ProjectRegistryCommandPort (the real binding wraps
// createProjectRegistryEntry over @sow/db), returns a typed UI-safe summary — never
// throws, never echoes a raw driver cause (§16 / safety rule 7). Behind the auth gate.
import { describe, it, expect } from "vitest";
import { isErr, isOk, type Result } from "@sow/contracts";
import type { ProjectRegistryEntry } from "@sow/workflows";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import {
  buildProjectRegistryRouter,
  type ProjectRegistryCommandPort,
} from "../../../src/api/procedures/projectRegistry";
import type {
  CreateProjectRegistryInput,
  CreateProjectRegistryError,
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
