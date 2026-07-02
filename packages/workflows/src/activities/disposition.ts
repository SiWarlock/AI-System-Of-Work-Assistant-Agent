// @sow/workflows — slice 7.8 ACTIVITY: the INGESTION-TRIAGE disposition activities.
//
// This is ACTIVITY code, NOT workflow code — it runs worker-side and MAY use
// node:crypto (via @sow/domain `buildIdempotencyKey`) to compute the STABLE,
// CHANNEL-FREE disposition key that drives exactly-once recording (inv-A) and
// Mac/Telegram convergence (inv-B). It implements the three triage ports the pure
// driver (src/workflows/ingestionTriage.ts) injects: {@link RecordDispositionPort},
// {@link RescopeSourcePort}, {@link ReenterIngestionPort}.
//
// WHY THE KEY IS CHANNEL-FREE (the convergence seam): the disposition key is hashed
// from (sourceId + the ROUTING fields: workspace/project/sensitivity) — it
// DELIBERATELY EXCLUDES `channel`. So the SAME owner decision arriving from Mac and
// from Telegram computes the SAME key → the operational store's CAS-insert admits
// exactly ONE record → one state transition → no divergent inbox state across
// channels (inv-B). A re-submitted identical disposition hits the same key → a no-op
// reusing the prior auditRef (inv-A). Only a DIFFERENT routing decision (a different
// workspace/project/sensitivity) yields a different key.
//
// WHY contentHash IS PRESERVED on re-scope (the replay seam): the re-entry is the
// SAME logical source, just re-classified. The 7.7 pipeline's downstream idempotency
// (KnowledgeWriter plan key, Tool Gateway envelope key) is derived from the source's
// stable identity — preserving contentHash keeps that identity unchanged, so
// re-entry (or a re-submitted disposition) replays the downstream write instead of
// duplicating it (inv-D).
//
// §16: every port returns a typed Result — never throws. Each injected adapter's
// typed rejection folds onto the CLOSED error each port declares (fail-closed).
import { ok, err } from "@sow/contracts";
import type {
  Result,
  SourceEnvelope,
  AuditId,
} from "@sow/contracts";
import { buildIdempotencyKey } from "@sow/domain";
import type {
  TriageDisposition,
  RecordDispositionPort,
  RecordDispositionOutcome,
  RecordDispositionError,
  RescopeSourcePort,
  RescopeError,
  ReenterIngestionPort,
  ReenterOutcome,
  ReenterError,
} from "../ports/ingestionTriage";

/**
 * Compute the STABLE, CHANNEL-FREE disposition key (node:crypto via
 * `buildIdempotencyKey`). The key hashes (sourceId + workspace/project/sensitivity)
 * — NEVER the channel — so Mac + Telegram of the SAME decision converge (inv-B) and
 * a re-submit of the SAME decision is a no-op (inv-A). Exposed so the operational
 * store adapter + tests can compute the identity deterministically.
 */
export function dispositionKey(disposition: TriageDisposition): string {
  return buildIdempotencyKey({
    operation: "ingestion.triage.disposition",
    identity: {
      source: disposition.sourceId,
      workspace: String(disposition.workspaceId),
      project: disposition.projectId ?? "",
      sensitivity: disposition.sensitivity ?? "",
    },
  });
}

// ---------------------------------------------------------------------------
// (1) RecordDispositionPort activity — exactly-once via a CAS-inserted record
// ---------------------------------------------------------------------------

/**
 * The narrow operational-store seam the record activity CAS-inserts through. A
 * production adapter backs it with the operational DB (a UNIQUE index on the
 * disposition key) + the §8 audit sink; the activity computes the key and folds the
 * store's typed rejection onto {@link RecordDispositionError}.
 *
 *   • `getByKey` — is a record already present for this disposition key? (idempotent
 *     re-submit / converging channel detection, inv-A/inv-B).
 *   • `insert`   — CAS-insert a fresh record + mint its audit ref; the FIRST insert
 *     wins the unique-key constraint (the single transition). A lost race re-reads.
 *   • `isParked` — the inbox row must be in `queued_for_review` to be dispositioned;
 *     otherwise `not_parked` (fail-closed).
 */
export interface DispositionStore {
  isParked(sourceId: string): Promise<Result<boolean, { code: "record_failed"; message: string }>>;
  getByKey(key: string): Promise<AuditId | undefined>;
  insert(
    key: string,
    disposition: TriageDisposition,
  ): Promise<Result<AuditId, { code: "record_failed"; message: string }>>;
}

/** Injected deps for the record activity. */
export interface RecordDispositionActivityDeps {
  readonly store: DispositionStore;
}

/**
 * Build a {@link RecordDispositionPort} that records the owner disposition EXACTLY
 * ONCE. It computes the stable channel-free key, verifies the source is parked, then
 * CAS-inserts: a HIT on the key is a `noop` reusing the prior auditRef (inv-A/inv-B);
 * a fresh insert is `recorded`. A store failure or a not-parked source fails closed.
 * Never throws.
 */
