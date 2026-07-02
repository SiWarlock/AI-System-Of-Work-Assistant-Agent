// Task 8.4 — Command procedures: approval transitions + ingestion-triage
// disposition (exactly-once / idempotent). The command-router SEAM.
//
// This module is the composition surface for the two command handlers:
//   (a) `decideApproval` — a SINGLE idempotent transition over
//       pending -> approved|edited|rejected|deferred|expired (REQ-F-012, §9),
//       built OVER the exactly-once approval CAS (`approvalCommands.ts`). Mac +
//       Telegram parity: the SAME transition regardless of channel, and a
//       cross-channel double-apply collapses to EXACTLY ONE state change (the
//       second contender is an idempotent no-op — never a 2nd apply).
//   (b) `disposeTriage` — re-enter the ingestion pipeline REUSING the caller's
//       idempotencyKey (replay-safe, ING-4; `triageCommands.ts`).
//
// ONE-WRITER / TOOL-GATEWAY (§7/§8, safety 3). Every command DISPATCHES ONLY via
// the injected ports (`ApprovalCommandPort` + the dispatch fn + `TriagePort`) —
// the API NEVER writes an external system or Markdown directly. The real port
// binding (the @sow/db approval repo + the worker's Temporal / Tool-Gateway
// dispatch) is the INTEGRATOR step; unit tests inject fakes.
//
// Every procedure is a tRPC `.mutation()` (commands MUTATE — §13 read/write
// split) wrapped in the 8.2 `authedResolver` (the 8.1 auth gate + the §16 typed
// boundary): an unauthenticated caller gets the interceptor's typed `err` as
// DATA, and a handler NEVER throws across the boundary. Inputs are validated by a
// small PURE guard (the candidate-data gate at the transport edge — a malformed
// input is a typed `validation_rejected` err, never a throw); this module adds NO
// new dependency. This is the router the integrator mounts at `appRouter.command`
// (see `server.ts`'s `mountRouters` seam) — DO NOT wire it here.
import { publicProcedure, router, authedResolver } from "../router";
// Value primitives come straight from the frozen contracts barrel — `../router`
// re-exports only the tRPC seam + `ok`, not `err`/`failure`.
import {
  ok,
  err,
  failure,
  type Result,
  type FailureVariant,
} from "@sow/contracts";
import {
  decideApprovalCommand,
  APPROVAL_DECISIONS,
  type ApprovalCommandPort,
  type ApprovalDecision,
  type ApprovalDecisionResult,
  type DispatchApprovalFn,
  type NowFn,
} from "./approvalCommands";
import {
  disposeTriageCommand,
  type TriagePort,
  type TriageDisposition,
  type TriageDispositionResult,
} from "./triageCommands";
// `Channel` is BOTH a value (the frozen `["mac","telegram"]` const tuple, used at
// runtime to narrow the input) and a type (the union) — a single import binds both.
import { Channel } from "@sow/contracts";

// Re-export the port + handler types so the integrator (and the tests) import ONE
// module for the whole command surface.
export type {
  ApprovalCommandPort,
  ApprovalDecision,
  ApprovalDecisionResult,
  DispatchApprovalFn,
  NowFn,
  TriagePort,
  TriageDisposition,
  TriageDispositionResult,
};

// ── Injected dependencies ───────────────────────────────────────────────────

/**
 * Dependencies for {@link buildCommandRouter}. All effects are injected as ports
 * so the router is unit-testable with fakes and the real binding (Temporal /
 * Tool-Gateway / @sow/db approval repo) is the integrator step:
 *   - `approvals` — the exactly-once approval CAS store (wraps `ApprovalRepository`);
 *   - `dispatchApproval` — drives the downstream side effect of an APPLIED approval
 *      ONLY (a no-op contender never dispatches) — via Temporal / the Tool Gateway;
 *   - `triage` — re-enters the ingestion pipeline reusing the idempotencyKey;
 *   - `now` — an injected clock so `defer`'s snoozeUntil/expiresAt is deterministic.
 */
export interface CommandDeps {
  readonly approvals: ApprovalCommandPort;
  readonly dispatchApproval: DispatchApprovalFn;
  readonly triage: TriagePort;
  readonly now: NowFn;
}

// ── Input validation (candidate-data gate — PURE, no new dependency) ─────────

/** The validated shape of a `decideApproval` command input. */
interface DecideApprovalInput {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly channel: Channel;
}

/** The validated shape of a `disposeTriage` command input. */
interface DisposeTriageInput {
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly disposition: TriageDisposition;
}

/** A non-empty-string guard (rejects absent / non-string / whitespace-only). */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** A typed input-validation failure — redaction-safe (only a stable code). */
function invalidInput(code: string): FailureVariant {
  return failure("validation_rejected", "invalid command input", { cause: { code } });
}

