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
import { ok, err, isErr, defaultWorkspace, processorId, type Result, type Workspace, type WorkspaceType } from "@sow/contracts";
import type { ReadModelRepository, WorkspaceConfigRepository } from "@sow/db";
import { registerWorkspace } from "./workspaceRegistry";

/**
 * Seed the cloud-copilot egress allowlist at provisioning (task 9.10-A + the 9.10 employer FLIP). Under
 * the store-backed single-source resolver the durable `egressPolicy` is the SOLE veto posture, so a
 * workspace's PERSISTED allowlist must include the cloud-copilot processor (`claude`) for its cloud
 * allow-path to survive (else the veto's allowlist step DENYs `PROCESSOR_NOT_ALLOWED`).
 *
 *   • PERSONAL (`personal_business`/`personal_life`): allowlist `[claude]`; the ack flag stays `false`
 *     (the employer veto never bites for personal — 9.10-A).
 *   • ⛔ `employer_work` — the OWNER-AUTHORIZED rule-5 FLIP (9.10, 2026-07-25, via lead): employer cloud
 *     egress is OPEN by default-seed, **SCOPED to `[claude]` ONLY** — the active `claude` login IS the
 *     company subscription (company-sanctioned; §ARM-18 login=company precondition owner-confirmed). Sets
 *     `employerRawEgressAcknowledged=true` + `acknowledgedAt` so the veto ALLOWS employer-raw cloud
 *     `[claude]`; a NON-`claude` processor is STILL DENIED by the veto's allowlist (a scoped open, NEVER
 *     blanket-cloud). Supersedes 9.10-B's audited-acknowledge as the employer-open mechanism (owner chose
 *     the silent default-seed). ⚠ Provisioning-time only — no retroactive migration of existing rows.
 *     ⚠ RESIDUAL (§ARM-18): employer content egresses under whatever `claude` login is ACTIVE at run time
 *     — "company-sanctioned" holds ONLY while the COMPANY login is active; there is NO re-confirm on a
 *     login switch. The per-workspace subscription-split is the clean end-state (tracked, not this slice).
 *   • Any OTHER/future type stays fail-closed (allowlist form — never auto-seeded).
 *
 * `now` stamps `acknowledgedAt` on the employer seed (the provisioning clock). Pure.
 */
export function seedCloudCopilotAllowlist(workspace: Workspace, now: string): Workspace {
  const claude = processorId("claude");
  if (workspace.type === "personal_business" || workspace.type === "personal_life") {
    return {
      ...workspace,
      egressPolicy: { ...workspace.egressPolicy, allowedProcessors: [claude], rawContentAllowedProcessors: [claude] },
    };
  }
  if (workspace.type === "employer_work") {
    return {
      ...workspace,
      egressPolicy: {
        ...workspace.egressPolicy,
        allowedProcessors: [claude],
        rawContentAllowedProcessors: [claude],
        employerRawEgressAcknowledged: true,
        acknowledgedAt: now,
      },
    };
  }
  // ALLOWLIST fail-closed: any other/future type stays with empty allowlists (never auto-seeded).
  return workspace;
}

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
  | { readonly code: "store_fault"; readonly message: string }
  // Task 9.21-A. The config row IS durably written (the create insert or the same-type update
  // succeeded) — only the LAST step, the registry union, faulted. Distinct from `store_fault`
  // because a durable side effect already landed: the caller can resume (re-provision the same
  // id) rather than retry a no-op. `configWritten`/`incompleteStep` are step-identity flags only
  // — never the raw `registerWorkspace` cause (§16 / rule 7).
  | {
      readonly code: "partial_scaffold";
      readonly message: string;
      readonly configWritten: true;
      readonly incompleteStep: "registry_union";
    }
  // Task 9.36 — a stored row failed re-validation at the repository read boundary (an
  // out-of-band-corrupted row, never producible by a real writer — see workspace-read-gate.ts).
  // PERMANENTLY non-retryable, distinct from `store_fault`.
  | { readonly code: "stored_row_schema_violation"; readonly message: string };

/**
 * Wrap a `registerWorkspace` fault as the distinct, resumable `partial_scaffold` outcome
 * (task 9.21-A). Both call sites reach this ONLY after their own durable write (the same-type
 * update or the create insert) already succeeded — the registry union is always the last step.
 * Discards the raw `RegistryUnionError` cause; only the step identity crosses (§16 / rule 7).
 */