export function createRecordDispositionActivity(
  deps: RecordDispositionActivityDeps,
): RecordDispositionPort {
  return {
    async record(
      disposition: TriageDisposition,
    ): Promise<Result<RecordDispositionOutcome, RecordDispositionError>> {
      const parked = await deps.store.isParked(disposition.sourceId);
      if (!parked.ok) {
        return err({ code: "record_failed", message: parked.error.message });
      }
      if (!parked.value) {
        return err({
          code: "not_parked",
          message: `source ${disposition.sourceId} is not in the Ingestion Inbox`,
        });
      }
      const key = dispositionKey(disposition);
      const existing = await deps.store.getByKey(key);
      if (existing !== undefined) {
        // Idempotent re-submit OR converging second channel — NO second record,
        // NO second transition; reuse the prior auditRef (inv-A / inv-B).
        return ok({ outcome: "noop", auditRef: existing });
      }
      const inserted = await deps.store.insert(key, disposition);
      if (!inserted.ok) {
        // A lost CAS race is possible (another channel won between our read + insert);
        // re-read by key and reuse the winner's audit ref (converge, inv-B).
        const reread = await deps.store.getByKey(key);
        if (reread !== undefined) {
          return ok({ outcome: "noop", auditRef: reread });
        }
        return err({ code: "record_failed", message: inserted.error.message });
      }
      return ok({ outcome: "recorded", auditRef: inserted.value });
    },
  };
}

// ---------------------------------------------------------------------------
// (2) RescopeSourcePort activity — apply the routing override, preserve hash
// ---------------------------------------------------------------------------

/** The seam that reads the parked source the disposition targets. */
export interface ParkedSourceReader {
  read(
    sourceId: string,
  ): Promise<Result<SourceEnvelope, { code: "source_unavailable"; message: string }>>;
}

/** Injected deps for the re-scope activity. */
export interface RescopeSourceActivityDeps {
  readonly reader: ParkedSourceReader;
}

/**
 * Build a {@link RescopeSourcePort} that applies the owner's routing override to the
 * parked source (inv-C), producing the RE-SCOPED {@link SourceEnvelope} the 7.7
 * pipeline re-enters on. It stamps the OWNER-BOUND workspaceId (WS-2 override), the
 * optional project (via routingHints), and the optional sensitivity override, while
 * PRESERVING contentHash (inv-D: same logical source → same downstream idempotency).
 * Never throws.
 */
export function createRescopeSourceActivity(
  deps: RescopeSourceActivityDeps,
): RescopeSourcePort {
  return {
    async rescope(
      disposition: TriageDisposition,
    ): Promise<Result<SourceEnvelope, RescopeError>> {
      const parked = await deps.reader.read(disposition.sourceId);
      if (!parked.ok) {
        return err({ code: "source_unavailable", message: parked.error.message });
      }
      const src = parked.value;
      // inv-C: apply the OWNER override; inv-D: PRESERVE contentHash.
      const reScoped: SourceEnvelope = {
        ...src,
        workspaceId: disposition.workspaceId,
        ...(disposition.sensitivity !== undefined
          ? { sensitivity: disposition.sensitivity }
          : {}),
        routingHints: {
          ...src.routingHints,
          ...(disposition.projectId !== undefined
            ? { projectId: disposition.projectId }
            : {}),
        },
      };
      return ok(reScoped);
    },
  };
}

// ---------------------------------------------------------------------------
// (3) ReenterIngestionPort activity — re-drive 7.7 with the SAME idempotencyKey
// ---------------------------------------------------------------------------

/**
 * The 7.7 re-entry runner seam. A production adapter drives
 * `runSourceIngestion` (the 7.7 driver) with a route port forced HIGH-confidence off
 * the re-scoped source's owner-bound workspace, REUSING the passed idempotencyKey so
 * resolveRun + KnowledgeWriter + Tool Gateway all replay (inv-D). It returns the
 * 7.7 resting state + the run-reuse flag; the triage activity folds a failure onto
 * {@link ReenterError}.
 */
export interface SourceIngestionRunner {
  run(
    reScopedSource: SourceEnvelope,
    idempotencyKey: string,
  ): Promise<Result<ReenterOutcome, { code: "reentry_failed"; message: string }>>;
}

/** Injected deps for the re-entry activity. */
export interface ReenterIngestionActivityDeps {
  readonly runner: SourceIngestionRunner;
}

/**
 * Build a {@link ReenterIngestionPort} that RE-ENTERS the 7.7 pipeline on the
 * re-scoped source, REUSING the SAME idempotencyKey (inv-D). Because the key is
 * reused, the downstream run/commit/external write are idempotent-replayed → zero
 * duplicate downstream write. Never throws.
 */
export function createReenterIngestionActivity(
  deps: ReenterIngestionActivityDeps,
): ReenterIngestionPort {
  return {
    async reenter(
      reScopedSource: SourceEnvelope,
      idempotencyKey: string,
    ): Promise<Result<ReenterOutcome, ReenterError>> {
      const ran = await deps.runner.run(reScopedSource, idempotencyKey);
      if (!ran.ok) {
        return err({ code: "reentry_failed", message: ran.error.message });
      }
      return ok(ran.value);
    },
  };
}
