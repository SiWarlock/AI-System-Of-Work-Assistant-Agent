// @sow/workflows — task 7.15: CONNECTOR SYNC & HEALTH — the PURE orchestration DRIVER.
//
// A sibling of the 7.6 meeting-closeout / 7.10 daily-brief drivers: the deterministic
// control driver that progresses a connector-sync run THROUGH a local
// connectorSyncHealthMachine (no illegal edges; every transition guarded) over the
// INJECTED activity ports, the injected Clock, the 7.5 health sink, and the 7.4
// idempotency seam (resolveRun). It reuses the 7.2 durable-schedule catch-up
// (collapsedNextRunFromClock) so a missed/late scheduled poll COLLAPSES to ONE run
// (LIFE-2) rather than a thundering herd, and the 7.3 wake hook (a reconnect trigger
// DRAINS held outbox work before polling — LIFE-6).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio NOR
// node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive through the
// injected ports + Clock, so it is Vitest-unit-testable with no Temporal server and
// safe to wrap in a thin @temporalio workflow later (that wrapper + its SOW_TEMPORAL
// integration test are the worker-wiring wave's job — NOT this file). The Connector
// Gateway (runConnectorSync — node:crypto-free but transport-bound) lives BEHIND the
// injected {@link ConnectorPollPort}, implemented in the src/activities/connectorPoll.ts
// ACTIVITY; the driver only RECEIVES the typed {@link ConnectorPollResult}.
//
// The local connectorSyncHealthMachine (defined here via the @sow/domain
// `defineMachine` primitive — @sow/domain ships no connector-sync machine, so this
// workflow owns its state alphabet, matching how daily-brief defines its own) is PURE
// + TOTAL: legal edges return ok(to), illegal edges return a typed err — never throws.
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every
// typed port rejection / degraded poll onto a distinct machine failure STATE and
// routes it through the health sink (inv-5: nothing fails silently).
//
// 7.15 safety invariants this driver makes true (REQ-I-005 / LIFE-4 / LIFE-2 / LIFE-6):
//   inv-1  NO SILENT DROP (REQ-I-005): the persisted cursor advances ONLY after a
//          connector's page is SUCCESSFULLY processed. This is a property of the
//          Connector Gateway (runConnectorSync) BEHIND the poll port — a `held`/
//          `degraded` poll leaves the cursor put, so unprocessed work is re-fetched
//          next pass, never skipped. The driver NEVER advances a cursor itself.
//   inv-2  UNREACHABLE branch (LIFE-4): a connector whose poll is `held`/`degraded`
//          (or whose poll activity errored) is QUEUED for retry with bounded
//          exponential backoff (owned by the gateway/outbox), is marked DEGRADED via
//          the 7.5 health sink (a connector_unreachable item), and is NEVER silently
//          dropped. The degraded-health signal + the queued set are derived from the
//          ACTUAL {@link ConnectorPollResult} that flowed from the poll — never a
//          decoy descriptor field (the bug-class prior verify passes caught).
//   inv-3  RECONNECT DRAIN (LIFE-6): a wake/reconnect trigger (connector_event /
//          hermes_automation / owner_action) DRAINS held outbox work through the §8
//          replay-safe drain BEFORE polling — a re-drive reuses receipts, so no
//          duplicate external write. A pure `schedule` trigger does NOT drain.
//   inv-4  IDEMPOTENT RE-POLL: because the gateway advances the cursor only on
//          success and dedupes by contentHash, a re-poll does NOT reprocess
//          already-cursored items — the driver re-drives the SAME poll and the
//          gateway is the idempotency backstop. resolveRun (7.4) reuses a seen run.
//   inv-5  LIFE-2 collapse: a missed/late scheduled poll collapses to ONE run on
//          wake (collapsedNextRunFromClock); nothing due ⇒ park in no_run_due with
//          NO poll + NO durable write. EVERY failure/park class surfaces a distinct
//          7.5 health item.
import { isOk, ok } from "@sow/contracts";
import type {
  Result,
  WorkflowRunRef,
  FailureClass,
  AuditId,
} from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type { DrainResult } from "@sow/integrations";
import type { Clock, WorkflowRunRefRepository, ScheduleStore } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import { collapsedNextRunFromClock } from "../runtime/catchUpWindow";
import { advanceBookkeeping } from "../runtime/clock";

