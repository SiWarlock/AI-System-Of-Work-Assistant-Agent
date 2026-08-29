// apps/worker — task 10.6: bind the operational-backup PORTS to the real @sow/db
// backup engine + filesystem sink, so `createOperationalBackupService` finally has
// something to run.
//
// ⛔ WHAT WAS MISSING, and it was NOT the machinery. `@sow/db` already exports
// `createSqliteBackupEngine`, `createFsBackupSink` and `runPeriodicBackup`; the
// worker already has `createOperationalBackupService`. What did not exist was the
// two-function ADAPTER between them, so `bootWorker` built the service only when a
// caller passed `backupPorts` and no caller ever did. Nothing backed up the
// operational store — the non-rebuildable audit/approvals/outbox truth §16 names.
//
// ⚠ WHERE THE BACKUPS GO, stated rather than buried: `deriveBackupDir` puts them in a
// `backups/` directory BESIDE the operational store file, so they live and travel
// with the data they protect and inherit its permissions. An in-memory store
// (`:memory:`, every default test boot) has no directory and is deliberately
// UNBACKABLE — `createOperationalBackupPorts` returns `undefined` for it rather than
// inventing a location, which also keeps the shipped default byte-equivalent.
//
// §16: every method returns a typed `Result` and NEVER throws — a driver throw is
// mapped onto the closed `DbError` taxonomy, since the caller (the backup service)
// folds outcomes and must not receive an exception.
import { dirname, join } from "node:path";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { DbError } from "@sow/db";
import { createSqliteBackupEngine, createFsBackupSink, runPeriodicBackup } from "@sow/db";
import type {
  OpDbBackupPort,
  OpDbBackupArtifact,
  TemporalPersistenceBackupPort,
  TemporalBackupArtifact,
} from "./operational-backup";

/** Retention: how many artifacts to keep. Small on purpose — a personal-scale store. */
export const DEFAULT_BACKUP_KEEP = 7;

/**
 * Where artifacts live: `backups/` beside the operational store file. Returns
 * `undefined` for an in-memory store, which has no directory and nothing durable to
 * protect — the caller treats that as "backups not applicable", never as an error.
 */
export function deriveBackupDir(dbPath: string | undefined): string | undefined {
  if (dbPath === undefined || dbPath === ":memory:" || dbPath.trim().length === 0) return undefined;
  return join(dirname(dbPath), "backups");
}

/** Map an unexpected driver throw onto the closed taxonomy (§16 — never propagate). */
function asDbError(cause: unknown): DbError {
  return { code: "unknown", message: "operational backup failed", cause } as DbError;
}

/**
 * Build the op-DB backup port over the REAL engine + fs sink.
 *
 * `latestBackupAt` reads the newest artifact's `createdAt` — the persisted cadence
 * marker, so the interval survives a restart rather than resetting every boot.
 * `backup()` ALWAYS captures: the cadence decision belongs to the service above
 * (`runOperationalBackup`), and having both layers apply it would silently double-gate
 * — the service would decide a backup is due and the port would quietly skip it.
 *
 * ⚠ TWO things below enforce that, and they are redundant ON PURPOSE: `intervalMs: 0`
 * makes every call due, and `force: true` says so explicitly. Either alone suffices,
 * so neither is individually mutation-detectable — which is exactly why the pin
 * `the PORT always captures` asserts the BEHAVIOUR (two calls ⇒ two artifacts)
 * rather than either flag. Change one and the test still holds; change both and it
 * goes red.
 *
 * ⚠ ENGINE PROPERTY worth knowing before reusing this port: `backupId` is
 * `op-<ISO-with-ms>-<content-digest>`, so two captures of IDENTICAL content inside
 * the same millisecond collide on the same id and the second OVERWRITES the first.
 * Unreachable under the real daily cadence, and harmless there — but a caller that
 * loops `backup()` will not get N artifacts. Measured, not assumed: an earlier test
 * draft asserted distinct ids and was flaky because of exactly this.
 */
export function createOpDbBackupPort(conn: unknown, dir: string): OpDbBackupPort {
  const engine = createSqliteBackupEngine(conn as never);
  const sink = createFsBackupSink(dir);
  return {
    async latestBackupAt(): Promise<Result<string | undefined, DbError>> {
      try {
        const listed = sink.list();
        if (!listed.ok) return listed;
        return ok(listed.value[0]?.createdAt);
      } catch (cause) {
        return err(asDbError(cause));
      }
    },
    async backup(): Promise<Result<OpDbBackupArtifact, DbError>> {
      try {
        const outcome = await runPeriodicBackup(engine, sink, {
          // Always due + explicitly forced — see the doc comment above for why both.
          intervalMs: 0,
          now: new Date(),
          keep: DEFAULT_BACKUP_KEEP,
          force: true,
        });
        if (!outcome.ok) {
          return err({ code: "unknown", message: outcome.error.message } as DbError);
        }
        const stored = outcome.value.backup;
        if (stored === undefined) {
          // Unreachable with force:true, but a forced run that reports no artifact is
          // a broken contract, not a success — fail closed rather than fabricate one.
          return err({ code: "unknown", message: "forced backup reported no artifact" } as DbError);
        }
        return ok({
          backupId: stored.backupId,
          createdAt: stored.createdAt,
          sizeBytes: stored.sizeBytes,
          rowDigest: stored.rowDigest,
          location: stored.location,
          coveredDomains: [],
        } as OpDbBackupArtifact);
      } catch (cause) {
        return err(asDbError(cause));
      }
    },
  };
}

