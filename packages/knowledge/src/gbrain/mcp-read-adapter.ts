// GBrain read/query-only MCP adapter (§6, task 4.7; REQ-F-019 / KN-2).
//
// The typed proof that NO write/admin token or generative capability reaches the
// GBrain runtime. The adapter connects to the single-owner per-workspace gbrain
// process over the read-only HTTP serving transport carrying a `GbrainReadGrant`
// (scope:['read'], generativeCycleEnabled:false, workspace_only) — NEVER stdio
// `gbrain serve` (which has no scope gate and is fully write-capable in gbrain
// 0.35.1.0). It exposes EXACTLY the V1 read surface — search, typed graph,
// timelines, schema-read, health, and CONTAINED synthesis — and structurally has
// no put/write/mutate/extract/dream method at all (safety rule 1: one writer /
// no hidden brain).
//
// Two enforcement layers, both fail-closed and non-throwing (§16):
//   1. Construction: the grant is re-verified to be read-only (http transport,
//      ['read'] scope, generativeCycleEnabled=false, workspace_only federation,
//      and allowedOps ⊆ the read-op enum) — defense-in-depth over the contract's
//      literal schema, returning a TYPED reason so a smuggled write/admin grant
//      is refused at the boundary, not trusted.
//   2. Per-call op gating: every op must be in the grant's `allowedOps`; the
//      ContainedSynthesisGate additionally refuses to run `contained_synthesis`
//      unless caller-supplied, already-gated context is passed — synthesis runs
//      ONLY over ServingGate-filtered / Markdown-rehydrated / signature-verified
//      context, NEVER a raw PGLite / embeddings free-text generative read.
//
// Single-owner (§13): the adapter binds ONE read grant + ONE injected transport
// to ONE brain; it never touches the PGLite file directly (REQ-D-005) — PGLite
// ownership is the worker/sidecar's, out of this unit's scope.
import { ok, err } from "@sow/contracts";
import { GbrainAllowedOp as GBRAIN_ALLOWED_OPS } from "@sow/contracts";
import type { Result, GbrainReadGrant, WorkspaceId, BrainId } from "@sow/contracts";
export type { GbrainAllowedOp } from "@sow/contracts";
import type { GbrainAllowedOp } from "@sow/contracts";

/** The exact V1 read-op surface (REQ-F-019). Mirrors the frozen `GbrainAllowedOp`
 *  enum — which contains ONLY read ops; no store-wide `put`/`think`/mutate op can
 *  be encoded. Used to reject a grant carrying an op outside this surface. */
export const GBRAIN_READ_OPS: readonly GbrainAllowedOp[] = GBRAIN_ALLOWED_OPS;

/**
 * The injected read-only runtime transport (the MCP client bound to the single
 * gbrain owner). Tests supply a fake — NO real process/network in unit tests.
 * There is deliberately exactly one, read-only entry point: `invoke`. It carries
 * no write op because {@link GbrainAllowedOp} has none.
 */
export interface GbrainReadClient {
  invoke(
    op: GbrainAllowedOp,
    payload: unknown,
    context?: readonly unknown[],
  ): Promise<unknown>;
}

/** Grant refused at construction — a write/admin/generative/cross-brain grant is
 *  never bound to the runtime (fail-closed). */
export interface GbrainReadAdapterInitFailure {
  readonly code: "grant_not_read_only";
  readonly reason:
    | "transport"
    | "scope"
    | "generative_cycle"
    | "federation"
    | "allowed_op_out_of_read_surface";
  readonly detail: string;
}

/** Per-call read failures (§16, enumerable, never thrown across the boundary). */
export type GbrainReadError =
  | { readonly code: "op_not_allowed"; readonly op: GbrainAllowedOp; readonly allowedOps: readonly GbrainAllowedOp[] }
  | { readonly code: "contained_synthesis_requires_context" }
  | { readonly code: "transport_fault"; readonly op: GbrainAllowedOp; readonly cause: unknown };

export type GbrainReadResult = Result<unknown, GbrainReadError>;

/**
 * The read/query-only surface. Note the ABSENCE of any write/mutate method —
 * that absence is the structural half of safety rule 1. `containedSynthesis`
 * requires the caller's already-gated context (the ContainedSynthesisGate).
 */
