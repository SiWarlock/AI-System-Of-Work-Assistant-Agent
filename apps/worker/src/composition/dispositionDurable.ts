// Task 15.5 — the DURABLE ingestion-disposition seams (worker leg). Replaces the in-memory
// makeDispositionStore + the parkedReader/ingestionRunner stubs with real implementations over the
// durable @sow/db SourceDisposition store (the parked-source-of-record; resolves ING-4).
//
// SAFETY (security-reviewer=invariant):
//   - The parked SourceEnvelope is RAW candidate content at rest — SERVER-SIDE OPERATIONAL ONLY. The
//     disposition audit carries SUMMARIES ONLY (never the raw body/content, rule 7); the UI render
//     path stays the separate UI-safe ingestionInboxProjection (the sole render surface).
//   - isParked reflects the store (a parked row exists), never a hardwired true.
//   - the rescope's owner override workspace is REGISTRY-VALIDATED (WS-8 — never a raw/unregistered bind).
//   - re-enter re-drives THROUGH the candidate gate (rule 2) reusing the idempotencyKey; an already-
//     committed key REPLAYS over the real KnowledgeRevisionStore (rule 3 / inv-D).
//   - FAIL-CLOSED both directions (Lesson 3): a store fault surfaces a typed err (isParked/insert),
//     never a masked not-parked / silent record. §16: never throws.
import { ok, err, isErr, type Result } from "@sow/contracts";
import { auditId as makeAuditId } from "@sow/contracts";
import type { AuditId, SourceEnvelope, WorkflowRunRef } from "@sow/contracts";
import type { AuditRepository, ReadModelRepository, SourceDispositionRepository } from "@sow/db";
import type { KnowledgeRevisionStore } from "@sow/knowledge";
import {
  createRescopeSourceActivity,
  type DispositionStore,
  type ParkedSourceReader,
  type RescopeSourcePort,
  type SourceIngestionRunner,
  type ReenterOutcome,
} from "@sow/workflows";
import { resolveKnownWorkspace } from "../api/adapters/readModel";

// ── (1) the durable DispositionStore (real isParked + CAS insert + redaction-safe audit) ──────────

export interface DurableDispositionStoreDeps {
  readonly repo: SourceDispositionRepository;
  readonly audit: AuditRepository;
  readonly now: () => string;
  readonly runRef: WorkflowRunRef;
}

/**
 * Build the durable {@link DispositionStore} over the SourceDisposition repo. `isParked` reflects a
 * persisted parked row (never the hardwired `true`); `getByKey` reads the recorded disposition's audit
 * ref (a fault degrades to `undefined` — SAFE because it is only consumed in the CAS-record path that
 * always ends in a fail-closed `insert`, which returns a Result); `insert` appends a SUMMARIES-ONLY
 * audit then CAS-records the disposition (fail-closed). Never throws.
 */
export function createDurableDispositionStore(deps: DurableDispositionStoreDeps): DispositionStore {
  return {
    async isParked(sourceId: string): Promise<Result<boolean, { code: "record_failed"; message: string }>> {
      const got = await deps.repo.getBySourceId(sourceId);
      if (isErr(got)) return err({ code: "record_failed", message: "disposition store unavailable" });
      // A ROW EXISTS ⇒ the source is in the inbox (parked). Deliberately NOT `state === "queued_for_
      // review"`: convergence (inv-B) requires an ALREADY-`dispositioned` row to stay parked so the
      // converging second channel (Mac after Telegram, same decision) hits getByKey → `noop` (reuse
      // the prior audit ref) rather than `not_parked`. This faithfully replaces the prior hardwired
      // `true` stub; exactly-once is enforced by the CAS `recordDisposition` regardless of this flag.
      return ok(got.value !== undefined);
    },
    async getByKey(key: string): Promise<AuditId | undefined> {
      const got = await deps.repo.getByDispositionKey(key);
      // A fault degrades to undefined; the record activity's CAS insert re-hits the fault fail-closed.
      if (isErr(got) || got.value === undefined || got.value.auditRef === null) return undefined;
      return got.value.auditRef as AuditId;
    },
    async insert(key, disposition): Promise<Result<AuditId, { code: "record_failed"; message: string }>> {
      const auditRef = makeAuditId(`audit:disposition:${key}`);
      // Redaction-safe audit FIRST (summaries only — NEVER the raw parked body/content, rule 7); a
      // record always carries its audit (nothing silent).
      const appended = await deps.audit.append({
        actor: "ingestion-triage",
        event: "ingestion.triage.disposition.recorded",
        refs: [
          `ref:source:${disposition.sourceId}`,
          `ref:workspace:${String(disposition.workspaceId)}`,
          `ref:workflow:${deps.runRef.workflowId}`,
          String(auditRef),
        ],
        payloadHash: `disposition:${key}`,
        beforeSummary: "parked source awaiting owner disposition",
        afterSummary: "owner disposition recorded; source re-scoped for re-entry",
        timestamps: { occurredAt: deps.now() },
      });
      if (isErr(appended)) return err({ code: "record_failed", message: "disposition audit append failed" });
      const recorded = await deps.repo.recordDisposition(disposition.sourceId, key, String(auditRef), deps.now());
      if (isErr(recorded)) return err({ code: "record_failed", message: "disposition record failed" });
      return ok(auditRef);
    },
  };
}

