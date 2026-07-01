// SQLite adapter — driver-error → typed DbError mapping (task 2.3, §16 error
// convention). The adapter NEVER throws across a repository boundary: every
// `better-sqlite3` driver throw is caught and translated into a `DbError` whose
// `code` is drawn from the closed `DbErrorCode` set (repositories/interfaces.ts).
// Mapping the driver's own `SQLITE_*` error codes keeps the underlying cause
// opaque to callers (they depend on the taxonomy, never on `better-sqlite3`).
import type { DbError, DbErrorCode } from "../../repositories/interfaces";

/** Minimal structural view of a `better-sqlite3` SqliteError (carries `.code`). */
interface DriverErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
}

/** Map a raw `better-sqlite3` error code to the closed DbError taxonomy. */
function mapDriverCode(raw: unknown): DbErrorCode {
  if (typeof raw !== "string") return "unknown";
  // PK/unique violations are optimistic-concurrency / duplicate-key conflicts.
  if (raw.includes("CONSTRAINT_PRIMARYKEY") || raw.includes("CONSTRAINT_UNIQUE")) {
    return "conflict";
  }
  // Any other integrity constraint (NOT NULL / CHECK / FK) is a constraint failure.
  if (raw.startsWith("SQLITE_CONSTRAINT")) return "constraint_violation";
  // Contention — retry-able (§4 serialization_failure).
  if (raw === "SQLITE_BUSY" || raw === "SQLITE_LOCKED") return "serialization_failure";
  // The store itself is not reachable / not a DB (§4 degraded mode signal).
  if (raw === "SQLITE_CANTOPEN" || raw === "SQLITE_IOERR" || raw === "SQLITE_NOTADB" || raw === "SQLITE_READONLY") {
    return "unavailable";
  }
  return "unknown";
}

/** Translate any caught driver throw into a typed DbError (never re-throws). */
export function toDbError(cause: unknown, fallbackMessage = "sqlite operation failed"): DbError {
  const driver = cause as DriverErrorLike;
  const code = mapDriverCode(driver?.code);
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
