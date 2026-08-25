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
// ✅ 13.5 (DECIDED + LANDED): the frozen `ResolveRegistryError` set (`project_unknown` |
// `provider_unmapped`) has no fault code and stays that way — WIDENING it would be a caller-
// visible change to a shared `@sow/workflows` port (out of this file's territory) and would risk a
// future caller treating a transient fault as a "confirmed unknown" in a NEW way it isn't prepared
// for. So the RETURNED Result is UNCHANGED: a store fault still folds to `project_unknown`,
// fail-closed, exactly as before (never a false resolve). What's NEW is a SEPARATE, OPTIONAL,
// best-effort observability channel (`recordResolveFault`, mirroring `living-vault.ts`'s
// `recordRefusals` — L25/L53 discipline): fired ONLY on a genuine repo/store FAULT (any `resolveRef`
// Err whose code is NOT `not_found`), NEVER on a benign not-found. This is the "two typed outcomes"
// split: the CALLER-VISIBLE contract stays one code; the OPERATOR-VISIBLE signal now distinguishes
// "this really is unknown" from "the lookup itself broke" — the fault/degrade distinction the old
// arch_gap comment worried would be lost forever.
//
// DORMANCY (Lesson 11): the projectSync workflow (`runProjectSync`) has NO production
// dispatch yet, so this port is UNIT-TESTED + is the canonical impl, but is NOT bound
// into a dispatched workflow at boot (dormant-on-dormant); that binding is a named
// spine follow-up. The creation path IS boot-wired (the reachable production entry).
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type { ProjectLifecycleState, WorkspaceId, SourceRef, ProvenanceOrigin } from "@sow/contracts";
import type {
  ProjectRegistryRepository,
  ProjectRegistryRow,
  ProjectRegistryProvider,
  ReadModelRepository,
} from "@sow/db";
import {
  createBuildSyncOutputsActivity,
  createProjectSyncOutputsProjection,
  createValidateNarrativePort,
} from "@sow/workflows";
import type {
  ProjectSyncContext,
  ProjectRegistryEntry,
  ResolveRegistryPort,
  ResolveRegistryError,
  BuildSyncOutputsPort,
  ValidateNarrativePort,
  ProjectSyncUpdateDashboardPort,
  NoteExistsReader,
  NoteExistsError,
} from "@sow/workflows";
import { resolveKnownWorkspace } from "../api/adapters/readModel";
import { createProjectDashboardUpdatePort } from "../api/projections/projectDashboardUpdate";

/**
 * Map a durable `ProjectRegistryRow` → the `@sow/workflows` `ProjectRegistryEntry`
 * port type at the worker boundary. The two shapes are structurally identical (Q1),
 * so this is a documented pass-through — it exists to name the boundary, not transform.
 */
function toEntry(row: ProjectRegistryRow): ProjectRegistryEntry {
  return row;
}

/**
 * 13.5 arch_gap — the code-only fault signal `recordResolveFault` carries. NEVER a raw driver
 * cause (rule 7) — `code` is the underlying `DbError.code` only (e.g. `"unavailable"`), never the
 * `DbError.message`/`cause`, which may carry a connection string or other operational detail.
 */
