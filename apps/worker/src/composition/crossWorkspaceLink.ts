// Task 14.7 — the cross-workspace-LINK owner-approval flow composition (worker leg).
//
// SAFETY-CRITICAL (safety rule 4 / WS-8 / §5-§6). The cross-workspace link is the SINGLE sanctioned
// cross-workspace read input — an APPROVED, DIRECTIONAL, SCOPED link authorizes reader-workspace A
// (`fromWorkspaceId`) to blend ONLY the sanitized slice of source-workspace B (`toWorkspaceId`).
// This module owns the WRITE side (create/approve/revoke); the READ gate that actually consults an
// approved link lives in `crossWorkspaceRead.ts`.
//
// Invariants enforced here:
//   - both endpoints must be 14.1-registered (WS-8 membership gate; fail-closed).
//   - a self-link (from === to) is rejected (not a cross-workspace read).
//   - a scopeless link is rejected (`cross_workspace_link_invalid_scope`) — a scopeless link would
//     read-match ALL of B (fail-open widening); scope is bounded + required.
//   - the (from, to, scope) tuple is the IMMUTABLE isolation anchor (worker Lesson 30) — a re-create
//     that changes it is rejected; an identical re-create is idempotent (status preserved, so an
//     approved link is never silently reset).
//   - a fresh link lands PENDING (owner approval is explicit — never pre-approved); a REVOKED link is
//     TERMINAL (`approve` requires status === pending, so a revoked link can never be revived).
//   - the link carries its OWN `status` — NOT an Approval.subjectKind (the frozen Approval enum is
//     untouched). §16: never throws; faults surface a stable code (no raw driver cause).
import { ok, err, isErr, isOk, isVisibilityLevel, type Result } from "@sow/contracts";
import type { VisibilityLevel, WorkspaceId } from "@sow/contracts";
import type { CrossWorkspaceLinkRepository, CrossWorkspaceLinkRow, ReadModelRepository } from "@sow/db";
import { resolveKnownWorkspace } from "../api/adapters/readModel";

/** The onboarding inputs to create a cross-workspace link. `status`/timestamps are NOT inputs — a
 *  fresh link always lands `pending` (owner approval is an explicit, separate transition). */
export interface CreateCrossWorkspaceLinkInput {
  readonly linkId: string;
  /** The READER (workspace A) — MUST be a 14.1-registered workspace. */
  readonly fromWorkspaceId: string;
  /** The SOURCE (workspace B) — MUST be a 14.1-registered workspace; distinct from the reader. */
  readonly toWorkspaceId: string;
  /** The bounded scope selector — required + non-empty (a scopeless link is unrepresentable). */
  readonly scopeProjectionType: string;
  readonly scopeVisibilityLevel: VisibilityLevel;
}

/** Deps for create — the link repo + the 14.1 workspace registry read (WS-8 gate) + a clock. */
export interface CreateCrossWorkspaceLinkDeps {
  readonly repo: CrossWorkspaceLinkRepository;
  readonly readModels: ReadModelRepository;
  readonly now: () => string;
}

/** Deps for the approve/revoke transitions — the repo + a clock (the link is already ws-bound). */
export interface CrossWorkspaceLinkStateDeps {
  readonly repo: CrossWorkspaceLinkRepository;
  readonly now: () => string;
}

/** Typed, redaction-safe create failures (never a raw driver cause). */
export type CreateCrossWorkspaceLinkError =
  | { readonly code: "workspace_unknown"; readonly message: string }
  | { readonly code: "cross_workspace_link_self"; readonly message: string }
  | { readonly code: "cross_workspace_link_invalid_scope"; readonly message: string }
  // The (from, to, scope) authorization tuple is the WS-8 isolation anchor — IMMUTABLE.
  | { readonly code: "cross_workspace_link_immutable"; readonly message: string }
  | { readonly code: "store_fault"; readonly message: string };

