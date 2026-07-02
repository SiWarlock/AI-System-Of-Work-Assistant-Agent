// 10.4 — in-flight RUN RECOVERY on (re)start (LIFE-3, §6, §8, safety rule 3).
//
// When the worker (re)starts after a crash it must recover any in-flight run
// WITHOUT duplicating a side effect that had already committed, and WITHOUT
// silently dropping a run it cannot recover. This module is the worker-side
// recovery driver:
//
//   1. It replans the re-entered run via the PURE {@link planResume} (LIFE-3): a
//      committed step is SKIPPED (never re-run); an uncommitted step is RE-DRIVEN;
//      a TORN COMMIT (ledger says committed but carries no receipt, or a mutating
//      re-drive step with no idempotency key) is UNRECOVERABLE — planResume refuses
//      to resume and hands back an OPEN health item.
//   2. For each RE-DRIVE `external_write` step it re-drives the side effect through
//      the §8 external-write ENVELOPE REUSE ({@link reuseExternalWriteOnResume}),
//      reusing the SAME envelope (idempotencyKey + canonicalObjectKey + payloadHash).
//      The gateway's stored-receipt replay gate + pre-write existence check
//      guarantee ZERO duplicate external write: a receipt already recorded ⇒ the
//      gateway returns `reused` and adapter.create is NEVER called again (safety
//      rule 3). Recovery is therefore idempotent + re-drivable across REPEATED
//      crashes (create is called at most once, ever, per envelope).
//   3. A FAILURE to recover — an unrecoverable plan, or a re-drive that FAILED
//      CLOSED (a `held` write: unreachable existence probe / in-progress
//      reservation) — surfaces a typed `worker_down` HealthItem through the injected
//      {@link HealthSurface} (createHealthSurface) rather than dropping the run. The
//      run stays operator-visible; no partial uncommitted side effect is left behind
//      (a held write issues NO create). A held EARLIER external_write step does NOT
//      strand INDEPENDENT later external_write steps: per §6/resume.ts the plan order
//      among external writes is by KIND only and their relative position is not
//      load-bearing (each reuses its OWN §8 envelope + receipt, no inter-write
//      dependency), so every re-drivable step is still driven THIS pass; the run is
//      reported unrecovered only because a held step remains. (A TORN COMMIT is the
//      strict-ordering case — but planResume catches it FIRST and returns
//      'unrecoverable' before this loop, so a torn commit is never re-driven here.)
//
// Effects are INJECTED (a Clock, the HealthSurface, and the envelope-reuse gateway
// deps) so this is Vitest-unit-testable with fakes and never touches a real network.
// Never throws across the boundary (§16): a typed Result / a recovered-flag outcome.
//
// SCOPE NOTE. This drives the RESUME + envelope-reuse decision on the worker side;
// the actual @temporalio workflow re-entry (Worker.create/run replaying the durable
// history) is the live gated path (temporal/worker.ts, SOW_TEMPORAL). The pure
// recovery decision + the no-dup-write proof are the testable heart here.

import { ok, err, auditId } from "@sow/contracts";
import type { AuditId, HealthItem, Result } from "@sow/contracts";
import {
  planResume,
  type ResumeInput,
  type EnvelopeReuseDeps,
} from "@sow/workflows";
import type { Clock } from "@sow/workflows/ports/operational";
import { reuseExternalWriteOnResume } from "@sow/workflows";
import type { ExternalWriteEnvelope, ProposedAction } from "@sow/contracts";
import type { HealthSurface, HealthSurfaceError } from "../health/surface";

/**
 * One pending external side effect the run may need to re-drive on recovery. Keyed
 * by `stepId` (the resume-ledger join key), it carries the SAME
 * {@link ExternalWriteEnvelope} + {@link ProposedAction} the run built the first
 * time — reusing them is what makes the replay gate recognize the write and skip a
 * duplicate create (safety rule 3).
 */
export interface RecoverableWrite {
  readonly stepId: string;
  readonly envelope: ExternalWriteEnvelope;
  readonly action: ProposedAction;
}

/** Injected effects for recovery (all fakeable; no Date.now(), no network here). */
export interface RecoverDeps {
  /** Injected wall clock — stamps a surfaced health item (no Date.now()). */
  readonly clock: Clock;
  /** The persistent System-Health surface a failed recovery reports to. */
  readonly healthSurface: HealthSurface;
  /** The §8 external-write ENVELOPE-REUSE gateway deps (the SAME bundle the live gateway uses). */
  readonly envelopeReuse: EnvelopeReuseDeps;
}

/** Inputs to recover one in-flight run. */
export interface RecoverInput {
  /** The run being recovered (subjectRef for a surfaced health item). */
  readonly runId: string;
  /** The run's ordered steps + durable ledger (fed to the pure planResume). */
  readonly resume: ResumeInput;
  /** The pending external writes, indexed by stepId, this run may re-drive. */
  readonly writes: readonly RecoverableWrite[];
  readonly deps: RecoverDeps;
}

/**
 * The outcome of recovering a run. `recovered` is TRUE only when the whole run
 * replayed cleanly (every re-drive committed or reused, no torn/held step).
 * `created`/`reused` count the external-write drives (a `reused` proves a
 * crash-interrupted write was NOT duplicated). `healthItem` is present IFF recovery
 * failed — the operator-visible `worker_down` item that was surfaced (never a silent
 * drop).
 */
