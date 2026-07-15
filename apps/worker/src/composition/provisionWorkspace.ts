// Task 14.1 (worker leg) — the PRODUCTION workspace-provisioning path. The real
// replacement for the dev-only `provisionDevWorkspace` fixture: a user can now EXIST
// in the system without a `devProvision` boot spec.
//
// `provisionWorkspace` mints a workspace by (1) building a VALIDATED `Workspace` via
// the safe-default `defaultWorkspace()` factory (egress CLOSED, `isolated` visibility
// — safety rule 5, by construction), (2) upserting it into the durable
// `WorkspaceConfigRepository` (OPERATIONAL TRUTH, MUTABLE), and (3) unioning its id
// into the fail-closed WS-8 `{workspaceIds}` registry — the SOLE authority for
// workspace-scoped-read VISIBILITY (lead ruling #1; `resolveKnownWorkspace` reads only
// the registry). The config store is data-ABOUT a registered workspace, never the
// scoped-read visibility gate.
//   arch_gap: other consumers (the copilot propose sinks) independently gate their own
//   validity on `workspaceConfig.get` rather than the registry, so after a PARTIAL
//   provision (upsert ok, union fault) a config-known-but-registry-absent workspace is
//   invisible to scoped reads (safe) yet acceptable to those sinks. Fail-safe (approvals
//   are workspaceId-folded → no cross-workspace leak); reconciling those gates onto the
//   registry is a separate follow-up (tracked; not 14.1 scope).
//
// ORDER IS LOAD-BEARING: upsert PRECEDES the registry union. A partial failure
// (upsert faults) therefore never yields a registry-KNOWN workspace lacking its
// egress-CLOSED config row — that would be a rule-5 fail-open (a consumer reading
// `egressPolicy` off a "known" but config-less workspace gets no governance posture).
// Fail-closed at every step: any store fault is a typed err (never a throw, never a
// partial visible workspace).
//
// PRODUCTION ≠ DEV SEEDING: unlike `provisionDevWorkspace`, this writes NO read-model
// cards / project dashboards / recent-changes rows (no checkbox parse). It stands the
// workspace up; the surfaces stay empty until a real producer populates them.
//
// SCOPE: worker composition only. Never writes Markdown, never routes a semantic
// mutation, never touches secrets.
import { ok, err, isErr, defaultWorkspace, type Result, type Workspace, type WorkspaceType } from "@sow/contracts";
import type { ReadModelRepository, WorkspaceConfigRepository } from "@sow/db";
import { registerWorkspace } from "./workspaceRegistry";

/** The onboarding inputs a real user supplies to mint a workspace. */
export interface ProvisionWorkspaceSpec {
  /** The workspace scope id (e.g. "employer-work") — the registry membership key. */
  readonly id: string;
  /** Human-readable workspace name. */
  readonly name: string;
  /** The workspace type (drives the safe data-owner default in `defaultWorkspace`). */
  readonly type: WorkspaceType;
  /** The chosen vault root → the existing `Workspace.markdownRepoPath` (no frozen-seam change). */
  readonly vaultRoot: string;
  /** The gbrain brain id for this workspace. */
  readonly gbrainBrainId: string;
  /**
   * The chosen onboarding preset (Simple/Professional/Founder/Advanced). CAPTURED as
   * an onboarding input this slice — NOT persisted. 14.5 (preset → provisioning-profile
   * mapping) owns preset consumption; the frozen `Workspace` seam gains no preset field.
   * arch_gap: threaded here so the choice is available to 14.5 without a re-plumb.
   */
  readonly preset: string;
}

/** The narrow deps the production provisioner needs. */
export interface ProvisionWorkspaceDeps {
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly readModels: ReadModelRepository;
  readonly now: () => string;
}

