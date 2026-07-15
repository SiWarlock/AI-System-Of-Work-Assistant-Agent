// Task 14.6 — the production typed-Project registry composition (worker boundary).
//
// TWO deliverables, both over the durable `@sow/db` ProjectRegistryRepository:
//   (1) `createProjectRegistryResolvePort` — the PRODUCTION `ResolveRegistryPort`
//       (the `@sow/workflows` port the projectSync driver resolves against),
//       REPLACING the test-only FakeResolveRegistryPort. Maps a db `ProjectRegistryRow`
//       → the workflow-port `ProjectRegistryEntry` at this worker boundary (Q1: no
//       contract promotion; `@sow/db` cannot import `@sow/workflows`).
//   (2) `createProjectRegistryEntry` — the OPERATIONAL project-creation path. It writes
//       ONLY the registry row — NEVER the canonical Project Markdown (KnowledgeWriter-
//       owned, safety rule 1). Its deps carry NO KnowledgeWriter / vault, so it is
//       structurally incapable of a Markdown write.
//
// WS-8 (safety rule 4): resolution + creation both gate on the workspace being KNOWN in
// the 14.1 registry (the fail-closed `resolveKnownWorkspace`), and the resolved
// workspaceId ALWAYS comes from the STORED row (never a caller field — anti-smuggle).
//
// §16: never throws — a repo fault (or an unknown ref, or an unregistered workspace)
// folds fail-closed to the frozen closed error set {project_unknown, provider_unmapped}
// (`resolve`) or a typed creation error. The port contract's error set is NOT expanded.
//
// arch_gap (deferred, orch Future-TODO): the frozen ResolveRegistryError set has no
// fault code, so a transient STORE FAULT currently folds to `project_unknown` (fail-
// closed, never a false resolve) — indistinguishable from a genuine unknown ref. At
// spine-wiring, decide whether a store fault needs a distinct degraded signal (operator
// visibility + retry) vs this fold, so the fault/degrade distinction isn't lost forever.
//
// DORMANCY (Lesson 11): the projectSync workflow (`runProjectSync`) has NO production
// dispatch yet, so this port is UNIT-TESTED + is the canonical impl, but is NOT bound
// into a dispatched workflow at boot (dormant-on-dormant); that binding is a named
// spine follow-up. The creation path IS boot-wired (the reachable production entry).
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type { ProjectLifecycleState, WorkspaceId } from "@sow/contracts";
import type {
  ProjectRegistryRepository,
  ProjectRegistryRow,
  ProjectRegistryProvider,
  ReadModelRepository,
} from "@sow/db";
import type {
  ProjectSyncContext,
  ProjectRegistryEntry,
  ResolveRegistryPort,
  ResolveRegistryError,
} from "@sow/workflows";
import { resolveKnownWorkspace } from "../api/adapters/readModel";

/**
 * Map a durable `ProjectRegistryRow` → the `@sow/workflows` `ProjectRegistryEntry`
 * port type at the worker boundary. The two shapes are structurally identical (Q1),
 * so this is a documented pass-through — it exists to name the boundary, not transform.
 */
function toEntry(row: ProjectRegistryRow): ProjectRegistryEntry {
  return row;
}

/**
 * Build the PRODUCTION `ResolveRegistryPort` over the durable registry repo + the 14.1
 * workspace registry (WS-8 gate). Resolution: look up `ctx.projectRef` (projectId OR
 * alias) globally → gate the RESOLVED row's workspace on 14.1-registry-membership → fail
 * `provider_unmapped` if any declared progress provider lacks a connectorId/remoteHandle
 * mapping → map Row→Entry. Any repo fault / unknown ref / unregistered workspace folds to
 * `project_unknown` (fail-closed). Never throws.
 */
export function createProjectRegistryResolvePort(deps: {
  readonly repo: ProjectRegistryRepository;
  readonly readModels: ReadModelRepository;
}): ResolveRegistryPort {
  return {
    async resolve(
      ctx: ProjectSyncContext,
    ): Promise<Result<ProjectRegistryEntry, ResolveRegistryError>> {
      try {
        // 1. GLOBAL ref lookup (projectId or alias; ambiguous alias ⇒ repo not_found).
        const found = await deps.repo.resolveRef(ctx.projectRef);
        if (isErr(found)) {
          // not_found OR a store fault ⇒ project_unknown (fail-closed; the closed error
          // set has no fault code — a fault must NEVER surface as a false resolve).
          return err({ code: "project_unknown", message: `project ref not resolved: ${ctx.projectRef}` });
        }
        const row = found.value;

        // 2. WS-8 gate: the RESOLVED row's workspace must be KNOWN in the 14.1 registry
        //    (workspaceId comes from the STORED row, never a caller field — anti-smuggle).
        const known = await resolveKnownWorkspace(deps.readModels, row.workspaceId);
        if (!known.ok || !known.value) {
          return err({ code: "project_unknown", message: "project workspace is not registered" });
        }

        // 3. provider_unmapped: a declared progress provider with no connectorId/remoteHandle
        //    mapping is a HARD failure — never a guessed source (PRJ-3/4, fail-closed).
        for (const provider of row.progressProviders) {
          if (!isMappedProvider(provider)) {
            return err({ code: "provider_unmapped", message: "project has an unmapped progress provider" });
          }
        }

        // 4. Map the durable row → the workflow-port entry.
        return ok(toEntry(row));
      } catch {
        // TOTAL never-throws (§16): any unexpected fault fails closed.
        return err({ code: "project_unknown", message: "project registry resolution failed" });
      }
    },
  };
}

