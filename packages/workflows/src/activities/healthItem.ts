// @sow/workflows — slice 7.5: the §9 System-Health MATERIALIZER (activity).
//
// This module discharges the Phase-6 carry-forward: a gateway health SIGNAL
// (@sow/integrations emits a pure, clock-free GatewayHealthSignal) is turned into
// a PERSISTED, deduped, lifecycle-carrying HealthItem HERE — §9 owns HealthItem
// materialization (state machine, severity, timestamps, persistence). It is an
// ACTIVITY (it persists through the injected HealthItemStore, which in production
// wraps the P2 operational store — I/O), NOT deterministic workflow code: keep
// this OUT of the Temporal sandbox. It still takes the clock reading as an
// INJECTED value (`now`) rather than calling Date.now(), so its logic is
// deterministic + Vitest-unit-testable with an in-memory store.
//
// RULES (§9.11 / §16 OBS-2):
//   • ONE DISTINCT item per (failureClass, subjectRef) — the dedupe identity.
//   • A RECURRING failure UPDATES the existing OPEN|ACKNOWLEDGED item, never spawns
//     a duplicate. openedAt + id + acknowledged-state are PRESERVED across
//     recurrences (only message/audit/severity refresh).
//   • lifecycle open → acknowledged | resolved. resolved is TERMINAL; resolvedAt
//     is present IFF resolved (the frozen HealthItem.refine invariant).
//   • an item AUTO-RESOLVES when its underlying condition clears (resolveHealthItem);
//     a NEW failure after resolution re-opens a fresh OPEN item (terminal → reopen).
//   • openedAt from the INJECTED clock reading (`now`); severity default 'warn'.
//
// §16 error convention: never throws across the boundary — returns a typed
// Result<T, HealthActivityError> whose `code` is an ENUMERABLE closed set. The
// item is validated through the frozen HealthItemSchema before persistence so a
// malformed candidate becomes a typed err, never a thrown ZodError.
import { ok, err, HealthItemSchema } from "@sow/contracts";
import type { AuditId, FailureClass, HealthItem, Result } from "@sow/contracts";
import type { HealthItemStore } from "../ports/operational";

// --- dedupe identity --------------------------------------------------------

/**
 * The stable dedupe identity for a HealthItem: `failureClass|subjectRef` (§9.11 /
 * §10.3). Two failures of the SAME class + subject coalesce onto ONE item
 * regardless of message/severity/audit. The frozen HealthItem carries no
 * subjectRef field, so the materializer USES this key as the item's `id` — that
 * makes a re-`put` an UPSERT (the store keys on the dedupe key) rather than a
 * duplicate. Pure/deterministic.
 */
export function healthItemDedupeKey(
  failureClass: FailureClass,
  subjectRef: string,
): string {
  return `${failureClass}|${subjectRef}`;
}

/** Conservative default severity (HealthItem.severity is an OPEN string, not an enum). */
export const HEALTH_ITEM_DEFAULT_SEVERITY = "warn" as const;
/** Elevated tiers (the severity vocabulary already in use across the health surfaces). */
const HEALTH_ITEM_SEVERITY_ERROR = "error" as const;
const HEALTH_ITEM_SEVERITY_CRITICAL = "critical" as const;

/**
 * The DEFAULT severity for a HealthItem of a given {@link FailureClass}, applied ONLY when
 * the producer does not supply one (a producer-explicit severity always wins — see
 * {@link materializeHealthItem}). HealthItem.severity is an OPEN string with a flat `warn`
 * fallback and no per-class floor, so a terminal SECURITY / ISOLATION cause would otherwise
 * surface at `warn` (too low). This gives the load-bearing §16 classes a defensible default:
 *   • security_violation / isolation_breach → `critical` (a content-safety/secret/injection
 *     or a workspace-isolation breach — the highest tier).
 *   • policy_denial / egress_denied         → `error`   (a policy/egress refusal).
 *   • every operational class               → `warn`    (unchanged — no regression).
 *
 * EXHAUSTIVE BY DESIGN: the `default` branch's never-assignment (an exhaustiveness check)
 * makes a FUTURE FailureClass member break tsc HERE — so a new class can NEVER silently
 * inherit a benign `warn` default (the §16 no-silent-mis-bucket guard, made tsc-enforced).
 * Pure/deterministic.
 */
