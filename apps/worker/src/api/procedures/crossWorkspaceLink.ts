// Task 14.7 — the `crossWorkspaceLink` command procedure: create / approve / revoke.
//
// The owner-approval surface for the SINGLE sanctioned WS-8 cross-workspace read input (§19.1 /
// §5-§6; safety rule 4). Validates the candidate input at the transport edge (the parser WHITELISTS
// fields, so a smuggled status="approved"/timestamp can NEVER pre-approve a link — owner approval
// stays an explicit, separate transition), calls the injected CrossWorkspaceLinkCommandPort (the
// real binding wraps the composition over @sow/db), and returns typed UI-safe summaries. §16: never
// throws; a fault surfaces a STABLE code, never a raw driver cause. Mirrors connectorConfig.ts.
import { publicProcedure, router, authedResolver } from "../router";
import { ok, err, failure, isVisibilityLevel, type Result, type FailureVariant } from "@sow/contracts";
import type { CrossWorkspaceLinkRow } from "@sow/db";
import {
  type CrossWorkspaceLinkCommandPort,
  type CreateCrossWorkspaceLinkInput,
  type CreateCrossWorkspaceLinkError,
  type CrossWorkspaceLinkTransitionError,
} from "../../composition/crossWorkspaceLink";

// Re-export the port type so the integrator (server.ts) imports the whole surface from here.
export type { CrossWorkspaceLinkCommandPort };

/** Dependencies for {@link buildCrossWorkspaceLinkRouter}. */
export interface CrossWorkspaceLinkDeps {
  readonly crossWorkspaceLink: CrossWorkspaceLinkCommandPort;
}

/** The renderer-facing cross-workspace-link summary (all fields non-secret; directional + scoped). */
export interface UiSafeCrossWorkspaceLink {
  readonly linkId: string;
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly scopeProjectionType: string;
  readonly scopeVisibilityLevel: string;
  readonly status: string;
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly revokedAt: string | null;
}

// ── Input validation (candidate-data gate — PURE, no new dependency) ─────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function invalidInput(code: string): FailureVariant {
  return failure("validation_rejected", "invalid cross-workspace-link input", { cause: { code } });
}
const passthroughInput = (raw: unknown): unknown => raw;

/**
 * Validate a raw `create` input at the transport edge. Builds a WHITELISTED
 * {@link CreateCrossWorkspaceLinkInput} (scope fields only — a smuggled `status`/`approvedAt` is
 * NOT read, so it can never pre-approve a link). Returns a typed `err(validation_rejected)` on any
 * malformed field — never a throw.
 */
function parseCreate(raw: unknown): Result<CreateCrossWorkspaceLinkInput, FailureVariant> {
  if (typeof raw !== "object" || raw === null) return err(invalidInput("CREATE_INPUT_SHAPE"));
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["linkId"])) return err(invalidInput("CREATE_LINK_ID"));
  if (!isNonEmptyString(r["fromWorkspaceId"])) return err(invalidInput("CREATE_FROM_WORKSPACE"));
  if (!isNonEmptyString(r["toWorkspaceId"])) return err(invalidInput("CREATE_TO_WORKSPACE"));
  if (!isNonEmptyString(r["scopeProjectionType"])) return err(invalidInput("CREATE_SCOPE_TYPE"));
  const vis = r["scopeVisibilityLevel"];
  if (typeof vis !== "string" || !isVisibilityLevel(vis)) return err(invalidInput("CREATE_SCOPE_VISIBILITY"));
  // WHITELIST — pick ONLY the create fields; any other key (status/approvedAt/…) is discarded.
  return ok({
    linkId: r["linkId"],
    fromWorkspaceId: r["fromWorkspaceId"],
    toWorkspaceId: r["toWorkspaceId"],
    scopeProjectionType: r["scopeProjectionType"],
    scopeVisibilityLevel: vis,
  });
}

function parseLinkId(raw: unknown): Result<{ linkId: string }, FailureVariant> {
  if (typeof raw !== "object" || raw === null) return err(invalidInput("LINK_ID_SHAPE"));
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["linkId"])) return err(invalidInput("LINK_ID"));
  return ok({ linkId: r["linkId"] });
}