// ---------------------------------------------------------------------------
// (1) The local connector-sync-health state machine
// ---------------------------------------------------------------------------

/** The full connector-sync-health state alphabet. */
export const CONNECTOR_SYNC_HEALTH_STATES = [
  // happy path
  "scheduled",
  "drained", // (only on a wake trigger) held outbox work drained
  "polling",
  "synced",
  // failure / park
  "no_run_due", // LIFE-2: nothing due this wake — no poll
  "connector_degraded", // LIFE-4: ≥1 connector held/degraded — queued + degraded
  // terminal
  "done",
] as const;

/** A connector-sync-health state (element of {@link CONNECTOR_SYNC_HEALTH_STATES}). */
export type ConnectorSyncHealthState = (typeof CONNECTOR_SYNC_HEALTH_STATES)[number];

// Adjacency table. Terminal `done` maps to []. Each non-terminal state carries ≥1
// outgoing edge so the machine is total; the driver walks only the happy edges +
// the pinned park/failure-entry edges.
const CONNECTOR_SYNC_HEALTH_TRANSITIONS: Readonly<
  Record<ConnectorSyncHealthState, readonly ConnectorSyncHealthState[]>
> = {
  // scheduled → drain (wake) OR poll (schedule) OR park (nothing due, LIFE-2).
  scheduled: ["drained", "polling", "no_run_due"],
  // drained → poll (a wake always polls after draining held work).
  drained: ["polling"],
  // polling → all connectors synced, OR ≥1 connector degraded/held.
  polling: ["synced", "connector_degraded"],
  // synced → done.
  synced: ["done"],
  // park / recovery back-edges (non-terminal → ≥1 outgoing edge).
  no_run_due: ["scheduled"],
  // a degraded run is retried on the next wake — the connector stays queued.
  connector_degraded: ["polling"],
  // terminal
  done: [],
};

/** The connector-sync-health state machine (the small guard every transition routes through). */
export const connectorSyncHealthMachine: StateMachine<ConnectorSyncHealthState> =
  defineMachine<ConnectorSyncHealthState>(CONNECTOR_SYNC_HEALTH_TRANSITIONS);

// ---------------------------------------------------------------------------
// (2) The activity ports (declared here — the driver's narrow injected seam)
// ---------------------------------------------------------------------------

/**
 * One connector this run polls: the connectorId + the workspace it reads for (WS-2:
 * the sync is workspace-scoped — a connector is polled per (connectorId, workspaceId)).
 */
export interface ConnectorTarget {
  readonly connectorId: string;
  readonly workspaceId: string;
}

/**
 * The typed outcome of ONE connector poll — a driver-facing projection of the §8
 * `ConnectorSyncResult` the {@link ConnectorPollPort} activity produced by driving
 * `runConnectorSync`. It carries the ACTUAL reachability verdict + cursor progress:
 *   • `status: 'advanced'` — every fetched page committed; the cursor moved forward.
 *   • `status: 'held'`     — a consumer failure / auth-locked stopped the pass; the
 *                            cursor is UNCHANGED (reads retried later — no drop).
 *   • `status: 'degraded'` — transient fetch errors exhausted retries; cursor
 *                            unchanged, a reachability signal emitted.
 * `cursorAdvanced` mirrors REQ-I-005: it is true ONLY on `advanced` (the gateway
 * advanced + persisted the cursor); the driver NEVER sets a cursor itself. `processed`
 * counts records the consumer accepted. `healthReason` is the redaction-safe reason a
 * held/degraded outcome carries (from the §8 GatewayHealthSignal message).
 */
export interface ConnectorPollResult {
  readonly connectorId: string;
  readonly status: "advanced" | "held" | "degraded";
  readonly processed: number;
  /** REQ-I-005: true ONLY when the gateway advanced + persisted the cursor (status advanced). */
  readonly cursorAdvanced: boolean;
  readonly cursor?: string;
  /** Redaction-safe reason for a held/degraded outcome (from the §8 health signal). */
  readonly healthReason?: string;
}

/** Closed, enumerable poll-PORT failure set (§16 — never thrown by the activity). */
export type ConnectorPollErrorCode = "poll_failed" | "cursor_read_failed";

