// spec(§12) — UI-SAFE LEAKAGE §12 named suite (Task 8.7 / WS-8 / §10 leakage
// gate). System-under-test = the REAL 8.2 UI-safe projectors and the REAL 8.5
// push stream (which projects through the SAME 8.2 projectors before emitting).
//
// The gate this suite certifies (DoD for phase-exit 8):
//   Drive every projector AND every stream event class with a domain record that
//   carries INJECTED sensitive fields — Keychain references, provider prompts,
//   AgentResult.logs, raw Employer-Work content, secrets — and assert:
//     1. NONE of the 5 sentinel classes appears anywhere in the projected object
//        / stream payload (a deep JSON scan — catches a `...spread` leak under ANY
//        key or nesting);
//     2. the projected field set is a SUBSET of the checked-in `UI_SAFE_ALLOWLIST`
//        (the boundary is the allowlist, not a denylist — an unknown extra key is
//        a leak even if it isn't one of our sentinels);
//     3. the record's own dropped domain fields (actor, payloadHash, message,
//        auditRef(s), …) never cross either.
//   Both the QUERY-response surface (the projectors, 8.3's read model uses them)
//   and the STREAM surface (8.5 emits `tracked(eventId, uiSafePayload)`) are
//   covered — every stream payload is additionally re-validated against the frozen
//   `streamEventSchema` (which is `.strict()` — an extra key would fail parse).
//
// DETERMINISTIC + PURE over the injected SUT. §16: never throws — a throwing case
// folds to a fail.
import {
  UI_SAFE_ALLOWLIST,
  streamEventSchema,
  type StreamEvent,
} from "@sow/contracts";
import {
  toUiSafeApproval,
  toUiSafeHealthItem,
  toUiSafeWorkflowRunRef,
  toUiSafeDashboardCard,
} from "@sow/worker/api/projections/uiSafe";
import { createStreamPublisher } from "@sow/worker/api/stream/eventClasses";
import {
  taintedApproval,
  taintedHealthItem,
  taintedWorkflowRunRef,
  taintedDashboardCard,
  findLeakedSentinel,
  DROPPED_FIELD_NAMES,
} from "./fixtures";
import { expectCase, foldSuite, type SuiteCase, type SuiteResult } from "./suite-core";

export const LEAKAGE_SUITE_NAME = "worker-api-auth.ui-safe-leakage";

/** The sorted field names actually present on a projected object. */
function fieldSet(obj: object): string[] {
  return Object.keys(obj).sort();
}

/** Read an arbitrary (possibly-absent) key off a projected object through `unknown`. */
function asRecord(obj: object): Record<string, unknown> {
  return obj as unknown as Record<string, unknown>;
}

/**
 * Assert a single projected object is UI-safe against `allowed`: (a) no injected
 * sentinel leaked, (b) every present field is on the allowlist, (c) each named
 * dropped field is absent. Emits one case per check under `prefix`.
 */
function assertProjectionSafe(
  prefix: string,
  projected: object,
  allowed: readonly string[],
  dropped: readonly string[],
): SuiteCase[] {
  const cases: SuiteCase[] = [];

  // (a) No injected sentinel (Keychain ref / prompt / log / employer-raw / secret).
  const leaked = findLeakedSentinel(projected);
  cases.push(
    expectCase(
      `${prefix}.no-sentinel`,
      leaked === undefined,
      leaked !== undefined ? `leaked sentinel class: ${leaked}` : "",
    ),
  );

  // (b) Field set is a subset of the allowlist (allowlist IS the boundary).
  const present = fieldSet(projected);
  const extra = present.filter((k) => !allowed.includes(k));
  cases.push(
    expectCase(
      `${prefix}.allowlist-subset`,
      extra.length === 0,
      extra.length > 0 ? `non-allowlisted field(s) crossed: ${extra.join(",")}` : "",
    ),
  );

  // (c) Each named dropped domain field is absent.
  const rec = asRecord(projected);
  const leakedDropped = dropped.filter((name) => Object.prototype.hasOwnProperty.call(rec, name));
  cases.push(
    expectCase(
      `${prefix}.dropped-absent`,
      leakedDropped.length === 0,
      leakedDropped.length > 0 ? `dropped field(s) crossed: ${leakedDropped.join(",")}` : "",
    ),
  );

  return cases;
}