/** A provider is mapped iff BOTH its connectorId AND remoteHandle are non-empty. */
function isMappedProvider(p: ProjectRegistryProvider): boolean {
  return typeof p.connectorId === "string" && p.connectorId.length > 0 &&
    typeof p.remoteHandle === "string" && p.remoteHandle.length > 0;
}

// ── operational project-creation path (rule 1) ────────────────────────────────

/** The onboarding inputs to create a durable project-registry entry. */
export interface CreateProjectRegistryInput {
  readonly projectId: string;
  /** The BOUND workspace — MUST be a 14.1-registered workspace. */
  readonly workspaceId: string;
  readonly planPath?: string;
  readonly progressProviders?: readonly ProjectRegistryProvider[];
  readonly aliases?: readonly string[];
  readonly title: string;
  readonly slug: string;
  readonly lifecycleState: ProjectLifecycleState;
}

/**
 * Deps for the creation path — DELIBERATELY only the registry repo + the workspace
 * registry read. NO KnowledgeWriter, NO vault: the creation path writes ONLY the
 * operational registry row, never the canonical Project Markdown (safety rule 1). The
 * absence of a writer dep is the structural rule-1 boundary.
 */
export interface CreateProjectRegistryDeps {
  readonly repo: ProjectRegistryRepository;
  readonly readModels: ReadModelRepository;
}

/** Typed, redaction-safe creation failures (never a raw driver cause — §16 / rule 7). */
export type CreateProjectRegistryError =
  | { readonly code: "workspace_unknown"; readonly message: string }
  // A project's workspaceId is its WS-2/WS-8 binding anchor — IMMUTABLE through creation:
  // re-creating an existing projectId with a different workspaceId is rejected.
  | { readonly code: "project_workspace_immutable"; readonly message: string }
  | { readonly code: "store_fault"; readonly message: string };

/**
 * Create (or overwrite) a durable project-registry entry bound to a 14.1-REGISTERED
 * workspace. Writes ONLY `repo.upsert` — no KnowledgeWriter / Markdown (rule 1). Fails
 * closed on an unregistered workspace (`workspace_unknown`) or a store fault
 * (`store_fault`). Never throws.
 */
export async function createProjectRegistryEntry(
  deps: CreateProjectRegistryDeps,
  input: CreateProjectRegistryInput,
): Promise<Result<ProjectRegistryEntry, CreateProjectRegistryError>> {
  try {
    // 1. WS-8: a project can only bind to a workspace KNOWN in the 14.1 registry.
    const known = await resolveKnownWorkspace(deps.readModels, input.workspaceId);
    if (!known.ok) {
      return err({ code: "store_fault", message: "workspace registry unavailable" });
    }
    if (!known.value) {
      return err({ code: "workspace_unknown", message: "cannot bind a project to an unregistered workspace" });
    }

    // 2. WS-2/WS-8 ANCHOR IMMUTABILITY guard (mirrors 14.1 workspace-type immutability). A
    //    project's workspaceId is its durable-write target + isolation binding — re-creating an
    //    existing projectId with a DIFFERENT workspaceId would silently move the project (and its
    //    accumulated identity/content) across the isolation boundary. Reject it:
    //      • not_found            → a fresh create (fall through).
    //      • exists, SAME ws      → an idempotent overwrite (title/slug/planPath/providers/aliases).
    //      • exists, DIFFERENT ws → reject (project_workspace_immutable); NO upsert.
    //      • genuine get fault    → fail CLOSED (store_fault; never fall through to a write on an
    //                               unknown prior binding).
    const existing = await deps.repo.get(input.projectId);
    if (isOk(existing)) {
      if (existing.value.workspaceId !== input.workspaceId) {
        return err({ code: "project_workspace_immutable", message: "project workspace is immutable" });
      }
      // same workspace ⇒ an idempotent overwrite; fall through.
    } else if (existing.error.code !== "not_found") {
      return err({ code: "store_fault", message: "project registry get failed" });
    }

    // 3. Build the operational row (server-bound workspaceId).
    const row: ProjectRegistryRow = {
      projectId: input.projectId,
      workspaceId: input.workspaceId as WorkspaceId,
      ...(input.planPath !== undefined ? { planPath: input.planPath } : {}),
      progressProviders: input.progressProviders ?? [],
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      title: input.title,
      slug: input.slug,
      lifecycleState: input.lifecycleState,
    };

    // 4. Write ONLY the registry row (rule 1 — no KW / Markdown here).
    const up = await deps.repo.upsert(row);
    if (isErr(up)) {
      return err({ code: "store_fault", message: "project registry upsert failed" });
    }
    return ok(toEntry(up.value));
  } catch {
    // TOTAL never-throws (§16): make the "never throws" claim structural (mirrors resolve()),
    // not merely a reliance on the injected collaborators' never-reject contract.
    return err({ code: "store_fault", message: "project registry creation failed" });
  }
}
