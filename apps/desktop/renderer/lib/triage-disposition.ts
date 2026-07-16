import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";

// §9.7 triage-resolution disposition (renderer side). The renderer is UNTRUSTED: it only
// REQUESTS a disposition — the worker (`command.disposeTriage`) re-enters the ingestion
// pipeline REUSING the caller's `idempotencyKey` verbatim (the pipeline, via TriagePort, is
// the ONLY writer; ING-4). `UiSafeIngestionItem` carries NO idempotencyKey (only `sourceId`),
// so this wrapper MINTS one deterministically per (sourceId, disposition) — a double-click /
// retry / cross-channel replay lands the SAME key → the pipeline dedupes to one effect. It
// folds a typed err OR any transport error to `{ ok: false }` (fail closed — a failed
// disposition surfaces nothing; §16 never-throw at the UI boundary), mirroring
// `approval-decision.ts`.

/**
 * The dispositions the inbox offers per card. Defined locally (a UI-level concept — the
 * action buttons); the worker's `disposeTriage` takes an OPEN string + the pipeline owns the
 * real taxonomy, so this union is a convenience, never the authority. `reroute` (15.8) is the
 * human routing-resolution — it carries an explicit registry-picked `target`.
 */
export type TriageDisposition = "accept" | "reject" | "reroute";

/**
 * The registry-picked reroute target (15.8 — brief 105 shared contract). REQUIRED for a
 * `reroute` disposition, FORBIDDEN on any other. Both ids are chosen from the 14.6 registry
 * read model on the renderer — never typed/invented (REQ-F-017 no-inference at the edge).
 */
export interface RerouteTarget {
  readonly workspaceId: string;
  readonly projectId?: string;
}

/**
 * The EXACT input `command.disposeTriage` receives — the pinned shared command contract (brief
 * 105). `target` is present ONLY on a reroute; accept/reject stay byte-equivalent (no target key).
 */
export interface TriageMutationInput {
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly disposition: TriageDisposition;
  readonly target?: RerouteTarget;
}

/** The pure payload-builder result: the pinned command, or a typed reject the caller fails closed on. */
export type TriageCommandBuild =
  | { readonly ok: true; readonly input: TriageMutationInput }
  | { readonly ok: false; readonly reason: "reroute_target_required" };

export type DispositionResult =
  | { readonly ok: true; readonly idempotencyKey: string }
  | { readonly ok: false };

/**
 * Mint the STABLE idempotency key for a (sourceId, disposition). Deterministic — a double-click
 * / retry reuses the SAME key so the worker's verbatim-key re-entry dedupes to one effect (ING-4).
 * NOT a fresh-per-click value.
 */
export function triageIdempotencyKey(sourceId: string, disposition: TriageDisposition): string {
  return `${sourceId}:${disposition}`;
}

/**
 * The DETERMINISTIC triage payload builder (15.8) — the single edge where a reroute's no-inference
 * guard lives. A `reroute` REQUIRES an explicit, non-empty `target.workspaceId` (REQ-F-017: the
 * renderer never invents a target) — else a typed `reroute_target_required` reject, no command
 * built. `projectId` is attached only when actually chosen (no `projectId: undefined` key). A
 * non-reroute disposition NEVER attaches `target` (the contract forbids it) — byte-equivalent to
 * today's accept/reject payload.
 *
 * The reroute idempotency key ENCODES the full target — `${sourceId}:reroute:${workspaceId}` (plus
 * `:${projectId}` when a project is chosen). "Reroute to A" and "reroute to B" are therefore DISTINCT
 * operations (both drive) while a genuine double-click of the SAME target still dedupes to one effect
 * (replay-safe, ING-4). This closes the WS-8 silent-misroute edge — a failed reroute RETAINS the item,
 * so a re-submit to a DIFFERENT workspace must not AlreadyStarted-dedupe onto the earlier (wrong)
 * target — independent of how the worker's `reenterIngestion` dedupes. Pure + total: no throw, no I/O.
 */
export function buildTriageMutationInput(
  sourceId: string,
  disposition: TriageDisposition,
  target?: RerouteTarget,
): TriageCommandBuild {
  if (disposition === "reroute") {
    if (target === undefined || target.workspaceId.length === 0) {
      return { ok: false, reason: "reroute_target_required" };
    }
    const projectId =
      target.projectId !== undefined && target.projectId.length > 0 ? target.projectId : undefined;
    const resolved: RerouteTarget =
      projectId !== undefined ? { workspaceId: target.workspaceId, projectId } : { workspaceId: target.workspaceId };
    const base = `${triageIdempotencyKey(sourceId, disposition)}:${target.workspaceId}`;
    const idempotencyKey = projectId !== undefined ? `${base}:${projectId}` : base;
    return { ok: true, input: { sourceId, idempotencyKey, disposition, target: resolved } };
  }
  const idempotencyKey = triageIdempotencyKey(sourceId, disposition);
  return { ok: true, input: { sourceId, idempotencyKey, disposition } };
}

/** Build the triage-disposition caller over a live tRPC client. */
export function createTriageDisposition(
  client: CreateTRPCClient<AppRouter>,
): (sourceId: string, disposition: TriageDisposition, target?: RerouteTarget) => Promise<DispositionResult> {
  return async (
    sourceId: string,
    disposition: TriageDisposition,
    target?: RerouteTarget,
  ): Promise<DispositionResult> => {
    // REQ-F-017 at the edge: a target-less reroute is refused HERE — it never reaches the wire.
    const built = buildTriageMutationInput(sourceId, disposition, target);
    if (!built.ok) return { ok: false };
    try {
      const res = await client.command.disposeTriage.mutate(built.input);
      // Accept only a well-formed ok result carrying a non-empty string idempotencyKey. Defense-in-depth
      // mirroring approval-decision's schema re-validation: a malformed/leaky result from a future
      // server-projector regression folds to `{ ok: false }`, never a partial drain.
      if (
        res.ok === true &&
        res.value != null &&
        typeof res.value === "object" &&
        typeof res.value.idempotencyKey === "string" &&
        res.value.idempotencyKey.length > 0
      ) {
        return { ok: true, idempotencyKey: res.value.idempotencyKey };
      }
      // A typed err (degraded / not-found) or a malformed result → fail closed.
      return { ok: false };
    } catch {
      // Transport failure → fail closed (never surface a partial / stale disposition).
      return { ok: false };
    }
  };
}