function partialScaffold(): ProvisionWorkspaceError {
  return {
    code: "partial_scaffold",
    message: "workspace config written; registry union incomplete",
    configWritten: true,
    incompleteStep: "registry_union",
  };
}

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
  //      • not_found            → a fresh CREATE — the ONLY branch that seeds (2a).
  //      • exists, SAME type    → an idempotent overwrite — carries the stored egress
  //                               posture forward + re-gates the aggregate (2b, task 9.23).
  //      • exists, DIFFERENT type → reject; upsert nothing, union nothing.
  //      • genuine store fault  → fail CLOSED (never fall through to create on an unknown
  //                               prior state — a transient fault must not bypass the guard).
  const existing = await workspaceConfig.get(spec.id as Workspace["id"]);
  if (isErr(existing)) {
    // Task 9.36 — classify, don't collapse: a referentially-inconsistent stored row is distinct
    // from a generic store fault (permanently non-retryable).
    if (existing.error.code === "stored_row_schema_violation") {
      return err({ code: "stored_row_schema_violation", message: "workspace config read failed re-validation" });
    }
    if (existing.error.code !== "not_found") {
      return err({ code: "store_fault", message: "workspace config get failed" });
    }
    // 2a) not_found → a genuine fresh CREATE. This is the ONLY branch that may SEED the cloud-copilot
    //     egress allowlist (9.10-A personal + the 9.10 employer FLIP: `[claude]`, employer default-seeded
    //     ack=true + `acknowledgedAt` stamped from `at`). Seeding here rather than before the existence
    //     check is what makes the invariant STRUCTURAL — provisioning seeds only what it CREATES — so
    //     there is no window in which a seeded-but-not-yet-overwritten policy exists (task 9.23).
    workspace = seedCloudCopilotAllowlist(workspace, at);
  } else if (existing.value.type !== spec.type) {
    return err({
      code: "workspace_type_immutable",
      message: "workspace type is immutable through onboarding",
    });
  } else {
    // 2b) exists, SAME type → an idempotent overwrite. Write ONLY the provisioning-owned fields
    //     (task 9.30, Option A). This RETURNS EARLY — the whole-aggregate `upsert` at step 3 is the
    //     CREATE path only.
    //
    //     WHY NARROW THE WRITE. The `get` above and the write below are a non-atomic read-modify-write.
    //     While provisioning wrote the WHOLE aggregate, it had to write back posture columns it had read
    //     earlier — so a `revokeEgressAck` landing in that window was silently clobbered (9.23's
    //     fail-open, narrowed to a race, still with no audit row). Narrowing the write removes the
    //     egress column from THIS statement, so a concurrent revoke has nothing here to lose.
    //
    //     ⚠ THAT CLAIM IS DIRECTIONAL — do not read it as "the race is closed". It holds in the ACK
    //     direction only. `revokeEgressAck` is still itself a whole-aggregate read-modify-write
    //     (`egressRevoke.ts`: get → spread the stored row → upsert), so the MIRROR interleave is still
    //     live: a rename landing inside the revoke's window is silently reverted. That direction is
    //     benign (a lost rename, never a lost revoke), which is why it is task 9.38 rather than part of
    //     this fix — but an unqualified "nothing can be lost" would be a one-directional claim stated as
    //     a total one, the exact defect shape this slice exists to close.
    //
    //     ⚠ Why this path does NOT copy the sibling's answer. `workspaceRegistry`'s
    //     `arch_gap (concurrency)` note ACCEPTS the same class of race — but explicitly because its
    //     direction is fail-SAFE (a dropped id goes invisible; scoped reads fail closed) and because
    //     "a re-provision repairs it". Both halves INVERT here: a lost update reverts a revoke
    //     (ack false→true, fail-OPEN), and a re-provision is precisely what CAUSES it. Adopting that
    //     note's conclusion would have meant keeping its words and discarding the premise that earned
    //     them.
    //
    //     ⛔ 9.23's `egressPolicy` CARRY-FORWARD IS DELETED HERE, DELIBERATELY — not lost. It existed to
    //     stop the whole-aggregate write from clobbering stored posture; this path no longer writes that
    //     column at all, so the carry is moot and `ProvisioningOwnedFields` makes a posture write
    //     UNTYPEABLE from here. The guarantee is now structural instead of remembered. Pinned by
    //     `provisioning_write_cannot_touch_egress_state`.
    //
    //     ⛔ 9.23's `WorkspaceSchema.parse` RE-GATE IS ALSO GONE, and its reason evaporates rather than
    //     being ignored. That parse existed because the carried blob — read through the repo's unchecked
    //     `row as Workspace` cast — was about to RE-CROSS INTO A WRITE, and it was the only validation
    //     that blob would ever get. Under Option A the stored blob is never written back: the update
    //     carries three caller-supplied primitives, none of them read from the row. Nothing untrusted
    //     re-crosses, so there is nothing left to re-gate.
    //     ⚠ THE BOUND ON "THE REVOKE IS DURABLE" (task 9.31) — read this before answering that question
    //     unqualified. 9.23 + 9.30 make an owner's revoke durable for a workspace ROW: no re-provision
    //     of THAT id can restore it, racing or not. They do NOT make it durable for a VAULT.
    //     `createWorkspace` takes a caller-chosen `id` and nothing enforces uniqueness on
    //     `markdownRepoPath`, so a NEW `employer_work` workspace pointed at the SAME vault root is a
    //     fresh create — and a fresh create seeds `ack=true` (step 2a).
    //     Why that is currently a bound and not a hole: `Workspace.markdownRepoPath` has NO production
    //     consumer. The running worker's vault comes from BOOT CONFIG (`backends.ts`
    //     `createFsVault(config.vaultRoot ?? …)`), never from the workspace row — the field is written
    //     and never read. So "two workspaces sharing a vault root" is not a state anything can act on
    //     today: the worker has exactly one vault. The day something binds work to a workspace BY vault
    //     path, this stops being a bound and becomes a real second door onto a revoked posture.
    //     Guarded by `markdownRepoPath_has_no_production_consumer` — it fires at exactly that moment.
    //
    //     The three values come from the VALIDATED aggregate built at step 1, not from the raw `spec`:
    //     `defaultWorkspace` already Zod-parsed them (and brands `gbrainBrainId`), so the narrow update
    //     inherits that validation instead of re-admitting unparsed caller input on a second path.
    const updated = await workspaceConfig.updateProvisioningFields(spec.id as Workspace["id"], {
      name: workspace.name,
      markdownRepoPath: workspace.markdownRepoPath,
      gbrainBrainId: workspace.gbrainBrainId,
    });
    if (isErr(updated)) {
      // Task 9.36 — the RETURNING row hands back posture columns this write never touched; a
      // PRE-EXISTING corrupt row surfaces here too. Classify, don't collapse.
      if (updated.error.code === "stored_row_schema_violation") {
        return err({ code: "stored_row_schema_violation", message: "workspace config update read-back failed re-validation" });
      }
      return err({ code: "store_fault", message: "workspace config update failed" });
    }
    // Union into the registry exactly as the create path does — a re-provision must still repair a
    // workspace that was written but never registered (the fail-closed WS-8 ordering).
    const regExisting = await registerWorkspace(readModels, spec.id, at);
    // Task 9.21-A: the update above already landed durably — a union fault here is the distinct,
    // resumable `partial_scaffold` outcome, not the generic `store_fault` (see `partialScaffold`).
    if (!regExisting.ok) return err(partialScaffold());
    return ok({ id: spec.id, registryMember: true, preset: spec.preset });
  }

  // 3) CREATE ONLY (task 9.30 — the same-type overwrite returned above). Insert the whole seeded
  //    aggregate FIRST, so a later union fault leaves the workspace invisible (fail-closed), never
  //    registry-known-but-config-less. Reaching here means the row did not exist at the check, so
  //    this write has no stored posture to clobber.
  //    ⚠ INSERT-ONLY, not `upsert` (task 9.30, second half — caught in review after the same-type
  //    branch was narrowed). A plain upsert is `INSERT … ON CONFLICT DO UPDATE <every column>`, so this
  //    branch carried the SAME race it was fixing next door: read `not_found`, lose the window to a
  //    create AND a revoke, then conflict-update the freshly-seeded `ack=true` straight back over the
  //    owner's decision. Insert-only makes the loser of that race write NOTHING and fail loudly here,
  //    rather than silently adopting — and inheriting the posture of — a row it did not create.
  const up = await workspaceConfig.insertIfAbsent(workspace);
  if (isErr(up)) {
    return err({ code: "store_fault", message: "workspace config insert failed" });
  }
  if (!up.value) {
    // A row appeared between the existence check and this insert. Never overwrite it: the prior state
    // is unknown to us (it may already carry a revoked posture), which is the store-fault posture.
    return err({ code: "store_fault", message: "workspace was created concurrently" });
  }

  // 4) Union into the fail-closed WS-8 registry — the SOLE visibility authority. Only
  //    now is the workspace resolvable by a scoped read.
  const reg = await registerWorkspace(readModels, spec.id, at);
  // Task 9.21-A: the insert above already landed durably (fail-closed insert-first ordering) — a
  // union fault here is the distinct, resumable `partial_scaffold` outcome, not `store_fault`.
  if (!reg.ok) return err(partialScaffold());

  return ok({ id: spec.id, registryMember: true, preset: spec.preset });
}
