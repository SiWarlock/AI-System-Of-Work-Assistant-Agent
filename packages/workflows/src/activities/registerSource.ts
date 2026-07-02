// @sow/workflows — slice 7.7 ACTIVITY: register the inbound SourceEnvelope BEFORE
// any extraction (Flow 4 / REQ-F-010 — register-then-dedupe).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY use the real
// @sow/integrations `registerSource` (the §8 pre-extraction gate: ajv structural +
// Zod `.strict()` + the contentHash dedupe probe). It takes `registerSource` + its
// deps INJECTED so it is Vitest-unit-testable with a fake and never touches a real
// store in the module. It implements {@link RegisterSourcePort}.
//
// SAFETY:
//   • REGISTER-BEFORE-DURABLE (Flow 4): the source is registered as a SourceEnvelope
//     BEFORE the driver runs routing/extraction — nothing durable happens first.
//   • DEDUPE (REQ-F-010): a source whose contentHash is already known is a NO-OP
//     `dedupe_hit` (the driver ends without reprocessing) — never a duplicate source.
//   • NO INFERENCE (REQ-F-017): the register step NEVER invents a missing field — a
//     malformed candidate is a typed rejection the driver folds to failed_terminal.
//
// §16: returns a typed Result — never throws across the activity boundary. A
// `registerSource` MALFORMED rejection folds onto `malformed_source`; the dedupe-hit
// and registered outcomes carry through the {@link RegisterOutcome} union.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  RegisterSourceInput,
  RegisterSourceDeps,
  RegisterSourceResult,
} from "@sow/integrations";
import type {
  RegisterSourcePort,
  RegisterOutcome,
  RegisterError,
  SourceIngestionContext,
} from "../ports/sourceIngestion";

/** The §8 source-register entry (injected — the real @sow/integrations `registerSource`). */
export type RegisterSourceFn = (
  input: RegisterSourceInput,
  deps: RegisterSourceDeps,
) => Promise<RegisterSourceResult>;

/**
 * Injected deps for the register activity: the `registerSource` fn + its dep bundle
 * (the Flow-4 dedupe probe). The activity maps the driver's {@link
 * SourceIngestionContext} source onto the register input VERBATIM (no inference).
 */
export interface RegisterSourceActivityDeps {
  readonly registerSource: RegisterSourceFn;
  readonly deps: RegisterSourceDeps;
}

/**
 * Build a {@link RegisterSourcePort} over the injected `registerSource` (Flow 4). It
 * maps the context's source to the register input, runs the gate + dedupe, and folds
 * the result onto the {@link RegisterOutcome} union: `registered` carries the
 * validated envelope; `dedupe_hit` carries the offending hash (a driver no-op); a
 * MALFORMED rejection is a typed {@link RegisterError}. Never throws.
 */
export function createRegisterSourceActivity(
  deps: RegisterSourceActivityDeps,
): RegisterSourcePort {
  return {
    async register(
      ctx: SourceIngestionContext,
    ): Promise<Result<RegisterOutcome, RegisterError>> {
      const src = ctx.source;
      const input: RegisterSourceInput = {
        // Mapped VERBATIM — no inference, no defaulting (REQ-F-017). A malformed
        // field reaches the gate as-is and is rejected there.
        sourceId: String(src.sourceId),
        workspaceId: String(src.workspaceId),
        origin: src.origin,
        contentHash: src.contentHash,
        type: src.type,
        sensitivity: src.sensitivity,
        routingHints: src.routingHints,
      };
      const result = await deps.registerSource(input, deps.deps);
      switch (result.outcome) {
        case "registered":
          return ok({ outcome: "registered", envelope: result.envelope });
        case "dedupe_hit":
          return ok({ outcome: "dedupe_hit", contentHash: result.contentHash });
        case "rejected":
        default:
          return err({
            code: "malformed_source",
            message: `source registration rejected: ${result.message}`,
          });
      }
    },
  };
}