export function defaultSeverityForFailureClass(failureClass: FailureClass): string {
  switch (failureClass) {
    case "security_violation":
    case "isolation_breach":
      return HEALTH_ITEM_SEVERITY_CRITICAL;
    case "policy_denial":
    case "egress_denied":
      return HEALTH_ITEM_SEVERITY_ERROR;
    case "connector_unreachable":
    case "write_through_failed":
    case "budget_breach":
    case "missed_or_late_schedule":
    case "schema_rejection":
    case "worker_down":
    case "parity_defect":
    case "conflict_review":
    case "sync_lagging":
    case "rebuild_divergence":
      return HEALTH_ITEM_DEFAULT_SEVERITY;
    default: {
      // A new FailureClass member reaches here as a non-`never` type → tsc error, forcing
      // a deliberate severity decision above. The runtime fallback stays conservative.
      const _exhaustive: never = failureClass;
      void _exhaustive;
      return HEALTH_ITEM_DEFAULT_SEVERITY;
    }
  }
}

// --- typed, enumerable error surface (§16) ---------------------------------

/** Closed, enumerable failure taxonomy for the materializer (never thrown). */
export type HealthActivityErrorCode =
  | "invalid_item" // the built candidate failed the frozen HealthItemSchema
  | "persist_failed"; // the injected store rejected the read/write

