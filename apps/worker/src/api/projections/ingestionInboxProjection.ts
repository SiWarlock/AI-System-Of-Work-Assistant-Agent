// Task 9.7-B (§10 read-model serving / §11 UI-safe surface + safety rule 4 WS-8) — the write-time
// ingestion-inbox PRODUCER core. Upserts the `ingestion_inbox` read_models row (the row
// `query.ingestionInbox` reads, shipped empty-until-producer in slice 9.7-A) when a SourceEnvelope
// parks in `queued_for_review`, and removes its entry on triage disposition — so the ingestion inbox
// populates. Deterministic over injected deps (readModels + now); never throws (§16).
//
// LEAKAGE-AT-REST (safety rule 2/4): the drop-rules seam `toUiSafeIngestionItem` is applied AT WRITE,
// so the stored blob at rest holds ONLY already-dropped UiSafeIngestionItem items — raw
// origin/contentHash/routingHints/workspaceId are NEVER persisted (defense-in-depth beyond 9.7-A's
// read-time drop). The write-side reads existing items back through the SAME `readIngestionItems`
// narrower the read path uses, so the stored shape can never drift from the 9.7-A read contract.
//
// Ships DORMANT: the always-on wiring — invoking `recordPark` at the Temporal ingestion workflow's
// low-confidence park route (`packages/workflows/src/workflows/sourceIngestion.ts`) and
// `recordDisposition` at `createRecordDispositionActivity`
// (`packages/workflows/src/activities/disposition.ts:104-141`) — plus the desktop surface mount are
// DEFERRED (R5-style, exactly like `projectRecentChanges`, which is built with no caller). Mirrors
// `projectDashboardUpdate.ts` (factory + injected readModels+now, upsert-preserving-siblings,
// fault-vs-not_found guard).
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result, SourceEnvelope } from "@sow/contracts";
import type { ReadModelRepository } from "@sow/db";
import { READ_MODEL_KEYS, readIngestionItems } from "../adapters/readModel";
import { toUiSafeIngestionItem } from "./uiSafe";

/** Deps for the producer: the read-model repo + a clock (the rebuiltAt stamp — deterministic/testable). */
export interface IngestionInboxProjectionDeps {
  readonly readModels: ReadModelRepository;
  /** ISO-8601 now — injected so the producer stays deterministic/testable. */
  readonly now: () => string;
}

/** A typed producer failure (never thrown — §16). */
export interface IngestionInboxProjectionError {
  readonly code: "ingestion_inbox_write_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/** Input to {@link IngestionInboxProjectionPort.recordPark}. */
export interface RecordParkInput {
  /** The SERVER-BOUND write key (WS-8) — the workspace the parked source belongs to. Required, non-empty. */
  readonly workspaceId: string;
  /** The parked source register record; the UI-safe item is DERIVED from it internally (drop-rules seam). */
  readonly source: SourceEnvelope;
}

/** The write-time ingestion-inbox producer port. */
export interface IngestionInboxProjectionPort {
  /**
   * On-park upsert: build the UI-safe item from the parked SourceEnvelope (drop-rules AT WRITE),
   * dedup-by-sourceId (idempotent re-park), append to the workspace's row (create-if-absent).
   */
  readonly recordPark: (input: RecordParkInput) => Promise<Result<void, IngestionInboxProjectionError>>;
  /**
   * On-disposition remove: filter the `sourceId` out of the workspace's row. An absent row or a
   * missing sourceId is an `ok` no-op (nothing to remove — no error, no write).
   */
  readonly recordDisposition: (
    workspaceId: string,
    sourceId: string,
  ) => Promise<Result<void, IngestionInboxProjectionError>>;
}

type ProjErr = IngestionInboxProjectionError;
const fail = (message: string, cause?: unknown): ProjErr => ({
  code: "ingestion_inbox_write_failed",
  message,
  cause,
});

/**
 * Build the write-time ingestion-inbox producer over the injected read-model repo + clock. Both ops
 * key the row per `(READ_MODEL_KEYS.ingestion, workspaceId)` (WS-8 — a park for A never touches B),
 * guard a non-`not_found` `get` fault as a typed err (never a silent empty), and never throw (§16).
 */
export function createIngestionInboxProjectionPort(
  deps: IngestionInboxProjectionDeps,
): IngestionInboxProjectionPort {
  return {
    async recordPark(input: RecordParkInput): Promise<Result<void, ProjErr>> {
      try {
        const { workspaceId, source } = input;
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          return err(fail("recordPark missing a non-empty workspaceId"));
        }
        // WS-8 write-key authority (safety rule 4): the explicit write key MUST agree with the source's
        // own required scope (REQ-F-002 scoped-before-durable). A disagreement is a routing bug — fail
        // closed (never mis-attribute the item to the wrong workspace's inbox), rather than trusting one.
        if (source.workspaceId !== workspaceId) {
          return err(fail("recordPark workspaceId disagrees with source.workspaceId (WS-8)"));
        }
        // Drop-rules AT WRITE — the stored blob carries only the allowlisted UiSafeIngestionItem fields;
        // raw origin/contentHash/routingHints/workspaceId are never persisted.
        const item = toUiSafeIngestionItem(source);

        const existing = await deps.readModels.get(READ_MODEL_KEYS.ingestion, workspaceId);
        if (isErr(existing) && existing.error.code !== "not_found") {
          return err(fail("ingestion-inbox get failed", existing.error));
        }
        const prior = isOk(existing) ? readIngestionItems(existing.value.data) : [];
        // Dedup-by-sourceId (idempotent re-park): drop any prior entry with the same id, then append.
        const items = [...prior.filter((i) => i.sourceId !== item.sourceId), item];
        const put = await deps.readModels.put({
          readModelKey: READ_MODEL_KEYS.ingestion,
          workspaceId,
          data: { items },
          rebuiltAt: deps.now(),
        });
        return isOk(put) ? ok(undefined) : err(fail("ingestion-inbox put failed", put.error));
      } catch (cause) {
        return err(fail("unexpected recordPark fault", cause));
      }
    },

    async recordDisposition(workspaceId: string, sourceId: string): Promise<Result<void, ProjErr>> {
      try {
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          return err(fail("recordDisposition missing a non-empty workspaceId"));
        }
        const existing = await deps.readModels.get(READ_MODEL_KEYS.ingestion, workspaceId);
        if (isErr(existing)) {
          // Absent row ⇒ nothing to remove (ok no-op). A non-not_found fault ⇒ typed err.
          return existing.error.code === "not_found"
            ? ok(undefined)
            : err(fail("ingestion-inbox get failed", existing.error));
        }
        const prior = readIngestionItems(existing.value.data);
        const items = prior.filter((i) => i.sourceId !== sourceId);
        // Missing sourceId ⇒ nothing changed ⇒ ok no-op (no needless write / rebuiltAt bump).
        if (items.length === prior.length) return ok(undefined);
        const put = await deps.readModels.put({
          readModelKey: READ_MODEL_KEYS.ingestion,
          workspaceId,
          data: { items },
          rebuiltAt: deps.now(),
        });
        return isOk(put) ? ok(undefined) : err(fail("ingestion-inbox put failed", put.error));
      } catch (cause) {
        return err(fail("unexpected recordDisposition fault", cause));
      }
    },
  };
}