/** Typed, redaction-safe provisioning failures (never a raw driver cause — §16 / safety rule 7). */
export type ProvisionWorkspaceError =
  | { readonly code: "invalid_workspace"; readonly message: string }
  // The workspace `type` (⇒ dataOwner ⇒ the rule-5 egress-veto anchor + WS-8 class) is
  // IMMUTABLE through onboarding — re-onboarding an existing id with a different type is rejected.
  | { readonly code: "workspace_type_immutable"; readonly message: string }
  | { readonly code: "store_fault"; readonly message: string };

/** The provisioned-workspace summary returned on success (registry-member by construction). */
export interface ProvisionedWorkspace {
  readonly id: string;
  readonly registryMember: true;
  /** Echoes the captured preset choice (unpersisted this slice; for 14.5). */
  readonly preset: string;
}

/**
 * Provision ONE workspace: build a validated safe-default `Workspace`, upsert it into
 * the durable config store, then union its id into the fail-closed registry. Returns a
 * typed err (never throws) on an invalid aggregate or any store fault. Total by
 * construction — the composition function AND the future desktop port-caller invoke it
 * directly, so it must never let a throw cross the boundary (§16).
 */
export async function provisionWorkspace(
  deps: ProvisionWorkspaceDeps,
  spec: ProvisionWorkspaceSpec,
): Promise<Result<ProvisionedWorkspace, ProvisionWorkspaceError>> {
  const { workspaceConfig, readModels, now } = deps;
  const at = now();

  // 1) Build the VALIDATED aggregate with the safe-default posture (egress CLOSED,
  //    isolated). `defaultWorkspace` parses via Zod and THROWS on an invalid input —
  //    contain it as a typed err so the boundary stays total (§16).
  let workspace: Workspace;
  try {
    workspace = defaultWorkspace({
      id: spec.id,
      name: spec.name,
      type: spec.type,
      markdownRepoPath: spec.vaultRoot,
      gbrainBrainId: spec.gbrainBrainId,
    });
  } catch {
    // Redaction-safe: never echo the raw Zod/driver detail.
    return err({ code: "invalid_workspace", message: "workspace validation rejected" });
  }

  // 2) Isolation-class immutability guard. The workspace `type` anchors `dataOwner` (the
  //    rule-5 egress-veto applicability) + the WS-8 classification — onboarding may CREATE
  //    a workspace or idempotently overwrite same-type fields (name/vaultRoot), but must
  //    NEVER silently flip the type (employer_work→personal_life would downgrade
  //    dataOwner employer→user, a latent veto-applicability open). Read the existing row:
  //      • not_found            → a fresh CREATE (fall through).
  //      • exists, SAME type    → an idempotent overwrite (fall through).
  //      • exists, DIFFERENT type → reject; upsert nothing, union nothing.
  //      • genuine store fault  → fail CLOSED (never fall through to create on an unknown
  //                               prior state — a transient fault must not bypass the guard).
  const existing = await workspaceConfig.get(spec.id as Workspace["id"]);
  if (isErr(existing)) {
    if (existing.error.code !== "not_found") {
      return err({ code: "store_fault", message: "workspace config get failed" });
    }
    // not_found → a fresh create; fall through.
  } else if (existing.value.type !== spec.type) {
    return err({
      code: "workspace_type_immutable",
      message: "workspace type is immutable through onboarding",
    });
  }

  // 3) Upsert into the durable operational store FIRST — so a later union fault leaves
  //    the workspace invisible (fail-closed), never registry-known-but-config-less.
  const up = await workspaceConfig.upsert(workspace);
  if (isErr(up)) {
    return err({ code: "store_fault", message: "workspace config upsert failed" });
  }

  // 4) Union into the fail-closed WS-8 registry — the SOLE visibility authority. Only
  //    now is the workspace resolvable by a scoped read.
  const reg = await registerWorkspace(readModels, spec.id, at);
  if (!reg.ok) return err(reg.error);

  return ok({ id: spec.id, registryMember: true, preset: spec.preset });
}