/** A typed poll-port error (the poll ACTIVITY itself failed — not a degraded read). */
export interface ConnectorPollError {
  readonly code: ConnectorPollErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Poll ONE connector through the §8 Connector Gateway (`runConnectorSync`). The
 * activity resumes from the persisted cursor, drives pages, and advances the cursor
 * ONLY after each page's records are successfully processed (REQ-I-005 — owned by the
 * gateway, NOT the driver). It returns the ACTUAL {@link ConnectorPollResult} (the
 * gateway's reachability verdict + cursor progress) on a completed pass; a poll-port
 * error is only for an activity-level failure (e.g. the gateway crashed). Never throws.
 */
export interface ConnectorPollPort {
  poll(
    connector: ConnectorTarget,
  ): Promise<Result<ConnectorPollResult, ConnectorPollError>>;
}

/** Closed, enumerable wake-drain failure set (§16 — never thrown). */
export interface WakeDrainError {
  readonly code: "drain_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Drain the held outbox on a reconnect/wake (LIFE-6). Backed by the §8 replay-safe
 * drain (drainOutbox via the 7.3 runWakeDrain) — a re-drive reuses each held entry's
 * receipt, so no duplicate external write results. Returns the typed drain counts.
 * Never throws.
 */
export interface WakeDrainPort {
  drain(): Promise<Result<DrainResult, WakeDrainError>>;
}

/**
 * A connector-sync-health failure to surface (inv-2/inv-5). Structurally a subset of
 * the 7.5 `WorkflowFailure` seam — the driver routes EVERY failure/park class through
 * the sink so nothing fails silently (inv-5 / §16).
 */
export interface ConnectorSyncHealthFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface ConnectorSyncHealthSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface ConnectorSyncHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every connector-sync-health failure class
 * through (inv-5). In production this is backed by the 7.5 `surfaceWorkflowFailure`
 * (HealthItemStore + outbox); the driver depends only on this narrow port so it stays
 * pure + injected-testable. Never throws.
 */
export interface ConnectorSyncHealthHealthSink {
  surface(
    failure: ConnectorSyncHealthFailure,
  ): Promise<Result<ConnectorSyncHealthSurfaceOutcome, ConnectorSyncHealthSinkError>>;
}

// ---------------------------------------------------------------------------
// (3) The driver input + deps + outcome
// ---------------------------------------------------------------------------

/**
 * The complete input to {@link runConnectorSyncHealth}. `run` is the trigger
 * submission resolved idempotently through the 7.4 seam (its `trigger` selects the
 * wake-vs-schedule behavior). `scheduleId`/`intervalMs`/`catchUpWindowMs` drive the
 * 7.2 collapsed catch-up (LIFE-2). `connectors` is the set to poll this run (each
 * workspace-scoped, WS-2). No cursor is caller-supplied — the persisted cursor is the
 * only source of resume position (REQ-I-005 idempotency).
 */
export interface ConnectorSyncHealthInput {
  readonly run: ResolveRunInput;
  readonly scheduleId: string;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly connectors: readonly ConnectorTarget[];
}

/**
 * The injected dependency set: the poll port, the wake-drain port, the 7.5 health
 * sink, the 7.4 WorkflowRun repository (resolveRun), the 7.2 durable-schedule store,
 * and the injected Clock. Every dependency is a narrow port so the driver stays pure
 * and fully injected-testable (no Connector Gateway / outbox / Temporal).
 */
export interface ConnectorSyncHealthDeps {
  readonly poll: ConnectorPollPort;
  readonly wakeDrain: WakeDrainPort;
  readonly health: ConnectorSyncHealthHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly schedule: ScheduleStore;
  readonly clock: Clock;
}

/**
 * The result of a connector-sync-health drive. `state` is the machine state the
 * pipeline rested in (`done`, `no_run_due`, or `connector_degraded`). `run` is the
 * resolveRun result; `runReused` mirrors its `reused` flag. `collapsed` is true when
 * MORE THAN ONE missed occurrence folded into the single run (LIFE-2). `synced` /
 * `degradedConnectors` list the connectors that advanced vs. were queued (never
 * dropped — inv-2). `drainResult` is present on a wake trigger (LIFE-6). `surfaced`
 * names the health failure routed on a failure/park branch. Never throws.
 */
export interface ConnectorSyncHealthOutcome {
  readonly state: ConnectorSyncHealthState;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly collapsed: boolean;
  readonly syncedConnectors: readonly string[];
  readonly degradedConnectors: readonly string[];
  readonly drainResult?: DrainResult;
  readonly surfaced?: ConnectorSyncHealthFailure;
}

// ---------------------------------------------------------------------------
// (4) helpers
// ---------------------------------------------------------------------------

/**
 * Advance the local machine cursor through an ORDERED list of successor states,
 * asserting each edge is legal. The domain machine is pure + total (never throws); an
 * illegal edge stops the cursor at the last legal state rather than crashing, keeping
 * the driver total (§16). Returns the last legal state reached.
 */
function advance(
  from: ConnectorSyncHealthState,
  through: readonly ConnectorSyncHealthState[],
): ConnectorSyncHealthState {
  let cursor = from;
  for (const to of through) {
    const step = connectorSyncHealthMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

/**
 * The closed set of WAKE triggers (LIFE-6). A `schedule` trigger is a plain periodic
 * run (no drain); any other trigger is a wake/reconnect that DRAINS held outbox work
 * before polling.
 */
function isWakeTrigger(trigger: string): boolean {
  return trigger !== "schedule";
}

// ---------------------------------------------------------------------------
// (5) the driver
// ---------------------------------------------------------------------------

/**
 * Run the connector-sync-health pipeline as a pure, replay-safe driver.
 *
 * Order (each durable step keyed for idempotent replay — inv-4):
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run.
 *   2. LIFE-2 catch-up: collapse the (possibly many) missed occurrences to a single
 *      run via collapsedNextRunFromClock. Nothing due ⇒ park in no_run_due (NO poll,
 *      NO durable write). One-or-many due ⇒ one run (`collapsed` iff >1).
 *   3. LIFE-6: on a WAKE trigger, DRAIN held outbox work through the §8 replay-safe
 *      drain BEFORE polling (a re-drive reuses receipts → no duplicate write).
 *   4. Poll each connector through the gateway (runConnectorSync behind the port).
 *      The gateway advances the cursor ONLY on a successful page (REQ-I-005 — the
 *      driver NEVER advances a cursor). A `held`/`degraded` poll (or a poll-port
 *      error) QUEUES that connector for retry + marks it DEGRADED via the 7.5 sink,
 *      derived from the ACTUAL poll result (inv-2 — never a decoy field).
 *   5. If any connector was degraded ⇒ rest in connector_degraded (surfaced). Else
 *      advance the durable schedule bookkeeping + terminal done.
 *
 * Every failure/park branch routes through the health sink (inv-5). Never throws.
 */
export async function runConnectorSyncHealth(
  input: ConnectorSyncHealthInput,
  deps: ConnectorSyncHealthDeps,
): Promise<ConnectorSyncHealthOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the run.
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let state: ConnectorSyncHealthState = "scheduled";
  let collapsed = false;
  const syncedConnectors: string[] = [];
  const degradedConnectors: string[] = [];
  let drainResult: DrainResult | undefined;

  const surface = async (
    failState: ConnectorSyncHealthState,
    message: string,
  ): Promise<ConnectorSyncHealthOutcome> => {
    const failure: ConnectorSyncHealthFailure = {
      failureClass: failureClassFor(failState),
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route through the health sink — nothing fails silently (inv-5). Even if the
    // sink itself errors we still return the failure state (fail-closed).
    await deps.health.surface(failure);
    return {
      state: failState,
      run: runResult,
      runReused,
      collapsed,
      syncedConnectors,
      degradedConnectors,
      ...(drainResult !== undefined ? { drainResult } : {}),
      surfaced: failure,
    };
  };

  // 2. LIFE-2 catch-up: collapse missed occurrences to a SINGLE run. On the very
  //    first run (no bookkeeping) treat the run as due (seed happens at the end). If
  //    bookkeeping exists, ask the 7.2 catch-up whether anything is due.
  const bookkeeping = await deps.schedule.getBookkeeping(input.scheduleId);
  if (bookkeeping !== undefined) {
    const catchUp = collapsedNextRunFromClock(bookkeeping, deps.clock, {
      intervalMs: input.intervalMs,
      catchUpWindowMs: input.catchUpWindowMs,
    });
    if (catchUp.nextRun === null) {
      // Nothing catchable is due — park in no_run_due with NO poll + NO durable write.
      state = advance(state, ["no_run_due"]);
      return surface(state, "no connector-sync run due — schedule not yet elapsed");
    }
    collapsed = catchUp.collapsed;
  }

  // 3. LIFE-6: on a WAKE trigger, drain held outbox work BEFORE polling so held
  //    inbound/outbound work resumes on reconnect. The §8 drain is replay-safe — a
  //    re-drive reuses each held entry's receipt (no duplicate external write). A
  //    drain failure is surfaced but does NOT block the poll (held work stays queued
  //    for the next wake — never dropped).
  if (isWakeTrigger(input.run.trigger)) {
    const drained = await deps.wakeDrain.drain();
    if (isOk(drained)) {
      drainResult = drained.value;
    } else {
      const drainFailure: ConnectorSyncHealthFailure = {
        failureClass: "write_through_failed",
        subjectRef: input.run.workflowId,
        message: `wake drain failed (held work stays queued): ${drained.error.code}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      };
      await deps.health.surface(drainFailure);
      // fall through — the poll still runs; held work is re-drivable next wake.
    }
    state = advance(state, ["drained"]);
  }

  // 4. Poll each connector through the gateway. The gateway advances the cursor ONLY
  //    on a successful page (REQ-I-005) — the driver reads the ACTUAL poll result and
  //    NEVER sets a cursor itself. A held/degraded/errored poll QUEUES the connector
  //    for retry + marks it DEGRADED via the 7.5 sink, derived from the ACTUAL result.
  state = advance(state, ["polling"]);
  for (const connector of input.connectors) {
    const polled = await deps.poll.poll(connector);
    if (!isOk(polled)) {
      // The poll ACTIVITY itself failed (e.g. the gateway crashed) — treat as an
      // unreachable connector: queue + degraded (never a silent drop).
      degradedConnectors.push(connector.connectorId);
      await deps.health.surface({
        failureClass: "connector_unreachable",
        subjectRef: connector.connectorId,
        message: `connector ${connector.connectorId} poll failed: ${polled.error.code}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      });
      continue;
    }
    const result = polled.value;
    // Branch on the ACTUAL dispatched status (the gateway's verdict), NOT a decoy
    // descriptor — this is the governance pin (inv-2). A held/degraded poll left the
    // cursor put (REQ-I-005: no silent drop); the connector is QUEUED for retry.
    if (result.status === "advanced") {
      syncedConnectors.push(result.connectorId);
    } else {
      degradedConnectors.push(result.connectorId);
      await deps.health.surface({
        failureClass: "connector_unreachable",
        subjectRef: result.connectorId,
        message: `connector ${result.connectorId} ${result.status} (queued for retry): ${result.healthReason ?? "no reason"}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      });
    }
  }

  // 5. If any connector was degraded/held ⇒ rest in connector_degraded (already
  //    surfaced above). It is retried on the next wake (the connector stays queued —
  //    never dropped). Otherwise the run is fully synced → advance bookkeeping + done.
  if (degradedConnectors.length > 0) {
    state = advance(state, ["connector_degraded"]);
    return {
      state,
      run: runResult,
      runReused,
      collapsed,
      syncedConnectors,
      degradedConnectors,
      ...(drainResult !== undefined ? { drainResult } : {}),
    };
  }

  state = advance(state, ["synced"]);
  // Advance the durable schedule bookkeeping to this run. Idempotent at a fixed clock
  // reading (7.2), so a replay is a no-op.
  await deps.schedule.put(advanceBookkeeping(input.scheduleId, deps.clock));
  state = advance(state, ["done"]);
  return {
    state,
    run: runResult,
    runReused,
    collapsed,
    syncedConnectors,
    degradedConnectors,
    ...(drainResult !== undefined ? { drainResult } : {}),
  };
}

// --- failure-class mapping (inv-5: distinct health item per failure class) --

/** Map a connector-sync-health failure/park state to a §16 FailureClass. */
function failureClassFor(state: ConnectorSyncHealthState): FailureClass {
  switch (state) {
    case "connector_degraded":
      return "connector_unreachable";
    case "no_run_due":
      return "missed_or_late_schedule";
    default:
      return "write_through_failed";
  }
}

// Re-export the drain-result type consumers may reference on the outcome.
export type { DrainResult };