export interface RecoverOutcome {
  readonly recovered: boolean;
  /** External writes issued exactly once on this recovery (first drive). */
  readonly created: number;
  /** External writes short-circuited by a stored receipt (NO duplicate write). */
  readonly reused: number;
  /** The surfaced worker_down item on a failed/unrecoverable recovery (else absent). */
  readonly healthItem?: HealthItem;
}

/** The closed error set of recovery (§16). A persist fault while surfacing a health item. */
export interface RecoverError {
  readonly code: "health_persist_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Recover an in-flight run. Replans via {@link planResume}; re-drives each pending
 * external write through the §8 envelope reuse (no duplicate write); on any
 * unrecoverable/held step surfaces a `worker_down` HealthItem through the injected
 * surface. Idempotent + re-drivable across repeated crashes. Never throws (§16).
 */
export async function recoverRun(
  input: RecoverInput,
): Promise<Result<RecoverOutcome, RecoverError>> {
  const { runId, resume, writes, deps } = input;
  const { clock, healthSurface, envelopeReuse } = deps;

  const outcome = planResume(resume, clock);

  // A torn commit (or a mutating re-drive step with no idempotency key) is
  // UNRECOVERABLE: planResume already refused to resume and built an OPEN health
  // item. Surface it through the persistent surface (never re-drive, never drop).
  if (outcome.kind === "unrecoverable") {
    return surfaceUnrecovered(
      input,
      `run ${runId} recovery aborted: ${outcome.health.message}`,
    );
  }

  const writeByStep = new Map<string, RecoverableWrite>(
    writes.map((w) => [w.stepId, w] as const),
  );

  let created = 0;
  let reused = 0;
  // The FIRST held/failed re-drive step, if any — used to build the surfaced
  // worker_down message. We collect it but do NOT stop the drive loop on it: among
  // external_write steps the §6 plan ORDER is by KIND only, and the ordering doc in
  // resume.ts is explicit that external writes' relative position is NOT load-bearing
  // (each reuses its OWN §8 envelope + receipt; there is no inter-external-write
  // dependency). So a held earlier write must NOT strand an independent, re-drivable
  // later write THIS pass — we drive every re-drivable step and report unrecovered
  // only because at least one step is held. (A torn commit is a DIFFERENT case: it is
  // caught upstream by planResume → 'unrecoverable' and never reaches this loop, so we
  // never re-drive a torn commit here. Each drive reuses its receipt → no dup write.)
  let firstFailure: { stepId: string; message: string } | undefined;

  // Re-drive each RE-DRIVE external_write step in the §6-ordered plan. A committed
  // step is a skip (planResume marked it 'skip') — we never re-run it. Reusing the
  // SAME envelope is what makes the replay gate return 'reused' (no dup create).
  for (const planned of outcome.plan) {
    if (planned.disposition === "skip") continue;
    if (planned.step.kind !== "external_write") continue;
    const write = writeByStep.get(planned.step.stepId);
    if (write === undefined) continue; // nothing to drive for this step id

    const res = await reuseExternalWriteOnResume(write.envelope, write.action, envelopeReuse);
    if (!res.ok) {
      // A held/conflict/rejected re-drive FAILED CLOSED (no create issued). Record
      // the first such step for the surfaced health item, but CONTINUE driving the
      // remaining INDEPENDENT external_write steps this pass (they are not blocked by
      // this one). The run is reported unrecovered below (a held step remains).
      if (firstFailure === undefined) {
        firstFailure = {
          stepId: planned.step.stepId,
          message: `run ${runId} recovery held on step ${planned.step.stepId}: ${res.error.code} — ${res.error.reason}`,
        };
      }
      continue;
    }
    if (res.value.status === "created") created += 1;
    else reused += 1;
  }

  // At least one step was held/failed → surface a worker_down item and report the run
  // unrecovered (never a silent drop), carrying the drive counts for the independent
  // steps that DID re-drive cleanly this pass (each exactly once — no dup write).
  if (firstFailure !== undefined) {
    return surfaceUnrecovered(input, firstFailure.message, { created, reused });
  }

  return ok({ recovered: true, created, reused });
}

/** The synthetic, valid audit ref anchoring a recovery health item (no real AuditRecord in this layer). */
function recoveryAuditRef(runId: string): AuditId {
  return auditId(`recovery-${runId}`);
}

/**
 * Surface a `worker_down` System-Health item for a run that could not be recovered,
 * then report the run unrecovered. A persist fault while surfacing is a typed err
 * (fail-closed) — a lost health write is safety-bearing (the run would otherwise
 * vanish), so it must not be swallowed.
 */
async function surfaceUnrecovered(
  input: RecoverInput,
  message: string,
  drives: { readonly created: number; readonly reused: number } = { created: 0, reused: 0 },
): Promise<Result<RecoverOutcome, RecoverError>> {
  const { runId, deps } = input;
  const now = deps.clock.now();
  const recorded = await deps.healthSurface.record({
    failureClass: "worker_down",
    subjectRef: runId,
    severity: "error",
    message,
    auditRef: recoveryAuditRef(runId),
    now,
  });
  if (!recorded.ok) {
    return err(mapSurfaceError(recorded.error));
  }
  // Report the writes that DID drive cleanly this pass (independent later steps that
  // were re-driven despite an earlier held step) — never a silent drop, counts honest.
  return ok({
    recovered: false,
    created: drives.created,
    reused: drives.reused,
    healthItem: recorded.value.item,
  });
}

/** Map a HealthSurfaceError into the recovery error set (§16). */
function mapSurfaceError(e: HealthSurfaceError): RecoverError {
  return { code: "health_persist_failed", message: e.message, cause: e.cause };
}
