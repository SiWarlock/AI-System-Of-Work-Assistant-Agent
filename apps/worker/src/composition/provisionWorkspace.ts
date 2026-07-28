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
import { ok, err, isErr, defaultWorkspace, processorId, WorkspaceSchema, type Result, type Workspace, type WorkspaceType } from "@sow/contracts";
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
  //      • not_found            → a fresh CREATE — the ONLY branch that seeds (2a).
  //      • exists, SAME type    → an idempotent overwrite — carries the stored egress
  //                               posture forward + re-gates the aggregate (2b, task 9.23).
  //      • exists, DIFFERENT type → reject; upsert nothing, union nothing.
  //      • genuine store fault  → fail CLOSED (never fall through to create on an unknown
  //                               prior state — a transient fault must not bypass the guard).
  const existing = await workspaceConfig.get(spec.id as Workspace["id"]);
  if (isErr(existing)) {
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
    // 2b) exists, SAME type → an idempotent overwrite. Carry the STORED egress posture forward VERBATIM
    //     (task 9.23, ⚠ rule-5, completing worker L30's get-before-upsert on the field that derives
    //     egress-veto applicability). Previously the seed ran unconditionally above and this branch fell
    //     through to the upsert, so a re-provision silently restored a REVOKED
    //     `employerRawEgressAcknowledged` (9.10-B, `225c10ca`) with no audit row and no owner confirm —
    //     the revoke held only until someone re-provisioned.
    //
    //     ⚠ SCOPE: this carries `egressPolicy` ONLY, and that is a DELIBERATE, traced decision (task
    //     9.29) — not an oversight and not work left undone. `defaultWorkspace` above also rebuilds
    //     `providerMatrix`, `defaultVisibility` and `dataOwner` from the spec, so a re-provision
    //     rewrites those too. A reachability trace found NO production path that mutates them after
    //     provisioning: the only two writers of the config store are THIS function (which writes the
    //     defaults) and `egressRevoke` (which spreads the stored aggregate and touches only
    //     `egressPolicy`). So the stored values can only ever BE the defaults being rewritten, and the
    //     rewrite is a no-op today. Carrying them forward would preserve state that cannot yet differ.
    //     It would also carry `rawCloudEgressEnabled: true` through a re-provision that previously
    //     re-closed it — the inverted safety direction that kept 9.29 out of this rule-5 fix. (That
    //     value opens no gate TODAY: its only reader treats `true` as claim-DENYING. The objection is
    //     that carrying a permission-shaped field forward is a different argument from carrying a
    //     REVOKED one, and deserves its own review rather than riding in on a rule-5 slice.)
    //
    //     ⚠ The day that trace stops holding, this decision must be revisited PER FIELD — and the
    //     per-field direction is NOT uniform. It depends on the CONSUMER, not on the field:
    //       · `providerMatrix`    → reset to `{[], {}, false}` ⇒ FAIL-CLOSED everywhere it is read: an
    //         empty matrix denies routing (`policy/provider-matrix.ts`) and cannot support a local-only
    //         claim (`policy/processors.ts` `isLocalOnlyProviderMatrix` requires a non-vacuous matrix).
    //       · `defaultVisibility` → reset to `"isolated"` ⇒ DIRECTION-DEPENDENT. It is the most
    //         restrictive value for the GCL visibility CEILING (`policy/visibility.ts`), but it is the
    //         PERMISSIVE value at the approval gate: `policy/approval-policy.ts` auto-allow requires
    //         `=== "isolated"`, so resetting `coordination`→`isolated` ADDS auto-approve eligibility.
    //       · `dataOwner`         → re-derived from `type` ⇒ FAIL-OPEN at the same approval gate:
    //         auto-allow requires `dataOwner === "user"`, so a workspace hardened to `"employer"` that
    //         gets re-derived back to `"user"` moves an external action from requires-approval to
    //         auto-create — no §9 card, no owner sight.
    //         ⚠ NOTE the mechanism: the §5 EGRESS veto branches on `workspace.type` (which the
    //         immutability guard above already pins), NOT on `dataOwner` — `dataOwner` reaches the veto
    //         only as an audit ref. The fail-open surface here is the APPROVAL gate, not the egress veto.
    //     Both fail-open surfaces are unreachable from the store today (`resolveWorkspacePolicy` has no
    //     production caller; the one store→posture path projects neither field), which is why this is a
    //     documented invariant rather than a live hole.
    //
    //     Guarded by the writer census in `test/composition/provision-preserves-egress-posture.test.ts`,
    //     which pins BOTH the repo-type writers AND the direct `schema.workspaceConfig` table writers —
    //     so a new writer of either shape turns it red at exactly the moment this decision needs redoing.
    //     ⚠ Accepted residual: an OUT-OF-BAND change (a sqlite CLI edit, a restore from an older
    //     snapshot) can harden one of these fields with no code writer to catch — nothing goes red, and
    //     the next re-provision silently reverts it.
    //
    //     The WHOLE stored object is assigned, never a field-by-field copy — a named-field copy silently
    //     drops any field this build's `EgressPolicy` does not name. (A field a NEWER build wrote is
    //     rejected by the `.strict()` re-parse below, not carried — fail-closed, not forward-compatible.)
    //
    //     The carried object lands AFTER `defaultWorkspace` already parsed, so re-gate the aggregate.
    //     This parse is not a formality: the db `get` returns `row as Workspace`, an UNCHECKED CAST with
    //     no Zod on the read path, so this is the ONLY validation the stored blob ever receives before it
    //     re-crosses into a write. It catches a foreign `egressPolicy.workspaceId` (the identity refine),
    //     a contradictory `acknowledgedAt`-without-ack, a non-array allowlist, and any unknown key —
    //     do NOT narrow it to a hand-written id comparison.
    //     FAIL-CLOSED rather than normalizing a foreign workspaceId to `spec.id`: normalizing would graft
    //     another workspace's allowlist + ack onto this one, stamped as if it belonged here (a
    //     WS-8-adjacent write that looks legitimate afterwards). Same posture as the store-fault branch:
    //     never proceed over a contradictory prior state.
    workspace = { ...workspace, egressPolicy: existing.value.egressPolicy };
    try {
      workspace = WorkspaceSchema.parse(workspace);
    } catch {
      // Redaction-safe: never echo the raw Zod detail (it would carry the stored values).
      return err({ code: "invalid_workspace", message: "stored workspace failed validation" });
    }
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
