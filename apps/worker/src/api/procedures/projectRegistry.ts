// Task 14.6 — the `projectRegistry` command procedure: create a durable project entry.
//
// The OPERATIONAL project-creation surface (the reachable production entry for the
// typed-Project registry; the projectSync workflow that RESOLVES against the registry is
// dormant — its production port binding is a spine follow-up). The procedure validates
// the candidate input at the transport edge (candidate-data gate), calls the injected
// `ProjectRegistryCommandPort` (the real binding wraps `createProjectRegistryEntry` over
// `@sow/db`), and returns a typed UI-safe summary.
//
// RULE 1 (one-writer): the creation path writes ONLY the operational registry row — never
// the canonical Project Markdown (KnowledgeWriter-owned). §16: never throws; a fault
// surfaces a STABLE code, never a raw driver cause (safety rule 7). Mirrors onboarding.ts.
import { publicProcedure, router, authedResolver } from "../router";
import {
  ok,
  err,
  failure,
  ProjectLifecycleState,
  type Result,
  type FailureVariant,
  type ProjectLifecycleState as ProjectLifecycleStateType,
} from "@sow/contracts";
import type { ProjectRegistryProvider } from "@sow/db";
import type { ProjectRegistryEntry } from "@sow/workflows";
import {
  createProjectRegistryEntry,
  type CreateProjectRegistryInput,
  type CreateProjectRegistryError,
  type CreateProjectRegistryDeps,
} from "../../composition/projectRegistry";

/**
 * The injected project-creation port — the procedure's ONLY registry I/O. The real
 * binding (boot) wraps `createProjectRegistryEntry` over the durable
 * `ProjectRegistryRepository` + the 14.1 workspace registry. A fake implements this for
 * unit tests.
 */
export interface ProjectRegistryCommandPort {
  createProject(
    input: CreateProjectRegistryInput,
  ): Promise<Result<ProjectRegistryEntry, CreateProjectRegistryError>>;
}

/** Dependencies for {@link buildProjectRegistryRouter}. */
export interface ProjectRegistryDeps {
  readonly projectRegistry: ProjectRegistryCommandPort;
}

/** The renderer-facing created-project summary (safe scalars only — no raw content). */
export interface UiSafeCreatedProject {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly slug: string;
  readonly lifecycleState: string;
}

/** Build the real {@link ProjectRegistryCommandPort} over the composition creation fn. */
export function createProjectRegistryCommandPort(deps: CreateProjectRegistryDeps): ProjectRegistryCommandPort {
  return {
    createProject: (input) => createProjectRegistryEntry(deps, input),
  };
}

// ── Input validation (candidate-data gate — PURE, no new dependency) ─────────

/** A non-empty-string guard (rejects absent / non-string / whitespace-only). */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** A typed input-validation failure — redaction-safe (only a stable code). */
function invalidInput(code: string): FailureVariant {
  return failure("validation_rejected", "invalid project-registry input", { cause: { code } });
}

/** Passthrough parser (mirror commands.ts / onboarding.ts) — validate INSIDE the handler. */
const passthroughInput = (raw: unknown): unknown => raw;

/**
 * Narrow an untrusted `progressProviders` value to `ProjectRegistryProvider[]`. Each
 * provider MUST carry non-empty connectorId + remoteHandle (an unmapped provider is
 * rejected here at the gate AND fail-closed again at resolve — provider_unmapped).
 * Absent ⇒ [] (plan-only). Returns null on any malformed element.
 */
function parseProviders(v: unknown): readonly ProjectRegistryProvider[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: ProjectRegistryProvider[] = [];
  for (const el of v) {
    if (typeof el !== "object" || el === null) return null;
    const r = el as Record<string, unknown>;
    if (!isNonEmptyString(r["connectorId"]) || !isNonEmptyString(r["remoteHandle"])) return null;
    out.push({ connectorId: r["connectorId"], remoteHandle: r["remoteHandle"] });
  }
  return out;
}

/** Narrow an untrusted `aliases` value to string[]; absent ⇒ undefined; malformed ⇒ null. */
function parseAliases(v: unknown): readonly string[] | undefined | null {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every(isNonEmptyString)) return null;
  return v as string[];
}

/**
 * Validate a raw `createProject` input at the transport edge. Returns a typed
 * `err(validation_rejected)` on any malformed field — never a throw. `lifecycleState`
 * is narrowed against the frozen `ProjectLifecycleState`.
 */