export interface GbrainReadAdapter {
  readonly workspaceId: WorkspaceId;
  readonly brainId: BrainId;
  readonly pinnedSha: string;
  readonly allowedOps: readonly GbrainAllowedOp[];
  search(payload: unknown): Promise<GbrainReadResult>;
  graph(payload: unknown): Promise<GbrainReadResult>;
  timeline(payload: unknown): Promise<GbrainReadResult>;
  schemaRead(payload: unknown): Promise<GbrainReadResult>;
  health(payload?: unknown): Promise<GbrainReadResult>;
  containedSynthesis(payload: unknown, context: readonly unknown[]): Promise<GbrainReadResult>;
}

function isReadOnlyGrant(
  grant: GbrainReadGrant,
): Result<void, GbrainReadAdapterInitFailure> {
  const fail = (
    reason: GbrainReadAdapterInitFailure["reason"],
    detail: string,
  ): Result<void, GbrainReadAdapterInitFailure> =>
    err({ code: "grant_not_read_only", reason, detail });

  // Only the HTTP serving transport is granted — never stdio `gbrain serve`.
  if (grant.transport !== "http") {
    return fail("transport", `transport must be 'http', got '${String(grant.transport)}'`);
  }
  // scope is exactly ['read'] — non-empty, all-'read'; no write/admin scope.
  if (
    !Array.isArray(grant.scope) ||
    grant.scope.length === 0 ||
    grant.scope.some((s) => s !== "read")
  ) {
    return fail("scope", `scope must be ['read'], got ${JSON.stringify(grant.scope)}`);
  }
  // The generative cycle never runs against the runtime.
  if (grant.generativeCycleEnabled !== false) {
    return fail("generative_cycle", "generativeCycleEnabled must be false");
  }
  // No cross-brain federation (WS-8).
  if (grant.federationScope !== "workspace_only") {
    return fail("federation", `federationScope must be 'workspace_only', got '${String(grant.federationScope)}'`);
  }
  // Every allowed op must be in the read-op surface — any mutating/admin op is
  // rejected at the gate (defense-in-depth over the frozen enum).
  for (const op of grant.allowedOps) {
    if (!GBRAIN_READ_OPS.includes(op)) {
      return fail(
        "allowed_op_out_of_read_surface",
        `allowedOps carries '${String(op)}' which is outside the read surface`,
      );
    }
  }
  return ok(undefined);
}

/**
 * Bind a read-only grant + a single injected transport into a read/query-only
 * adapter, or refuse the grant with a typed reason. Never throws (§16).
 */
export function createGbrainReadAdapter(
  grant: GbrainReadGrant,
  client: GbrainReadClient,
): Result<GbrainReadAdapter, GbrainReadAdapterInitFailure> {
  const verified = isReadOnlyGrant(grant);
  if (!verified.ok) {
    return verified;
  }

  const allowed = new Set<GbrainAllowedOp>(grant.allowedOps);

  async function call(
    op: GbrainAllowedOp,
    payload: unknown,
    context?: readonly unknown[],
  ): Promise<GbrainReadResult> {
    if (!allowed.has(op)) {
      return err({ code: "op_not_allowed", op, allowedOps: grant.allowedOps });
    }
    try {
      return ok(await client.invoke(op, payload, context));
    } catch (cause) {
      // A transport/network fault is a typed infra variant — routable to System
      // Health, never a thrown escape across the subsystem boundary.
      return err({ code: "transport_fault", op, cause });
    }
  }

  const adapter: GbrainReadAdapter = {
    workspaceId: grant.workspaceId,
    brainId: grant.brainId,
    pinnedSha: grant.pinnedSha,
    allowedOps: grant.allowedOps,
    search: (payload) => call("search", payload),
    graph: (payload) => call("graph", payload),
    timeline: (payload) => call("timeline", payload),
    schemaRead: (payload) => call("schema_read", payload),
    health: (payload) => call("health", payload),
    containedSynthesis: (payload, context) => {
      // ContainedSynthesisGate: synthesis runs ONLY over passed-in, already
      // ServingGate-filtered + Markdown-rehydrated + signature-verified context.
      // No context ⇒ refuse — never fall back to a raw-store generative read.
      if (!Array.isArray(context) || context.length === 0) {
        return Promise.resolve(err({ code: "contained_synthesis_requires_context" }));
      }
      return call("contained_synthesis", payload, context);
    },
  };
  return ok(adapter);
}
