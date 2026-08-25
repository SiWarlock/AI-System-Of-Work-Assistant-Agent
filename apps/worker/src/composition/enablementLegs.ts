// Write-through enablement — worker COMPOSITION for task 11.3b. Gives the pure
// `decideWriteThroughEnablement` flip-precondition gate (packages/knowledge,
// decide-enablement.ts) a REAL, non-test production caller by composing the
// `packages/knowledge` leg producers over injected readers and surfacing the
// resulting refusals through the structured logger — the observable surface the
// brief requires ("so the REFUSAL is observable").
//
// ⛔ NOTHING ARMS: no code path in this module ever sets `writeThroughEnabled`.
// This module ONLY evaluates + observes the gate; the flip itself stays a
// separate, owner-gated, HITL crossing this slice does not build.
//
// TODAY'S HONEST STATE: the REAL producers for conformance/reindex/embedding-key/
// stray-writer (each a Phase-11.3b "bucket B" data source — a live conformance
// suite run, a reindex-completion tracker, a Keychain presence probe, a process
// scan) do not exist yet anywhere in this codebase; boot.ts therefore calls this
// with NO readers/pin/report supplied — every leg reads as unreadable, so the
// gate refuses ALL SIX legs, EACH WITH ITS OWN DISTINCT REASON, every boot. That
// refusal reaching the log IS the deliverable (making the gate reachable) — wiring
// the real signal sources is a separate, later task.
import type { GbrainPin, ParityReport } from "@sow/contracts";
import { decideWriteThroughEnablement, type WriteThroughEnablementDecision } from "@sow/knowledge";
// leg-producers.ts is NOT (yet) re-exported from the @sow/knowledge package barrel — imported via
// the `./*` subpath export instead (packages/knowledge/src/index.ts is out of this package's territory).
import { produceEnablementLegs, type EnablementLegReaders } from "@sow/knowledge/gbrain/enablement/leg-producers";

/** Everything `evaluateWriteThroughEnablement` needs — every field optional (fail-closed-on-omission). */
export interface EnablementLegsInputs {
  readonly readers?: EnablementLegReaders;
  /** The `pin`/`parityReport` legs are NOT boolean producers — the gate reads these objects directly. */
  readonly pin?: GbrainPin;
  readonly parityReport?: ParityReport;
}

/**
 * Compose the four leg producers + the two direct-object legs into one
 * `decideWriteThroughEnablement` call. PURE composition (no I/O of its own — the
 * producers already own their own fail-closed reader invocation); never throws.
 */
export async function evaluateWriteThroughEnablement(
  inputs: EnablementLegsInputs = {},
): Promise<WriteThroughEnablementDecision> {
  const produced = await produceEnablementLegs(inputs.readers ?? {});
  return decideWriteThroughEnablement({
    ...(inputs.pin !== undefined ? { pin: inputs.pin } : {}),
    ...(inputs.parityReport !== undefined ? { parityReport: inputs.parityReport } : {}),
    ...produced,
  });
}

/** The minimal logger surface this module needs (structurally satisfied by the real `Logger`). */
export interface EnablementDecisionLogger {
  info(event: string, meta?: { readonly fields?: Record<string, unknown> }): void;
}

/**
 * Surface the decision through the structured logger — the OBSERVABLE surface a
 * boot/health caller (or a test) can assert against. `fields` carries ONLY the
 * closed six-member leg-name enum + the boolean verdict (rule 7 — no raw
 * content, no secret value, no message text beyond the fixed reason strings the
 * gate itself already emits as a closed, non-content taxonomy).
 */
export function surfaceEnablementDecision(
  decision: WriteThroughEnablementDecision,
  logger: EnablementDecisionLogger,
): void {
  logger.info("gbrain.write_through_enablement.evaluated", {
    fields: {
      enabled: decision.enabled,
      refusedLegs: decision.refusals.map((r) => r.leg),
    },
  });
}