// ── (2) the durable ParkedSourceReader (reads the parked SourceEnvelope back) ──────────────────────

/**
 * Build the {@link ParkedSourceReader} over the store — reads the FULL parked SourceEnvelope back for
 * the rescope/re-enter path. A genuine absence AND a store fault both fold onto the port's single
 * `source_unavailable` code (the fault↔absence distinction is preserved at the repo Result); never throws.
 */
export function createDurableParkedReader(repo: SourceDispositionRepository): ParkedSourceReader {
  return {
    async read(sourceId: string): Promise<Result<SourceEnvelope, { code: "source_unavailable"; message: string }>> {
      const got = await repo.getBySourceId(sourceId);
      if (isErr(got)) return err({ code: "source_unavailable", message: "parked source store unavailable" });
      if (got.value === undefined) return err({ code: "source_unavailable", message: `parked source ${sourceId} not found` });
      return ok(got.value.sourceEnvelope);
    },
  };
}

// ── (3) the registry-validated rescope (WS-8 owner override) ───────────────────────────────────────

export interface RegistryValidatedRescopeDeps {
  readonly reader: ParkedSourceReader;
  readonly readModels: ReadModelRepository;
}

/**
 * Wrap the {@link createRescopeSourceActivity} with a WS-8 registry gate: the owner's override
 * workspace MUST be a registered workspace (never a raw/unregistered cross-workspace bind). A
 * registry fault OR an unregistered override ⇒ `rescope_failed`; else the inner rescope applies the
 * override + PRESERVES contentHash (inv-C/inv-D). Never throws.
 */
export function createRegistryValidatedRescope(deps: RegistryValidatedRescopeDeps): RescopeSourcePort {
  const inner = createRescopeSourceActivity({ reader: deps.reader });
  return {
    async rescope(disposition) {
      const known = await resolveKnownWorkspace(deps.readModels, String(disposition.workspaceId));
      if (!known.ok) return err({ code: "rescope_failed", message: "workspace registry unavailable" });
      if (!known.value) return err({ code: "rescope_failed", message: "override workspace is not registered" });
      return inner.rescope(disposition);
    },
  };
}

// ── (4) the scoped-but-real re-enter runner (re-gate + idempotencyKey replay) ──────────────────────

export interface ReenterRunnerDeps {
  /** The candidate gate for the re-scoped source (rule 2 — a rejected source never re-enters). */
  readonly reGate: (source: SourceEnvelope) => Promise<Result<void, { code: "rejected" }>>;
  /** The real replay substrate — an existing revision at the idempotencyKey ⇒ replay (inv-D). */
  readonly revisions: KnowledgeRevisionStore;
}

/**
 * Build the {@link SourceIngestionRunner} that re-enters a re-scoped source: it re-drives THROUGH the
 * candidate gate (rule 2 — a rejected source ⇒ reentry_failed, never a raw-around-gate re-entry) and
 * reuses the idempotencyKey — an already-committed key REPLAYS over the real KnowledgeRevisionStore
 * (`runReused=true`, no duplicate downstream write; rule 3 / inv-D). The FRESH-commit re-drive of the
 * full 7.7 pipeline (route/agent/build/commit) is a named deferred follow-up. Never throws.
 */
export function createReenterRunner(deps: ReenterRunnerDeps): SourceIngestionRunner {
  return {
    async run(reScopedSource, idempotencyKey): Promise<Result<ReenterOutcome, { code: "reentry_failed"; message: string }>> {
      try {
        const gated = await deps.reGate(reScopedSource);
        if (isErr(gated)) return err({ code: "reentry_failed", message: "re-scoped source rejected by the candidate gate" });
        const prior = await deps.revisions.getByIdempotencyKey(idempotencyKey);
        return ok({ state: "applied", runReused: prior !== undefined });
      } catch {
        return err({ code: "reentry_failed", message: "re-entry failed" });
      }
    },
  };
}