export interface ProjectRegistryResolveFault {
  readonly projectRef: string;
  readonly code: string;
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
  /** 13.5 — optional best-effort fault signal (see {@link ProjectRegistryResolveFault}'s own doc
   *  and the module header above). Fired ONCE, ONLY on a genuine repo fault (never a benign
   *  not_found). Never alters the returned `Result`; never escapes as an unhandled rejection,
   *  whether the sink throws sync or rejects async (L25/L53 best-effort). Unbound (the shipped
   *  default) ⇒ zero invocations, byte-equivalent to the pre-13.5 behavior (L11). */
  readonly recordResolveFault?: (fault: ProjectRegistryResolveFault) => Promise<unknown>;
}): ResolveRegistryPort {
  const emitResolveFault = (projectRef: string, code: string): void => {
    if (typeof deps.recordResolveFault !== "function") return;
    try {
      void deps.recordResolveFault({ projectRef, code }).catch(() => {});
    } catch {
      /* best-effort — a throwing sink must never alter the primary Result. */
    }
  };
  return {
    async resolve(
      ctx: ProjectSyncContext,
    ): Promise<Result<ProjectRegistryEntry, ResolveRegistryError>> {
      try {
        // 1. GLOBAL ref lookup (projectId or alias; ambiguous alias ⇒ repo not_found).
        const found = await deps.repo.resolveRef(ctx.projectRef);
        if (isErr(found)) {
          // 13.5: a genuine store FAULT (any code OTHER than the benign `not_found`) fires the
          // OPTIONAL observability signal — the returned Result still folds to `project_unknown`
          // either way (fail-closed; the closed error set has no fault code — a fault must NEVER
          // surface as a false resolve).
          if (found.error.code !== "not_found") {
            emitResolveFault(ctx.projectRef, found.error.code);
          }
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 13.5 — buildProjectSyncWorkerPorts: assemble the WORKER-composable subset of ProjectSyncDeps.
//
// `ParseProgressPort` / `SynthesizeNarrativePort` / `CommitStatusPort` / `ProjectSyncProposeActionsPort`
// / `ProjectSyncHealthSink` are DELIBERATELY NOT assembled here: the first two need real connector/
// Broker wiring (providers-integrations territory — "consume their ports, do not reimplement," this
// package's own brief); `CommitStatusPort` is the SAME KnowledgeWriter commit activity the
// meeting/source paths already use (a single shared binding, not re-implemented per-pipeline —
// PKG-W1's boot territory); the health sink + Temporal schedule activation are PKG-W2's (this leg's
// own scope note: "Leave Temporal schedule activation to PKG-W2").
//
// What IS assembled here, all from EXISTING @sow/workflows concrete port implementations (no
// invented business logic — mirrors `buildIngestRewriteDeps`'s ARM-RESEARCH-3 pattern):
//   • `resolve`      — `createProjectRegistryResolvePort` (this file, 14.6 + the 13.5 fault split
//                       above).
//   • `buildOutputs` — `createBuildSyncOutputsActivity` composed with `createProjectSyncOutputsProjection`
//                       (both already exist in @sow/workflows, INCLUDING the §13.5 create-vs-patch
//                       split — `createBuildSyncOutputsActivity` already probes `NoteExistsReader`
//                       and derives create-vs-patch; there was nothing left to build there). A REAL
//                       `NoteExistsReader` is built here over the injected vault reader, mirroring
//                       `buildActivities.ts`'s own meeting-path `meetingNoteExists` pattern exactly.
//   • `validate`     — `createValidateNarrativePort` (already exists; zero worker-specific deps).
//   • `dashboard`    — `createProjectDashboardUpdatePort` (already exists at
//                       `apps/worker/src/api/projections/projectDashboardUpdate.ts`).

/** The worker-composable subset of `ProjectSyncDeps` — the four ports buildable at THIS
 *  composition root without a connector/Broker/KnowledgeWriter binding. */
export interface ProjectSyncWorkerPorts {
  readonly resolve: ResolveRegistryPort;
  readonly buildOutputs: BuildSyncOutputsPort;
  readonly validate: ValidateNarrativePort;
  readonly dashboard: ProjectSyncUpdateDashboardPort;
}

export interface BuildProjectSyncWorkerPortsInput {
  readonly repo: ProjectRegistryRepository;
  readonly readModels: ReadModelRepository;
  /** A real vault content reader (e.g. `backends.vault.read`) — used to build a REAL
   *  `NoteExistsReader` for the create-vs-patch probe. */
  readonly vault: { read(path: string): Promise<string | undefined> };
  /** The `SourceRef` `buildOutputs`'s derived plan cites (REQ-F-006: ≥1 sourceRef). */
  readonly sourceRef: SourceRef;
  readonly planIdentity: Record<string, string>;
  readonly provenanceOrigin?: ProvenanceOrigin;
  /** ISO-8601 now — for the dashboard-update activity's `rebuiltAt` stamp. */
  readonly now: () => string;
  /** 13.5 arch_gap resolution — see {@link ProjectRegistryResolveFault}'s own doc. */
  readonly recordResolveFault?: (fault: ProjectRegistryResolveFault) => Promise<unknown>;
}

/** A `NoteExistsReader` over an injected async vault reader — byte-for-byte the SAME shape
 *  `buildActivities.ts` already binds for the meeting path's `meetingNoteExists`, so a project-
 *  status note-exists probe and a meeting note-exists probe share one reviewed pattern. A throwing
 *  reader fails the probe CLOSED (a typed `read_failed`), never a guessed create-vs-patch. */
function createVaultNoteExistsReader(vault: BuildProjectSyncWorkerPortsInput["vault"]): NoteExistsReader {
  return {
    async exists(path: string): Promise<Result<boolean, NoteExistsError>> {
      try {
        const content = await vault.read(path);
        return ok(content !== undefined);
      } catch (cause) {
        return err({ code: "read_failed", message: "project note-exists probe: vault read failed", cause });
      }
    },
  };
}

/**
 * Assemble the worker-composable subset of `ProjectSyncDeps` (see the module comment above for what
 * is deliberately excluded and why). Every port is REAL — no fakes — built from EXISTING
 * @sow/workflows concrete implementations + this file's own registry port. Reduces the eventual
 * boot call site (PKG-W1's hand-off) to these simple inputs instead of assembling four separate
 * port factories itself.
 */
export function buildProjectSyncWorkerPorts(input: BuildProjectSyncWorkerPortsInput): ProjectSyncWorkerPorts {
  return {
    resolve: createProjectRegistryResolvePort({
      repo: input.repo,
      readModels: input.readModels,
      ...(input.recordResolveFault !== undefined ? { recordResolveFault: input.recordResolveFault } : {}),
    }),
    buildOutputs: createBuildSyncOutputsActivity({
      projection: createProjectSyncOutputsProjection(),
      sourceRef: input.sourceRef,
      planIdentity: input.planIdentity,
      noteExists: createVaultNoteExistsReader(input.vault),
      ...(input.provenanceOrigin !== undefined ? { provenanceOrigin: input.provenanceOrigin } : {}),
    }),
    validate: createValidateNarrativePort(),
    dashboard: createProjectDashboardUpdatePort({ readModels: input.readModels, now: input.now }),
  };
}