function parseCreateProject(raw: unknown): Result<CreateProjectRegistryInput, FailureVariant> {
  if (typeof raw !== "object" || raw === null) return err(invalidInput("CREATE_PROJECT_INPUT_SHAPE"));
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["projectId"])) return err(invalidInput("CREATE_PROJECT_ID"));
  if (!isNonEmptyString(r["workspaceId"])) return err(invalidInput("CREATE_PROJECT_WORKSPACE_ID"));
  if (!isNonEmptyString(r["title"])) return err(invalidInput("CREATE_PROJECT_TITLE"));
  if (!isNonEmptyString(r["slug"])) return err(invalidInput("CREATE_PROJECT_SLUG"));
  const lifecycleState = r["lifecycleState"];
  if (
    typeof lifecycleState !== "string" ||
    !(ProjectLifecycleState as readonly string[]).includes(lifecycleState)
  ) {
    return err(invalidInput("CREATE_PROJECT_LIFECYCLE_STATE"));
  }
  const progressProviders = parseProviders(r["progressProviders"]);
  if (progressProviders === null) return err(invalidInput("CREATE_PROJECT_PROVIDERS"));
  const aliases = parseAliases(r["aliases"]);
  if (aliases === null) return err(invalidInput("CREATE_PROJECT_ALIASES"));
  const planPath = r["planPath"];
  if (planPath !== undefined && !isNonEmptyString(planPath)) return err(invalidInput("CREATE_PROJECT_PLAN_PATH"));

  return ok({
    projectId: r["projectId"],
    workspaceId: r["workspaceId"],
    title: r["title"],
    slug: r["slug"],
    lifecycleState: lifecycleState as ProjectLifecycleStateType,
    progressProviders,
    ...(aliases !== undefined ? { aliases } : {}),
    ...(planPath !== undefined ? { planPath: planPath as string } : {}),
  });
}

/**
 * Map a `CreateProjectRegistryError` onto the §16 `FailureVariant` boundary taxonomy.
 * REDACTION-SAFE: only a stable code crosses, never the raw driver cause / message.
 */
function createErrorToFailure(e: CreateProjectRegistryError): FailureVariant {
  switch (e.code) {
    case "workspace_unknown":
      return failure("validation_rejected", "project workspace is not registered", {
        cause: { code: "PROJECT_WORKSPACE_UNKNOWN" },
      });
    case "project_workspace_immutable":
      return failure("validation_rejected", "project workspace is immutable", {
        cause: { code: "PROJECT_WORKSPACE_IMMUTABLE" },
      });
    case "store_fault":
      return failure("degraded_unavailable", "project registry unavailable", {
        retryable: true,
        cause: { code: "PROJECT_REGISTRY_STORE_FAULT" },
      });
  }
}

// ── Router factory ──────────────────────────────────────────────────────────

/**
 * Build the project-registry router the integrator mounts at `appRouter.projectRegistry`.
 * `createProject` is a tRPC `.mutation()` (it mints an operational row) wrapped in the 8.2
 * `authedResolver`, returning a `Result<T, FailureVariant>` — never throws. Creation routes
 * through the injected port (§7/§8 one-writer; rule-1: registry row only, no KW/Markdown).
 */
export function buildProjectRegistryRouter(deps: ProjectRegistryDeps) {
  const { projectRegistry } = deps;
  return router({
    /**
     * Create a durable project-registry entry bound to a 14.1-registered workspace (§19.1 /
     * §6). Validates the candidate input, persists via the injected port (operational row
     * only), and returns the UI-safe summary. A fault surfaces a stable code (no raw cause).
     */
    createProject: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeCreatedProject>(
        async (_ctx, input): Promise<Result<UiSafeCreatedProject, FailureVariant>> => {
          const parsed = parseCreateProject(input);
          if (!parsed.ok) return err(parsed.error);
          const created = await projectRegistry.createProject(parsed.value);
          if (!created.ok) return err(createErrorToFailure(created.error));
          return ok({
            projectId: created.value.projectId,
            workspaceId: created.value.workspaceId,
            title: created.value.title,
            slug: created.value.slug,
            lifecycleState: created.value.lifecycleState,
          });
        },
      ),
    ),
  });
}