/**
 * Run the UI-SAFE LEAKAGE §12 suite against the REAL projectors + stream. Returns
 * a folded {@link SuiteResult}. Deterministic; never throws (§16).
 */
export function runLeakageSuite(): SuiteResult {
  const cases: SuiteCase[] = [];

  // ── (1) QUERY-response surface — the four 8.2 projectors on TAINTED records ──
  try {
    cases.push(
      ...assertProjectionSafe(
        "leak.query.approval",
        toUiSafeApproval(taintedApproval()),
        UI_SAFE_ALLOWLIST.approval,
        DROPPED_FIELD_NAMES.approval,
      ),
    );
    cases.push(
      ...assertProjectionSafe(
        "leak.query.health",
        toUiSafeHealthItem(taintedHealthItem()),
        UI_SAFE_ALLOWLIST.healthItem,
        DROPPED_FIELD_NAMES.healthItem,
      ),
    );
    cases.push(
      ...assertProjectionSafe(
        "leak.query.workflow",
        toUiSafeWorkflowRunRef(taintedWorkflowRunRef()),
        UI_SAFE_ALLOWLIST.workflowRunRef,
        DROPPED_FIELD_NAMES.workflowRunRef,
      ),
    );
    cases.push(
      ...assertProjectionSafe(
        "leak.query.dashboard",
        toUiSafeDashboardCard(taintedDashboardCard()),
        UI_SAFE_ALLOWLIST.dashboardCard,
        DROPPED_FIELD_NAMES.dashboardCard,
      ),
    );
  } catch {
    cases.push(expectCase("leak.query.threw", false, "a projector threw on a tainted record"));
  }

  // ── (2) STREAM surface — 8.5 emits UI-safe payloads for all 4 event classes ──
  try {
    const pub = createStreamPublisher();
    // Publish each class from a TAINTED source record; capture the emitted event.
    const wf = pub.publishWorkflowStatus(taintedWorkflowRunRef());
    const ap = pub.publishApproval(taintedApproval());
    const hi = pub.publishHealth(taintedHealthItem());
    const rm = pub.publishReadModelChange(taintedDashboardCard());

    const ALLOWLIST_FOR: Record<StreamEvent["name"], readonly string[]> = {
      "workflow.status": UI_SAFE_ALLOWLIST.workflowRunRef,
      "approval.update": UI_SAFE_ALLOWLIST.approval,
      "system.health": UI_SAFE_ALLOWLIST.healthItem,
      "read_model.change": UI_SAFE_ALLOWLIST.dashboardCard,
    };
    const DROPPED_FOR: Record<StreamEvent["name"], readonly string[]> = {
      "workflow.status": DROPPED_FIELD_NAMES.workflowRunRef,
      "approval.update": DROPPED_FIELD_NAMES.approval,
      "system.health": DROPPED_FIELD_NAMES.healthItem,
      "read_model.change": DROPPED_FIELD_NAMES.dashboardCard,
    };

    for (const ev of [wf, ap, hi, rm]) {
      if (ev === undefined) {
        cases.push(expectCase("leak.stream.missing-event", false, "a publish returned no event"));
        continue;
      }
      const prefix = `leak.stream.${ev.name}`;
      // (a)-(c): the payload is a UI-safe projection — same checks as the query surface.
      cases.push(
        ...assertProjectionSafe(prefix, ev.payload, ALLOWLIST_FOR[ev.name], DROPPED_FOR[ev.name]),
      );
      // (d) the WHOLE event re-validates against the frozen strict schema — an
      //     extra key on the payload would fail the `.strict()` parse.
      cases.push(
        expectCase(
          `${prefix}.schema-strict`,
          streamEventSchema.safeParse(ev).success,
          "stream event failed the frozen strict schema (extra/invalid field)",
        ),
      );
    }
  } catch {
    cases.push(expectCase("leak.stream.threw", false, "the stream publisher threw on a tainted record"));
  }

  return foldSuite(LEAKAGE_SUITE_NAME, cases);
}
