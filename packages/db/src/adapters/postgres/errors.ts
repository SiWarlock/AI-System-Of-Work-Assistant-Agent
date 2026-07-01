// Postgres adapter — driver-error → typed DbError mapping (task 2.4, §16 error
// convention). The adapter NEVER throws across a repository boundary: every driver
// throw (PGlite OR node-postgres — both surface the standard Postgres SQLSTATE on
// `.code`) is caught and translated into a `DbError` whose `code` is drawn from the
// closed `DbErrorCode` set (repositories/interfaces.ts). Mapping by SQLSTATE keeps the
// underlying cause opaque to callers (they depend on the taxonomy, never on a driver).
//
// PARITY WITH 2.3: the taxonomy mapping mirrors the SQLite adapter's intent so both
// adapters return the SAME `DbErrorCode` for the same logical failure (the 2.9
// contract suite asserts code parity) — only the raw driver codes differ
// (SQLITE_CONSTRAINT_* ↔ SQLSTATE 23xxx, SQLITE_BUSY ↔ 40001, etc.).
import type { DbError, DbErrorCode } from "../../repositories/interfaces";

/** Minimal structural view of a pg / PGlite error (both carry a SQLSTATE `.code`). */
interface DriverErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}

/**
 * Find the Postgres SQLSTATE in a thrown error. Drizzle wraps the raw driver error in
 * a `DrizzleQueryError` whose top-level `.code` is undefined and whose `.cause` carries
 * the real SQLSTATE — so walk the `.cause` chain (bounded) for the first string `.code`.
 * Works for both PGlite and node-postgres (each surfaces SQLSTATE on the driver error).
 */
function extractSqlState(cause: unknown): string | undefined {
  let cur: unknown = cause;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    const code = (cur as DriverErrorLike).code;
    if (typeof code === "string") return code;
    cur = (cur as DriverErrorLike).cause;
  }
  return undefined;
}

/** Map a raw Postgres SQLSTATE to the closed DbError taxonomy. */
function mapDriverCode(raw: unknown): DbErrorCode {
  if (typeof raw !== "string") return "unknown";
  // 23505 unique_violation — PK/unique duplicate = optimistic-concurrency conflict.
  if (raw === "23505") return "conflict";
  // class 23 (integrity_constraint_violation): FK 23503 / NOT NULL 23502 / CHECK
  // 23514 / exclusion 23P01 — any other integrity constraint is a constraint failure.
  if (raw.startsWith("23")) return "constraint_violation";
  // class 40 (transaction rollback): serialization_failure 40001 / deadlock 40P01 —
  // retry-able (§4 serialization_failure).
  if (raw.startsWith("40")) return "serialization_failure";
  // class 08 (connection exception) + 57P0x (admin shutdown) + 53300
  // (too_many_connections): the store itself is not reachable (§4 degraded mode).
  if (raw.startsWith("08") || raw.startsWith("57P") || raw === "53300") return "unavailable";
  return "unknown";
}

/** Translate any caught driver throw into a typed DbError (never re-throws). */
export function toDbError(cause: unknown, fallbackMessage = "postgres operation failed"): DbError {
  const driver = cause as DriverErrorLike;
  const code = mapDriverCode(extractSqlState(cause));
  const message =
    cause instanceof Error
      ? cause.message
      : typeof driver?.message === "string"
        ? driver.message
        : fallbackMessage;
  return { code, message, cause };
}

/** Build a typed `not_found` DbError for an empty lookup (not an exception path). */
export function notFound(what: string): DbError {
  return { code: "not_found", message: `${what} not found` };
}

/** Build a typed `conflict` DbError for a failed compare-and-set (idempotent loser). */
export function conflict(message: string): DbError {
  return { code: "conflict", message };
}