/** Map a `CreateCrossWorkspaceLinkError` → the §16 boundary taxonomy (redaction-safe — stable codes). */
function createErrorToFailure(e: CreateCrossWorkspaceLinkError): FailureVariant {
  switch (e.code) {
    case "workspace_unknown":
      return failure("validation_rejected", "a linked workspace is not registered", { cause: { code: "CWL_WORKSPACE_UNKNOWN" } });
    case "cross_workspace_link_self":
      return failure("validation_rejected", "a cross-workspace link cannot bind a workspace to itself", { cause: { code: "CWL_SELF" } });
    case "cross_workspace_link_invalid_scope":
      return failure("validation_rejected", "a cross-workspace link requires a bounded scope", { cause: { code: "CWL_INVALID_SCOPE" } });
    case "cross_workspace_link_immutable":
      return failure("validation_rejected", "cross-workspace link binding is immutable", { cause: { code: "CWL_IMMUTABLE" } });
    case "store_fault":
      return failure("degraded_unavailable", "cross-workspace link store unavailable", { retryable: true, cause: { code: "CWL_STORE_FAULT" } });
  }
}

/** Map a `CrossWorkspaceLinkTransitionError` (approve/revoke) → the §16 boundary taxonomy. */
function transitionErrorToFailure(e: CrossWorkspaceLinkTransitionError): FailureVariant {
  switch (e.code) {
    case "link_unknown":
      return failure("validation_rejected", "cross-workspace link not found", { cause: { code: "CWL_LINK_UNKNOWN" } });
    case "link_not_pending":
      return failure("validation_rejected", "only a pending cross-workspace link can be approved", { cause: { code: "CWL_NOT_PENDING" } });
    case "store_fault":
      return failure("degraded_unavailable", "cross-workspace link store unavailable", { retryable: true, cause: { code: "CWL_STORE_FAULT" } });
  }
}

/** Project a row → the UI-safe summary (all fields non-secret). */
function toUiSafe(row: CrossWorkspaceLinkRow): UiSafeCrossWorkspaceLink {
  return {
    linkId: row.linkId,
    fromWorkspaceId: row.fromWorkspaceId,
    toWorkspaceId: row.toWorkspaceId,
    scopeProjectionType: row.scopeProjectionType,
    scopeVisibilityLevel: row.scopeVisibilityLevel,
    status: row.status,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
    revokedAt: row.revokedAt,
  };
}

// ── Router factory ──────────────────────────────────────────────────────────

/**
 * Build the cross-workspace-link router the integrator mounts at `appRouter.crossWorkspaceLink`. Each
 * procedure is a tRPC `.mutation()` wrapped in the 8.2 `authedResolver`, returning a
 * `Result<T, FailureVariant>` — never throws. Owner-approval flow (safety rule 4): create mints a
 * PENDING link; approve/revoke drive the status; the READ gate that consults an approved link is a
 * separate composition (crossWorkspaceRead.ts), consumed by the coordination/global briefs (25.2/25.4).
 */
export function buildCrossWorkspaceLinkRouter(deps: CrossWorkspaceLinkDeps) {
  const { crossWorkspaceLink } = deps;
  return router({
    /** Create a cross-workspace link between two registered workspaces (lands PENDING). */
    create: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeCrossWorkspaceLink>(
        async (_ctx, input): Promise<Result<UiSafeCrossWorkspaceLink, FailureVariant>> => {
          const parsed = parseCreate(input);
          if (!parsed.ok) return err(parsed.error);
          const res = await crossWorkspaceLink.create(parsed.value);
          if (!res.ok) return err(createErrorToFailure(res.error));
          return ok(toUiSafe(res.value));
        },
      ),
    ),

    /** Approve a PENDING link (owner action) — opens the scoped cross-read path. */
    approve: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeCrossWorkspaceLink>(
        async (_ctx, input): Promise<Result<UiSafeCrossWorkspaceLink, FailureVariant>> => {
          const parsed = parseLinkId(input);
          if (!parsed.ok) return err(parsed.error);
          const res = await crossWorkspaceLink.approve(parsed.value);
          if (!res.ok) return err(transitionErrorToFailure(res.error));
          return ok(toUiSafe(res.value));
        },
      ),
    ),

    /** Revoke a link (owner action) — closes the cross-read path immediately. */
    revoke: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeCrossWorkspaceLink>(
        async (_ctx, input): Promise<Result<UiSafeCrossWorkspaceLink, FailureVariant>> => {
          const parsed = parseLinkId(input);
          if (!parsed.ok) return err(parsed.error);
          const res = await crossWorkspaceLink.revoke(parsed.value);
          if (!res.ok) return err(transitionErrorToFailure(res.error));
          return ok(toUiSafe(res.value));
        },
      ),
    ),
  });
}