/** Typed, redaction-safe approve/revoke failures. */
export type CrossWorkspaceLinkTransitionError =
  | { readonly code: "link_unknown"; readonly message: string }
  | { readonly code: "link_not_pending"; readonly message: string }
  | { readonly code: "store_fault"; readonly message: string };

/**
 * Create (or idempotently re-create) a cross-workspace link between two 14.1-REGISTERED workspaces.
 * Mints a PENDING link (never pre-approved). Fails closed on an unregistered endpoint, a self-link,
 * a scopeless scope, a changed (from,to,scope) tuple, or a store fault. Never throws.
 */
export async function createCrossWorkspaceLink(
  deps: CreateCrossWorkspaceLinkDeps,
  input: CreateCrossWorkspaceLinkInput,
): Promise<Result<CrossWorkspaceLinkRow, CreateCrossWorkspaceLinkError>> {
  try {
    // 1. A self-link is not a cross-workspace read (WS-8) — reject before any store I/O.
    if (input.fromWorkspaceId === input.toWorkspaceId) {
      return err({ code: "cross_workspace_link_self", message: "a cross-workspace link cannot bind a workspace to itself" });
    }
    // 2. Scope-required guard: a scopeless / non-enum-visibility link would read-match ALL of B
    //    (a fail-open widening) — make it unrepresentable via the sanctioned path.
    if (input.scopeProjectionType.trim().length === 0 || !isVisibilityLevel(input.scopeVisibilityLevel)) {
      return err({ code: "cross_workspace_link_invalid_scope", message: "a cross-workspace link requires a bounded scope" });
    }
    // 3. WS-8: BOTH endpoints must be KNOWN in the 14.1 registry (a registry fault fails closed).
    const fromKnown = await resolveKnownWorkspace(deps.readModels, input.fromWorkspaceId);
    if (!fromKnown.ok) return err({ code: "store_fault", message: "workspace registry unavailable" });
    const toKnown = await resolveKnownWorkspace(deps.readModels, input.toWorkspaceId);
    if (!toKnown.ok) return err({ code: "store_fault", message: "workspace registry unavailable" });
    if (!fromKnown.value || !toKnown.value) {
      return err({ code: "workspace_unknown", message: "both workspaces must be registered to create a link" });
    }
    // 4. IMMUTABILITY anchor (Lesson 30): get-before-create. A re-create that changes the
    //    (from,to,scope) authorization tuple would silently rebind/widen across the isolation
    //    boundary — reject it. An identical re-create is idempotent (status preserved: never reset
    //    an already-approved link back to pending). A get-fault fails closed (no create).
    const existing = await deps.repo.get(input.linkId);
    if (isOk(existing)) {
      const e = existing.value;
      const sameTuple =
        e.fromWorkspaceId === input.fromWorkspaceId &&
        e.toWorkspaceId === input.toWorkspaceId &&
        e.scopeProjectionType === input.scopeProjectionType &&
        e.scopeVisibilityLevel === input.scopeVisibilityLevel;
      if (!sameTuple) {
        return err({ code: "cross_workspace_link_immutable", message: "cross-workspace link (from,to,scope) is immutable" });
      }
      return ok(e);
    } else if (existing.error.code !== "not_found") {
      return err({ code: "store_fault", message: "cross-workspace link get failed" });
    }

    // 5. Mint a PENDING link (owner approval is a separate explicit transition — never pre-approved).
    const row: CrossWorkspaceLinkRow = {
      linkId: input.linkId,
      fromWorkspaceId: input.fromWorkspaceId as WorkspaceId,
      toWorkspaceId: input.toWorkspaceId as WorkspaceId,
      scopeProjectionType: input.scopeProjectionType,
      scopeVisibilityLevel: input.scopeVisibilityLevel,
      status: "pending",
      createdAt: deps.now(),
      approvedAt: null,
      revokedAt: null,
    };
    const created = await deps.repo.create(row);
    if (isErr(created)) return err({ code: "store_fault", message: "cross-workspace link create failed" });
    return ok(created.value);
  } catch {
    return err({ code: "store_fault", message: "cross-workspace link creation failed" });
  }
}