/**
 * The Temporal-persistence backup port.
 *
 * ⛔ HONESTLY UNIMPLEMENTED, and it fails CLOSED rather than reporting a success it
 * did not achieve. §16 names Temporal persistence as operational truth that is not
 * Git-backed, but this worker does not own the Temporal datastore: the dev server is
 * a separate supervised process with its own `--db-filename`, and a hosted Temporal
 * exposes an archival hook instead. Binding either is a real slice with its own
 * decisions.
 *
 * ⚠ A no-op returning `ok` would be far worse than this error: the service would
 * report a complete backup while Temporal's half was never captured, and the failure
 * would only surface at a restore. A typed err is visible now.
 */
export function createUnavailableTemporalBackupPort(): TemporalPersistenceBackupPort {
  return {
    async backup(): Promise<Result<TemporalBackupArtifact, DbError>> {
      return err({
        code: "unavailable",
        message: "temporal persistence backup is not bound in this deployment",
      } as DbError);
    },
  };
}

/**
 * Assemble both ports for a durable store, or `undefined` when there is nothing
 * durable to back up (an in-memory store). `undefined` keeps `bootWorker`'s existing
 * absent-`backupPorts` path byte-equivalent.
 */
export function createOperationalBackupPorts(
  conn: unknown,
  dbPath: string | undefined,
): { readonly opDb: OpDbBackupPort; readonly temporal: TemporalPersistenceBackupPort } | undefined {
  const dir = deriveBackupDir(dbPath);
  if (dir === undefined) return undefined;
  return { opDb: createOpDbBackupPort(conn, dir), temporal: createUnavailableTemporalBackupPort() };
}

/** A backup service as the periodic tick consumes it — narrowed so the tick needs no more. */
export interface PeriodicBackupRunner {
  run(input: { readonly intervalMs: number; readonly now: Date }): Promise<unknown>;
}

/**
 * Build the periodic backup tick, with an IN-FLIGHT GUARD.
 *
 * ⛔ WHY THE GUARD EXISTS — a defect found reviewing this session's OWN change. `bootWorker`
 * schedules this on a 1-hour `setInterval` and the call is fire-and-forget (`void …catch()`), so
 * nothing prevented a second run starting while the first was still going.
 *
 * ⚠ IT IS NOT UNREACHABLE, and the reachable path is specific: the service decides "due" by reading
 * the NEWEST ARTIFACT'S timestamp. A backup that outlives the check interval has not written its
 * artifact yet ⇒ the next tick still reads the OLD timestamp ⇒ still due ⇒ ***it starts a second
 * concurrent backup against the same sink***, where they race on retention pruning (`keep`) and on
 * `backupId` (`op-<ISO-with-ms>-<digest>`). Needs a backup slower than the interval — implausible
 * at personal scale, entirely possible on a stalled fs or a network volume.
 *
 * ⭐ SKIP, never queue: a skipped tick costs nothing (the next one is an hour away and the cadence
 * is a day), while queueing would convert a slow backup into a growing backlog of them.
 * The guard clears in `finally`, so a REJECTED run never wedges the tick permanently.
 */
export function createPeriodicBackupTick(deps: {
  readonly service: PeriodicBackupRunner | undefined;
  readonly cadenceMs: number;
  readonly now: () => Date;
  /** Optional observer — invoked with `"skipped"` when a tick lands while one is in flight. */
  readonly onTick?: (outcome: "ran" | "skipped" | "no_service") => void;
}): () => void {
  let inFlight = false;
  return (): void => {
    if (deps.service === undefined) {
      deps.onTick?.("no_service");
      return;
    }
    if (inFlight) {
      deps.onTick?.("skipped");
      return;
    }
    inFlight = true;
    deps.onTick?.("ran");
    void deps.service
      .run({ intervalMs: deps.cadenceMs, now: deps.now() })
      .catch(() => {
        /* best-effort: never block or fail the worker on a backup */
      })
      .finally(() => {
        inFlight = false;
      });
  };
}
