// Task 8.4 (b) — the ingestion-triage disposition command: re-enter the
// ingestion pipeline reusing the SAME idempotencyKey (replay-safe), resolving the
// ING-4 dead-end (workflow 5).
//
// REPLAY-SAFE, ONE-WRITER. A triage disposition (accept/reject/reroute/…) on an
// item in the ingestion inbox re-enters the ingestion pipeline. It MUST reuse the
// caller-supplied `idempotencyKey` verbatim so the re-entry is deduped by the
// pipeline (a replay / a double-click / a cross-channel double-apply lands the
// SAME key → one effect). The command DISPATCHES ONLY via the injected Temporal
// dispatch port (`TriagePort.reenterIngestion`); it NEVER writes an external
// system or Markdown directly (§7/§8, safety 3).
//
// §16: never throws — every path returns `Result<T, FailureVariant>`. PURE-ish:
// no I/O of its own; the re-entry effect goes through the injected port.
import {
  ok,
  err,
  isErr,
  failure,
  type Result,
  type FailureVariant,
} from "@sow/contracts";

/**
 * The disposition a human assigns to an ingestion-inbox item during triage.
 * OPEN string set here (the upstream disposition taxonomy is unspecified — an
 * arch_gap on SourceEnvelope.sensitivity/routingHints), NOT a closed enum, so the
 * command layer stays forward-compatible; the pipeline validates the concrete set.
 */
export type TriageDisposition = string;

/**
 * The disposition value (within the open {@link TriageDisposition} set) that
 * RE-ROUTES a parked source to a human-chosen workspace/project. It is the ONLY
 * disposition that carries — and REQUIRES — an explicit {@link RerouteTarget}
 * (REQ-F-017 no-inference). Every other disposition (accept/reject/…) forbids one.
 */
export const REROUTE_DISPOSITION = "reroute";

/**
 * The human's EXPLICIT routing target for a `reroute` disposition (15.8 / G60). It
 * is the ONLY way a parked "which workspace/project?" item escapes the Ingestion
 * Inbox with a workspace — an AUTHORIZED human decision, never an inference
 * (REQ-F-017 / WS-2). Both fields are registry-validated before re-entry (WS-8,
 * never a raw bind — see {@link RerouteTargetValidatorPort}).
 */
export interface RerouteTarget {
  /** The target workspace — MUST be a registered workspace (WS-8). */
  readonly workspaceId: string;
  /** Optional target project — if present, MUST resolve in the 14.6 registry UNDER that workspace. */
  readonly projectId?: string;
}

/** Closed, enumerable reroute-target validation failure set (§16 — never thrown). */
export type RerouteTargetValidationErrorCode =
  // The target workspace is not a registered workspace (WS-8 — never a raw bind).
  | "reroute_target_unknown"
  // A target projectId is not registered in the 14.6 Project registry UNDER that workspace.
  | "reroute_target_project_unknown";

export interface RerouteTargetValidationError {
  readonly code: RerouteTargetValidationErrorCode;
  readonly message: string;
}

/**
 * Validate a {@link RerouteTarget} against the REAL 14.6 registry — the WS-8 gate
 * on the human's routing override. The production binding
 * (`createRegistryValidatedRerouteTarget`) checks the workspace is 14.1-registered +
 * (if a projectId is given) that it resolves in the 14.6 Project registry UNDER that
 * workspace; a fake implements it for command-unit tests. Fail-closed / never throws
 * (§16): a registry fault folds to a typed rejection, NEVER a raw bind on an
 * unverifiable target.
 */
export interface RerouteTargetValidatorPort {
  validate(
    target: RerouteTarget,
  ): Promise<Result<void, RerouteTargetValidationError>>;
}

/**
 * The injected Temporal / Tool-Gateway dispatch port for re-entering ingestion.
 * The command layer's ONLY triage effect. The real binding starts / signals the
 * ingestion workflow through the worker's Temporal client (reusing the
 * idempotency key as the workflow's dedupe id); a fake implements it for tests.
 * NOTE: the command NEVER writes Markdown or an external system directly — the
 * pipeline (KnowledgeWriter / Tool Gateway) is the only writer (§7/§8).
 */