export interface HealthActivityError {
  readonly code: HealthActivityErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

const fail = (
  code: HealthActivityErrorCode,
  message: string,
  cause?: unknown,
): Result<never, HealthActivityError> => err({ code, message, cause });

// --- inputs -----------------------------------------------------------------

/**
 * A single failure occurrence to materialize into a HealthItem. `now` is the
 * INJECTED clock reading (ISO-8601) — no Date.now() here. `severity` is optional;
 * when omitted it defaults per {@link defaultSeverityForFailureClass} for the item's
 * class (elevated for the §16 security/isolation/policy/egress classes, `warn` otherwise).
 */
export interface MaterializeHealthItemInput {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
  readonly now: string;
}

/** The dedupe identity of an item to resolve/acknowledge (no message needed). */
export interface HealthItemRef {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
}

// --- internals --------------------------------------------------------------

/** Load the current item under a dedupe key; a store rejection becomes a typed err. */
async function loadCurrent(
  dedupeKey: string,
  store: HealthItemStore,
): Promise<Result<HealthItem | undefined, HealthActivityError>> {
  try {
    return ok(await store.getByDedupeKey(dedupeKey));
  } catch (cause) {
    return fail("persist_failed", "failed to read the current health item", cause);
  }
}

/** Persist an item; a store rejection becomes a typed err (§16 — no throw). */
async function persist(
  item: HealthItem,
  store: HealthItemStore,
): Promise<Result<HealthItem, HealthActivityError>> {
  try {
    await store.put(item);
    return ok(item);
  } catch (cause) {
    return fail("persist_failed", "failed to persist the health item", cause);
  }
}

/** Validate a candidate through the frozen schema (a bad shape → typed err, not a throw). */
function validate(candidate: HealthItem): Result<HealthItem, HealthActivityError> {
  const parsed = HealthItemSchema.safeParse(candidate);
  if (!parsed.success) {
    return fail(
      "invalid_item",
      `built health item failed the frozen HealthItemSchema: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return ok(parsed.data);
}

/** True IFF the item is in a TERMINAL state (resolved has no outgoing edge). */
function isTerminal(item: HealthItem): boolean {
  return item.state === "resolved";
}

// --- materializeHealthItem (open / recurrence) -----------------------------

/**
 * Materialize a failure occurrence into a persisted HealthItem (OPEN on first
 * sight; an in-place UPDATE on recurrence). Behavior by current item state:
 *   • absent OR terminal (resolved): OPEN a FRESH item (openedAt = `now`,
 *     state = 'open'). Terminal is reopened — resolved is terminal, so a new
 *     failure starts a new lifecycle under the same dedupe key.
 *   • open|acknowledged: UPDATE in place — PRESERVE id + openedAt + state (an
 *     acknowledged item stays acknowledged; a recurrence does NOT reopen it to
 *     'open'); refresh message + auditRef + severity to the latest occurrence.
 * Never throws (§16); the built item is schema-validated before persistence.
 */
export async function materializeHealthItem(
  input: MaterializeHealthItemInput,
  store: HealthItemStore,
): Promise<Result<HealthItem, HealthActivityError>> {
  const dedupeKey = healthItemDedupeKey(input.failureClass, input.subjectRef);

  const loaded = await loadCurrent(dedupeKey, store);
  if (!loaded.ok) return loaded;
  const current = loaded.value;

  // Producer-explicit severity wins; otherwise the per-class default elevates the
  // load-bearing §16 classes (security/isolation → critical, policy/egress → error).
  const severity = input.severity ?? defaultSeverityForFailureClass(input.failureClass);

  let candidate: HealthItem;
  if (current === undefined || isTerminal(current)) {
    // First sight, or a reopen after a terminal (resolved) lifecycle.
    candidate = {
      id: dedupeKey,
      failureClass: input.failureClass,
      severity,
      message: input.message,
      auditRef: input.auditRef,
      openedAt: input.now,
      state: "open",
      // NOTE: no resolvedAt — the reopened item is fresh + open.
    };
  } else {
    // Recurrence of an open|acknowledged item: update in place, PRESERVE id +
    // openedAt + state (acknowledged stays acknowledged); refresh the details.
    candidate = {
      ...current,
      failureClass: input.failureClass,
      severity,
      message: input.message,
      auditRef: input.auditRef,
      // openedAt, id, state preserved from `current`.
    };
  }

  const valid = validate(candidate);
  if (!valid.ok) return valid;
  return persist(valid.value, store);
}

// --- resolveHealthItem (auto-resolve on clear) -----------------------------

/**
 * Auto-resolve the item under (failureClass, subjectRef) when its underlying
 * condition clears (e.g. a connector reconnects). Idempotent:
 *   • no item under the key → no-op success (returns `ok(undefined)`): a clear
 *     for a condition that never opened an item is not an error.
 *   • already resolved (terminal) → no-op success returning the existing item;
 *     resolvedAt is NOT overwritten (terminal is immutable).
 *   • open|acknowledged → set state='resolved' + resolvedAt=`input.now`.
 * Never throws (§16); the resolved item is schema-validated (resolvedAt IFF resolved).
 */
export async function resolveHealthItem(
  input: HealthItemRef & { readonly now: string },
  store: HealthItemStore,
): Promise<Result<HealthItem | undefined, HealthActivityError>> {
  const dedupeKey = healthItemDedupeKey(input.failureClass, input.subjectRef);

  const loaded = await loadCurrent(dedupeKey, store);
  if (!loaded.ok) return loaded;
  const current = loaded.value;

  if (current === undefined) return ok(undefined);
  if (isTerminal(current)) return ok(current);

  const candidate: HealthItem = {
    ...current,
    state: "resolved",
    resolvedAt: input.now,
  };
  const valid = validate(candidate);
  if (!valid.ok) return valid;
  return persist(valid.value, store);
}

// --- acknowledgeHealthItem (operator ack) ----------------------------------

/**
 * Acknowledge the OPEN item under (failureClass, subjectRef) — the operator has
 * seen it but it is not yet resolved. Idempotent:
 *   • no item → no-op success (`ok(undefined)`).
 *   • already resolved (terminal) → no-op success returning the existing item.
 *   • open|acknowledged → set state='acknowledged' (no resolvedAt).
 * Never throws (§16); the acknowledged item is schema-validated.
 */
export async function acknowledgeHealthItem(
  input: HealthItemRef,
  store: HealthItemStore,
): Promise<Result<HealthItem | undefined, HealthActivityError>> {
  const dedupeKey = healthItemDedupeKey(input.failureClass, input.subjectRef);

  const loaded = await loadCurrent(dedupeKey, store);
  if (!loaded.ok) return loaded;
  const current = loaded.value;

  if (current === undefined) return ok(undefined);
  if (isTerminal(current)) return ok(current);

  const candidate: HealthItem = { ...current, state: "acknowledged" };
  const valid = validate(candidate);
  if (!valid.ok) return valid;
  return persist(valid.value, store);
}
