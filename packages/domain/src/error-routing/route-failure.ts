// 10.2 — error-handling convention: typed-Result failure taxonomy +
// nothing-fails-silently routing (§16 error convention; ARCHITECTURE.md §16
// "Error-handling convention").
//
// Every cross-subsystem operation returns `Result<T, FailureVariant>` (never a
// throw across a §16 boundary). `routeFailure` is the CANONICAL, PURE routing
// rule that takes each `FailureVariant` and decides its destination:
//   - `retryable`   → the caller/workflow re-drives the operation (bounded
//                     backoff owned by the retry layer, task 10.5).
//   - `toOutbox`    → the pending side effect is HELD in the write-outbox
//                     (operational store, P2) instead of being lost — replayed
//                     later via the §8 external-write envelope (no dup write).
//   - `healthClass` → an OBS-2 System-Health `HealthItem` (task 10.3) is
//                     surfaced under this `FailureClass`, deduped by
//                     (failureClass, subjectRef) at the surface layer.
//
// THE LOAD-BEARING INVARIANT (enforced by this function, not by convention):
// EVERY variant routes to retry OR outbox OR a health item — there is NO
// variant that neither retries nor surfaces. "Nothing fails silently" is a
// property of the table below, asserted exhaustively in the test. A variant
// with no health class (provider_failed, write_conflict) is documented as
// retry/outbox-only and still routes somewhere.
//
// TAXONOMY SYNC. `FailureVariantKind` (the operation-result taxonomy) and
// `FailureClass` (the OBS-2 System-Health taxonomy) are DIFFERENT, deliberately.
// This function is the single place their mapping lives; keeping the two enums
// in sync means: if a new `FailureVariantKind` is added, TypeScript's exhaustive
// `switch` (the `never` default) FAILS TO COMPILE until this table is extended —
// so a new variant can never silently route to nowhere.
//
// PURE + TOTAL + DETERMINISTIC: routes solely on `variant.kind` — no clock, no
// random, no I/O, no dependence on `message`/`cause`/the variant's own
// `retryable` hint. Identical `kind` ⇒ identical route (replay-safe). PURE root
// of the §2.5 DAG: imports only frozen `@sow/contracts` types.
import type { FailureVariant, FailureVariantKind, FailureClass } from "@sow/contracts";

/**
 * The routing decision for a {@link FailureVariant}. `healthClass` is present
 * only for variants that surface a System-Health item; its ABSENCE means the
 * variant is retry/outbox-only (still routed — see the totality invariant).
 */
export interface FailureRoute {
  /** The operation should be re-driven (retry layer owns backoff). */
  readonly retryable: boolean;
  /** The pending side effect is held in the write-outbox (operational store, P2). */
  readonly toOutbox: boolean;
  /** OBS-2 System-Health class (task 10.3), or absent for retry/outbox-only variants. */
  readonly healthClass?: FailureClass;
}

/**
 * Route a {@link FailureVariant} to its destination(s). PURE + TOTAL: the
 * exhaustive `switch` (with a `never`-typed default) guarantees every current
 * and future `FailureVariantKind` is handled — a new kind breaks compilation
 * here rather than routing to nowhere. Every returned route satisfies the
 * totality invariant `retryable || toOutbox || healthClass !== undefined`.
 */
export function routeFailure(variant: FailureVariant): FailureRoute {
  const kind: FailureVariantKind = variant.kind;
  switch (kind) {
    // Candidate-data gate reject (REQ-S-006). Re-running the SAME input re-fails,
    // so NOT retryable; surfaced as a schema-rejection health item so the reject
    // is never silently dropped.
    case "validation_rejected":
      return { retryable: false, toOutbox: false, healthClass: "schema_rejection" };

    // Transient provider/runtime error. Re-drivable (retry covers it); no
    // distinct health class needed unless it escalates to a degraded mode.
    // Retry-only — still routes somewhere.
    case "provider_failed":
      return { retryable: true, toOutbox: false };

    // COST-1 budget breach → the job is cancelled (not retryable) and MUST be
    // surfaced so the owner sees the cap was hit.
    case "budget_exceeded":
      return { retryable: false, toOutbox: false, healthClass: "budget_breach" };

    // Connector outage (§16 sync). Inbound syncs queue + retry with backoff; a
    // pending WRITE-through is held in the outbox for envelope replay; the
    // outage is surfaced. All three destinations.
    case "connector_unreachable":
      return { retryable: true, toOutbox: true, healthClass: "connector_unreachable" };

    // Stale-base concurrent write (§16 write-through). Re-plan against the new
    // base revision (retryable) and hold the pending write in the outbox; no
    // distinct health class — a conflict is expected/self-healing, not an
    // operational alarm. Retry/outbox-only — still routes somewhere.
    case "write_conflict":
      return { retryable: true, toOutbox: true };

    // Provider output failed the JSON-Schema gate. Same input re-fails → NOT
    // retryable; surfaced as a schema-rejection health item.
    case "schema_rejected":
      return { retryable: false, toOutbox: false, healthClass: "schema_rejection" };

    // First-class degraded mode (task 10.5: Temporal-unavailable / Keychain-
    // locked). Dependent jobs are HELD retryable (never failed_terminal, so no
    // work is lost) and the degraded state is surfaced as a worker-down health
    // item; auto-clears when the underlying condition resolves.
    case "degraded_unavailable":
      return { retryable: true, toOutbox: false, healthClass: "worker_down" };

    default: {
      // Exhaustiveness guard: a new FailureVariantKind must extend this table.
      // This line fails to type-check (assignment to `never`) if a kind is
      // unhandled — the compile-time enforcement of "nothing routes to nowhere".
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