export interface TriagePort {
  /**
   * Re-enter the ingestion pipeline for `sourceId` under `disposition`, REUSING
   * `idempotencyKey` verbatim (replay-safe, ING-4). Returns the reused key so the
   * caller/renderer can correlate; never throws (§16).
   */
  reenterIngestion(input: {
    sourceId: string;
    idempotencyKey: string;
    disposition: TriageDisposition;
    /**
     * The registry-VALIDATED reroute target (15.8) — present ONLY for a `reroute`
     * disposition, and only AFTER `disposeTriageCommand` has validated it. The
     * downstream re-entry re-scopes the parked source to this workspace/project.
     */
    target?: RerouteTarget;
  }): Promise<Result<{ idempotencyKey: string }, FailureVariant>>;
}

/** The result surface of a triage-disposition command. */
export interface TriageDispositionResult {
  /** The idempotency key reused for the re-entry (the ING-4 replay-safety proof). */
  readonly idempotencyKey: string;
}

/** A stable, redaction-safe reroute-target rejection (only a cause code crosses). */
function rerouteReject(code: string, message: string): FailureVariant {
  return failure("validation_rejected", message, { cause: { code } });
}

/**
 * Execute an ingestion-triage disposition (ING-4, workflow 5). Re-enters the
 * ingestion pipeline through the injected `TriagePort`, REUSING the caller's
 * `idempotencyKey` verbatim so a replay / double-apply lands the SAME key → one
 * effect. The command performs NO direct write — the pipeline is the only writer.
 *
 * 15.8 (G60): a `reroute` disposition RESOLVES a parked "which workspace/project?"
 * item via an EXPLICIT, registry-validated {@link RerouteTarget}. REQ-F-017
 * no-inference is load-bearing: a reroute with NO target (or a target missing a
 * workspaceId) FAILS CLOSED (`reroute_target_required`) — NEVER a guessed workspace,
 * and the validator is never consulted / nothing is dispatched. The target is then
 * registry-validated (WS-8, never a raw bind) BEFORE re-entry; a validator rejection
 * is forwarded verbatim and nothing is dispatched. A target on a NON-reroute
 * disposition is rejected (`reroute_target_forbidden`) rather than silently ignored.
 */
export async function disposeTriageCommand(
  deps: { triage: TriagePort; rerouteTargets: RerouteTargetValidatorPort },
  input: {
    sourceId: string;
    idempotencyKey: string;
    disposition: TriageDisposition;
    target?: RerouteTarget;
  },
): Promise<Result<TriageDispositionResult, FailureVariant>> {
  const isReroute = input.disposition === REROUTE_DISPOSITION;
  if (isReroute) {
    // REQ-F-017: a reroute REQUIRES an explicit target with a non-empty workspaceId —
    // a missing/blank workspace is a no-inference violation, NEVER a default workspace.
    const workspaceId = input.target?.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return err(rerouteReject("reroute_target_required", "reroute requires an explicit routing target"));
    }
    // WS-8: the target is validated against the REAL 14.6 registry (never a raw bind).
    // A validator rejection (unknown workspace / project) is forwarded verbatim; the
    // source is NOT re-entered on an unverified target.
    const validated = await deps.rerouteTargets.validate(input.target as RerouteTarget);
    if (isErr(validated)) {
      return err(rerouteReject(validated.error.code, validated.error.message));
    }
  } else if (input.target !== undefined) {
    // A routing target is meaningful ONLY for a reroute — reject (fail loud) rather
    // than silently ignore a target on accept/reject (closes the smuggled-target hole).
    return err(rerouteReject("reroute_target_forbidden", "a routing target is only valid for a reroute disposition"));
  }

  const r = await deps.triage.reenterIngestion({
    sourceId: input.sourceId,
    // Verbatim reuse (never re-minted): the caller's reroute-scoped re-entry key is
    // distinct from the original `src:ws:hash` ingestion key, so a genuine reroute
    // re-processes under the new target while a double-click of the SAME reroute
    // dedupes downstream (replay-safe, ING-4 / inv-D).
    idempotencyKey: input.idempotencyKey,
    disposition: input.disposition,
    // Carry the VALIDATED target only for a reroute (additive-optional; accept/reject
    // carry none, so existing callers are byte-equivalent).
    ...(isReroute && input.target !== undefined ? { target: input.target } : {}),
  });
  if (isErr(r)) {
    return err(r.error);
  }
  return ok({ idempotencyKey: r.value.idempotencyKey });
}