/**
 * A PASSTHROUGH tRPC input parser: it hands the raw client argument to the
 * resolver UNCHANGED (typed as `unknown`). A parser-less `.mutation()` in tRPC
 * DISCARDS the client input, so an explicit parser is required to receive it —
 * but a THROWING parser would surface as a tRPC error, not our typed `Result`
 * boundary. Passing the raw value through and validating INSIDE the handler keeps
 * a malformed input a typed `err(validation_rejected)` as DATA (never a throw,
 * §16). Adds NO new dependency (no zod at the transport edge).
 */
const passthroughInput = (raw: unknown): unknown => raw;

/**
 * Validate a raw `decideApproval` input at the transport edge (the candidate-data
 * gate). Returns a typed `err(validation_rejected)` on any malformed field —
 * never a throw. `decision` and `channel` are narrowed against the frozen sets.
 */
function parseDecideApproval(raw: unknown): Result<DecideApprovalInput, FailureVariant> {
  if (typeof raw !== "object" || raw === null) return err(invalidInput("DECIDE_APPROVAL_INPUT_SHAPE"));
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["approvalId"])) return err(invalidInput("DECIDE_APPROVAL_ID"));
  const decision = r["decision"];
  if (
    typeof decision !== "string" ||
    !(APPROVAL_DECISIONS as readonly string[]).includes(decision)
  ) {
    return err(invalidInput("DECIDE_APPROVAL_DECISION"));
  }
  const channel = r["channel"];
  if (typeof channel !== "string" || !(Channel as readonly string[]).includes(channel)) {
    return err(invalidInput("DECIDE_APPROVAL_CHANNEL"));
  }
  return ok({
    approvalId: r["approvalId"],
    decision: decision as ApprovalDecision,
    channel: channel as Channel,
  });
}

/**
 * Validate a raw `disposeTriage` input at the transport edge. Returns a typed
 * `err(validation_rejected)` on any malformed field — never a throw. `disposition`
 * is an OPEN non-empty string (the upstream taxonomy is unspecified — arch_gap).
 */
function parseDisposeTriage(raw: unknown): Result<DisposeTriageInput, FailureVariant> {
  if (typeof raw !== "object" || raw === null) return err(invalidInput("DISPOSE_TRIAGE_INPUT_SHAPE"));
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["sourceId"])) return err(invalidInput("DISPOSE_TRIAGE_SOURCE_ID"));
  if (!isNonEmptyString(r["idempotencyKey"])) return err(invalidInput("DISPOSE_TRIAGE_IDEMPOTENCY_KEY"));
  if (!isNonEmptyString(r["disposition"])) return err(invalidInput("DISPOSE_TRIAGE_DISPOSITION"));
  return ok({
    sourceId: r["sourceId"],
    idempotencyKey: r["idempotencyKey"],
    disposition: r["disposition"],
  });
}

// ── Router factory ──────────────────────────────────────────────────────────

/**
 * Build the command router the integrator mounts at `appRouter.command`. Each
 * procedure is a tRPC `.mutation()` wrapped in the 8.2 `authedResolver` (auth gate
 * + §16 typed boundary) and returns a `Result<T, FailureVariant>` — never throws.
 * Every side effect is routed through an injected port (§7/§8 one-writer).
 */
export function buildCommandRouter(deps: CommandDeps) {
  const { approvals, dispatchApproval, triage, now } = deps;
  return router({
    /**
     * Approval decision — a SINGLE idempotent transition (REQ-F-012). Approve /
     * edit / reject / defer map to the target status; the CAS applies exactly once
     * (a cross-channel double-apply / replay is an idempotent no-op). Only a
     * genuine transition drives the dispatch port. approve/reject on an
     * already-terminal (expired) item is a typed err with NO state change.
     */
    decideApproval: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, ApprovalDecisionResult>(
        async (_ctx, input): Promise<Result<ApprovalDecisionResult, FailureVariant>> => {
          const parsed = parseDecideApproval(input);
          if (!parsed.ok) return err(parsed.error);
          return decideApprovalCommand({ approvals, dispatchApproval, now }, parsed.value);
        },
      ),
    ),

    /**
     * Ingestion-triage disposition — re-enter the ingestion pipeline REUSING the
     * caller's idempotencyKey (replay-safe, ING-4). The command performs NO direct
     * write; the pipeline (via the injected `TriagePort`) is the only writer.
     */
    disposeTriage: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, TriageDispositionResult>(
        async (_ctx, input): Promise<Result<TriageDispositionResult, FailureVariant>> => {
          const parsed = parseDisposeTriage(input);
          if (!parsed.ok) return err(parsed.error);
          return disposeTriageCommand({ triage }, parsed.value);
        },
      ),
    ),
  });
}