/** Map a repo `get` fault → the typed transition error (not_found ⇒ link_unknown). */
function getFaultToTransitionError(code: string): CrossWorkspaceLinkTransitionError {
  return code === "not_found"
    ? { code: "link_unknown", message: "cross-workspace link not found" }
    : { code: "store_fault", message: "cross-workspace link get failed" };
}

/**
 * Approve a PENDING link (owner action, Level-3). Only a `pending` link may be approved — an
 * already-approved OR a REVOKED link ⇒ `link_not_pending` (a revoked link is TERMINAL, never
 * revived into the cross-read path). Absent link ⇒ link_unknown. Never throws.
 */
export async function approveCrossWorkspaceLink(
  deps: CrossWorkspaceLinkStateDeps,
  linkId: string,
): Promise<Result<CrossWorkspaceLinkRow, CrossWorkspaceLinkTransitionError>> {
  try {
    const existing = await deps.repo.get(linkId);
    if (isErr(existing)) return err(getFaultToTransitionError(existing.error.code));
    if (existing.value.status !== "pending") {
      return err({ code: "link_not_pending", message: "only a pending cross-workspace link can be approved" });
    }
    const res = await deps.repo.setStatus(linkId, "approved", deps.now());
    return isErr(res) ? err({ code: "store_fault", message: "cross-workspace link approve failed" }) : ok(res.value);
  } catch {
    return err({ code: "store_fault", message: "cross-workspace link approve failed" });
  }
}

/**
 * Revoke a link (owner action) — closes the cross-read path immediately. Allowed from pending OR
 * approved; an already-revoked link is an idempotent no-op (original stamp preserved). Absent link ⇒
 * link_unknown. Never throws.
 */
export async function revokeCrossWorkspaceLink(
  deps: CrossWorkspaceLinkStateDeps,
  linkId: string,
): Promise<Result<CrossWorkspaceLinkRow, CrossWorkspaceLinkTransitionError>> {
  try {
    const existing = await deps.repo.get(linkId);
    if (isErr(existing)) return err(getFaultToTransitionError(existing.error.code));
    if (existing.value.status === "revoked") return ok(existing.value); // idempotent no-op
    const res = await deps.repo.setStatus(linkId, "revoked", deps.now());
    return isErr(res) ? err({ code: "store_fault", message: "cross-workspace link revoke failed" }) : ok(res.value);
  } catch {
    return err({ code: "store_fault", message: "cross-workspace link revoke failed" });
  }
}

// ── injected command port (mirror connectorConfig / onboarding / projectRegistry) ─────────────

/** The injected cross-workspace-link command port — the procedure's ONLY registry I/O. */
export interface CrossWorkspaceLinkCommandPort {
  create(input: CreateCrossWorkspaceLinkInput): Promise<Result<CrossWorkspaceLinkRow, CreateCrossWorkspaceLinkError>>;
  approve(input: { linkId: string }): Promise<Result<CrossWorkspaceLinkRow, CrossWorkspaceLinkTransitionError>>;
  revoke(input: { linkId: string }): Promise<Result<CrossWorkspaceLinkRow, CrossWorkspaceLinkTransitionError>>;
}

/** Build the real {@link CrossWorkspaceLinkCommandPort} over the composition fns + the durable store. */
export function createCrossWorkspaceLinkCommandPort(deps: CreateCrossWorkspaceLinkDeps): CrossWorkspaceLinkCommandPort {
  return {
    create: (input) => createCrossWorkspaceLink(deps, input),
    approve: (input) => approveCrossWorkspaceLink({ repo: deps.repo, now: deps.now }, input.linkId),
    revoke: (input) => revokeCrossWorkspaceLink({ repo: deps.repo, now: deps.now }, input.linkId),
  };
}
