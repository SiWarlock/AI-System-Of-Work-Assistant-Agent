// @sow/workflows — task 7.16: NOTEBOOKLM MANAGED-DOC SYNC — PURE orchestration DRIVER.
//
// A sibling of the 7.15 connector-sync / 7.6 meeting-closeout drivers: the deterministic
// control driver progresses a notebooklm.sync run THROUGH a local notebookLmSyncMachine
// (no illegal edges; every transition guarded) over INJECTED activity ports, the injected
// Clock, the 7.5 health sink, and the 7.4 idempotency seam (resolveRun).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio NOR
// node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive through the
// injected ports + Clock, so it is Vitest-unit-testable with no Temporal server and safe
// to wrap in a thin @temporalio workflow later (that wrapper + its SOW_TEMPORAL integration
// test are the worker-wiring wave's job — NOT this file). Per-slot canonicalObjectKey /
// idempotencyKey are computed inside the Phase-6 NotebookPort (node:crypto lives there),
// which the driver reaches through the injected {@link NotebookSyncPort}. The assembled
// managed-doc bodies are DERIVED (by the injected {@link AssembleDocsPort} activity) FROM
// COMMITTED Markdown — the canonical, already-validated truth — never caller-supplied; the
// driver has no bodies input at all, so a caller cannot smuggle un-committed content into
// a managed doc.
//
// 7.16 safety invariants this driver makes true (REQ-I-004 / NLM-2):
//   inv-1  DERIVE-FROM-COMMITTED: the five managed-doc bodies (00 Brief / 01 Decisions /
//          02 Meeting Digest / 03 Research / 04 Open Questions) are ASSEMBLED from
//          COMMITTED Markdown for the BOUND workspace/project — never accepted from the
//          caller — so a managed doc always mirrors the canonical semantic truth.
//   inv-2  UPSERT-THROUGH-THE-GATEWAY: each slot upserts by canonical key (pre-write
//          existence check) ONLY through the Tool Gateway / NotebookPort — never a direct
//          Drive write. A replay/retry REUSES the receipt = NO duplicate Drive doc
//          (safety rule 3 / NLM-2, enforced inside the NotebookPort).
//   inv-3  REATTACH SURFACING (never silent): a missing/unlinked managed source (blank
//          mapping id or adapter-404) parks in reattach_required and surfaces a 7.5 health
//          item — the operator re-adds/refreshes the NotebookLM source; never silent.
//   inv-4  OUTAGE → OUTBOX HOLD (never dropped): a Drive/connector outage HOLDS the slot's
//          upsert in the write outbox (holdWrite, inside the NotebookPort) and retries on
//          reconnect; the driver parks in outbox_held and surfaces the hold — held, not
//          dropped.
//   inv-5  Idempotent replay: resolveRun (7.4) reuses a seen run; the whole driver is safe
//          to re-drive from the start (assemble is a pure read; each slot upsert is
//          receipt-idempotent). EVERY failure/park class surfaces a DISTINCT 7.5 health
//          item (nothing silent).
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every typed
// port rejection / park signal onto a distinct notebookLmSyncMachine state and routes it
// through the health sink. The returned outcome is a discriminated-union-friendly record
// whose `state` is the machine state the pipeline finally rested in.
import { isOk } from "@sow/contracts";
import type { Result, WorkflowRunRef, FailureClass, AuditId, NotebookMapping } from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type {
  ManagedDocBodies,
  NotebookSyncResult,
  NotebookError,
  NotebookSlot,
} from "@sow/integrations";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";

// ---------------------------------------------------------------------------
// (1) the local notebooklm-sync state machine
// ---------------------------------------------------------------------------

/**
 * The five NotebookLM managed-doc slots in canonical 00→04 order — re-surfaced from the
 * NotebookPort seam so a downstream slice can iterate them without importing the whole
 * integrations package. Mirrors `NotebookMapping.managedDocIds` exactly.
 */
export const NOTEBOOK_SLOTS_ORDER = [
  "00_brief",
  "01_decisions",
  "02_meetings",
  "03_research",
  "04_open_questions",
] as const satisfies readonly NotebookSlot[];

/** The full notebooklm-sync state alphabet. */
export const NOTEBOOK_LM_SYNC_STATES = [
  // happy path
  "scheduled",
  "assembling", // committed Markdown → the five bodies (inv-1)
  "syncing", // upsert each slot through the Tool Gateway / NotebookPort (inv-2)
  "synced",
  // park / failure
  "reattach_required", // inv-3: ≥1 managed source missing/unlinked — operator re-adds
  "outbox_held", // inv-4: ≥1 slot held for retry (Drive outage) — never dropped
  "sync_failed", // assemble failure OR a hard NotebookPort dispatch fault
  // terminal
  "done",
] as const;

/** A notebooklm-sync state (element of {@link NOTEBOOK_LM_SYNC_STATES}). */
export type NotebookLmSyncState = (typeof NOTEBOOK_LM_SYNC_STATES)[number];

// Adjacency table. Terminal `done` maps to []. Each non-terminal state carries ≥1
// outgoing edge so the machine is total; the driver walks only the happy edges + the
// pinned park/failure-entry edges. `scheduled → done` is UNREPRESENTABLE (assemble + sync
// can never be skipped).
const NOTEBOOK_LM_SYNC_TRANSITIONS: Readonly<
  Record<NotebookLmSyncState, readonly NotebookLmSyncState[]>
> = {
  // scheduled → assemble bodies (happy) OR fail before any upsert (assemble error).
  scheduled: ["assembling", "sync_failed"],
  // assembling → upsert (happy) OR fail (assemble error surfaced from the port).
  assembling: ["syncing", "sync_failed"],
  // syncing → all slots upserted, OR reattach needed, OR held for retry, OR hard fault.
  syncing: ["synced", "reattach_required", "outbox_held", "sync_failed"],
  // synced → done.
  synced: ["done"],
  // park/failure states are resting entries the driver returns from (no auto-progression);
  // each carries a self-edge so the machine stays total (every non-terminal state has ≥1
  // outgoing edge) without inventing an illegal recovery transition.
  reattach_required: ["reattach_required"],
  outbox_held: ["outbox_held"],
  sync_failed: ["sync_failed"],
  // terminal
  done: [],
};

/** The pure + total notebooklm-sync state machine (local — @sow/domain ships none). */
export const notebookLmSyncMachine: StateMachine<NotebookLmSyncState> =
  defineMachine<NotebookLmSyncState>(NOTEBOOK_LM_SYNC_TRANSITIONS);

// ---------------------------------------------------------------------------
// (2) activity ports
// ---------------------------------------------------------------------------

/**
 * The result of assembling the five managed-doc bodies FROM COMMITTED Markdown (inv-1).
 * `mapping` is the resolved {@link NotebookMapping} for the project (which Drive docs the
 * five slots map to); `bodies` are the rendered 00→04 bodies. BOTH are derived by the
 * activity from committed state — never caller-supplied.
 */
export interface AssembleDocsResult {
  readonly mapping: NotebookMapping;
  readonly bodies: ManagedDocBodies;
}

/**
 * Closed, enumerable assemble failure set (§16 — never thrown). `mapping_unavailable` — no
 * NotebookMapping exists for the project (the managed-doc pack was never created; a
 * different lifecycle state, not a half-filled mapping). `assemble_failed` — a committed-
 * Markdown read/render failed. Either folds to sync_failed with NO upsert attempted.
 */
export interface AssembleDocsError {
  readonly code: "mapping_unavailable" | "assemble_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Assemble the five managed-doc bodies for a project FROM COMMITTED Markdown (inv-1). The
 * driver passes ONLY the bound workspaceId + projectId — never bodies — so the assembled
 * content provably comes from committed state, not the caller. The concrete activity
 * (src/activities/assembleNotebookDocs.ts) resolves the mapping + reads committed Markdown;
 * tested with injected fakes. Never throws.
 */
export interface AssembleDocsPort {
  assemble(
    workspaceId: string,
    projectId: string,
  ): Promise<Result<AssembleDocsResult, AssembleDocsError>>;
}

/**
 * The driver-facing seam over the Phase-6 NotebookPort (`createNotebookLmSync`). `sync`
 * upserts all five 00→04 managed docs for `mapping` from `bodies` THROUGH the Tool Gateway
 * (inv-2), returning the partitioned {@link NotebookSyncResult} (upserted / reattachRequired
 * / heldForRetry) or a hard {@link NotebookError}. The pre-write existence check + receipt
 * reuse (no duplicate Drive doc on replay) + the outbox hold on outage all live INSIDE the
 * NotebookPort; the driver only RECEIVES the typed result. Structurally the NotebookPort
 * interface — declared here so the pure driver never imports the concrete implementation.
 * Never throws.
 */
export interface NotebookSyncPort {
  sync(
    mapping: NotebookMapping,
    bodies: ManagedDocBodies,
  ): Promise<Result<NotebookSyncResult, NotebookError>>;
}

// ---------------------------------------------------------------------------
// (2b) the 7.5 health sink seam
// ---------------------------------------------------------------------------

/**
 * A notebooklm-sync failure/park to surface (inv-3/inv-4/inv-5). Structurally a subset of
 * the 7.5 `WorkflowFailure` seam — the driver routes EVERY failure/park class through the
 * sink so nothing fails silently (inv-5 / §16).
 */
export interface NotebookLmSyncFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface NotebookLmSyncSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface NotebookLmSyncSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every notebooklm-sync failure/park class through
 * (inv-5). In production it is backed by the 7.5 `surfaceWorkflowFailure` (HealthItemStore
 * + outbox); the driver depends only on this narrow port so it stays pure + injected-
 * testable. Never throws.
 */
export interface NotebookLmHealthSink {
  surface(
    failure: NotebookLmSyncFailure,
  ): Promise<Result<NotebookLmSyncSurfaceOutcome, NotebookLmSyncSinkError>>;
}

// ---------------------------------------------------------------------------
// (3) driver input + deps + outcome
// ---------------------------------------------------------------------------

/**
 * The complete input to {@link runNotebookLmSync}. `run` is the trigger submission resolved
 * idempotently through the 7.4 seam. `workspaceId`/`projectId` name the (workspace-scoped,
 * WS-2) managed-doc pack to sync. There is NO bodies field — the bodies are DERIVED from
 * committed Markdown by the assemble port (inv-1), so a caller cannot inject content.
 */
export interface NotebookLmSyncInput {
  readonly run: ResolveRunInput;
  readonly workspaceId: string;
  readonly projectId: string;
}

/**
 * The injected dependency set: the assemble activity port, the NotebookPort seam, the 7.5
 * health sink, the 7.4 WorkflowRun repository (resolveRun), and the injected Clock. Every
 * dependency is a narrow port so the driver stays pure + fully injected-testable (no Drive
 * adapter / Tool Gateway / outbox / Temporal).
 */
export interface NotebookLmSyncDeps {
  readonly assemble: AssembleDocsPort;
  readonly notebook: NotebookSyncPort;
  readonly health: NotebookLmHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

/**
 * The result of a notebooklm-sync drive. `state` is the machine state the pipeline rested
 * in (`done`, `reattach_required`, `outbox_held`, or `sync_failed`). `run` is the resolveRun
 * result; `runReused` mirrors resolveRun's `reused` flag. `upserted`/`reattachRequired`/
 * `heldForRetry` partition the attempted slots (from the NotebookPort result; empty when
 * the sync never ran). `surfaced` names the health failure routed on a failure/park branch
 * (undefined on the happy path). Never throws.
 */
export interface NotebookLmSyncOutcome {
  readonly state: NotebookLmSyncState;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly upserted: readonly NotebookSlot[];
  readonly reattachRequired: readonly NotebookSlot[];
  readonly heldForRetry: readonly NotebookSlot[];
  readonly surfaced?: NotebookLmSyncFailure;
}

// ---------------------------------------------------------------------------
// (4) helpers
// ---------------------------------------------------------------------------

/**
 * Advance the local machine cursor through an ORDERED list of successor states, asserting
 * each edge is legal. The domain machine is pure + total (never throws); an illegal edge
 * stops the cursor at the last legal state rather than crashing, keeping the driver total
 * (§16). Returns the last legal state reached — a mis-pinned forbidden edge (e.g.
 * scheduled→done) stops at the last legal state, never teleports past it.
 */
function advance(
  from: NotebookLmSyncState,
  through: readonly NotebookLmSyncState[],
): NotebookLmSyncState {
  let cursor = from;
  for (const to of through) {
    const step = notebookLmSyncMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

/** Map a notebooklm-sync failure/park state to a §16 FailureClass for the health sink. */
function failureClassFor(state: NotebookLmSyncState): FailureClass {
  switch (state) {
    case "reattach_required":
      // A managed source needs re-adding/refreshing — the sync is lagging behind
      // committed truth until the operator reattaches it (NLM-2).
      return "sync_lagging";
    case "outbox_held":
      // A Drive write is held in the outbox awaiting reconnect (§8 hold-through-outage).
      return "write_through_failed";
    case "sync_failed":
    default:
      return "write_through_failed";
  }
}

// ---------------------------------------------------------------------------
// (5) driver
// ---------------------------------------------------------------------------

/**
 * Run the notebooklm-sync pipeline as a pure, replay-safe driver.
 *
 * Order (each durable step keyed for idempotent replay — inv-5):
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run.
 *   2. ASSEMBLE the five managed-doc bodies FROM COMMITTED Markdown (inv-1). An assemble
 *      failure parks in sync_failed with NO upsert attempted (fail-closed).
 *   3. UPSERT all five slots THROUGH the Tool Gateway / NotebookPort (inv-2) — idempotent
 *      by canonical key; a replay reuses the receipt (no duplicate Drive doc). A hard
 *      NotebookPort fault parks in sync_failed.
 *   4. FOLD the partitioned result (inv-3/inv-4/inv-5): a slot needing reattach parks in
 *      reattach_required (reattach takes precedence — it needs operator action); else a
 *      slot held for retry (outage) parks in outbox_held; else every slot upserted →
 *      synced → done. BOTH reattach + hold health items surface when both occur.
 *
 * Every failure/park branch routes through the health sink (inv-5) and returns the resting
 * machine state. Never throws.
 */
export async function runNotebookLmSync(
  input: NotebookLmSyncInput,
  deps: NotebookLmSyncDeps,
): Promise<NotebookLmSyncOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the existing run —
  //    the whole pipeline is safe to re-drive from the start (inv-5 / LIFE-3).
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let state: NotebookLmSyncState = "scheduled";
  const empty: readonly NotebookSlot[] = [];

  const surface = async (
    failState: NotebookLmSyncState,
    message: string,
    result?: NotebookSyncResult,
  ): Promise<NotebookLmSyncOutcome> => {
    const failure: NotebookLmSyncFailure = {
      failureClass: failureClassFor(failState),
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route through the health sink — nothing fails silently (inv-5). Even if the sink
    // itself errors we still return the failure state (fail-closed); the sink's own error
    // is the 7.5 seam's concern, not a reason to lose the machine state.
    await deps.health.surface(failure);
    return {
      state: failState,
      run: runResult,
      runReused,
      upserted: result?.upserted ?? empty,
      reattachRequired: result?.reattachRequired ?? empty,
      heldForRetry: result?.heldForRetry ?? empty,
      surfaced: failure,
    };
  };

  // 2. ASSEMBLE the five bodies FROM COMMITTED Markdown (inv-1). The driver passes ONLY the
  //    bound workspaceId + projectId — never bodies — so the content provably comes from
  //    committed state. An assemble failure folds to sync_failed with NO upsert attempted.
  const assembled = await deps.assemble.assemble(input.workspaceId, input.projectId);
  if (!isOk(assembled)) {
    state = advance(state, ["sync_failed"]);
    return surface(state, `notebook doc assembly failed: ${assembled.error.code}`);
  }
  state = advance(state, ["assembling"]);
  const { mapping, bodies } = assembled.value;

  // 3. UPSERT all five slots THROUGH the Tool Gateway / NotebookPort (inv-2). The pre-write
  //    existence check + receipt reuse (no duplicate Drive doc on replay) + the outbox hold
  //    on outage all live INSIDE the NotebookPort; the driver only receives the typed
  //    result. A hard (non-reattach, non-hold) fault fails closed → sync_failed.
  state = advance(state, ["syncing"]);
  const synced = await deps.notebook.sync(mapping, bodies);
  if (!isOk(synced)) {
    state = advance(state, ["sync_failed"]);
    return surface(state, `notebook slot upsert failed at ${synced.error.slot}: ${synced.error.code}`);
  }
  const result = synced.value;

  // 4. FOLD the partitioned result (inv-3/inv-4/inv-5). Both a reattach signal and an
  //    outage-hold surface their own DISTINCT health item (nothing silent); the RESTING
  //    state prefers reattach_required (it needs operator action) over outbox_held (which
  //    self-heals on reconnect).
  const needsReattach = result.reattachRequired.length > 0;
  const heldForOutage = result.heldForRetry.length > 0;

  // When BOTH a reattach signal and an outage-hold occur, reattach becomes the resting
  // state (it needs operator action) — so the outbox-hold class would otherwise go
  // un-surfaced. Surface it as its own DISTINCT 7.5 item here so both are recorded (inv-5).
  // In the outbox-only case the resting `surface` below handles it (no double item).
  if (needsReattach && heldForOutage) {
    await deps.health.surface({
      failureClass: failureClassFor("outbox_held"),
      subjectRef: input.run.workflowId,
      message: `notebook slots held in outbox on Drive outage (retry on reconnect): ${result.heldForRetry.join(", ")}`,
      auditRef: input.run.workflowId as unknown as AuditId,
    });
  }

  if (needsReattach) {
    state = advance(state, ["reattach_required"]);
    return surface(
      state,
      `notebook managed source(s) missing/unlinked — re-add/refresh required: ${result.reattachRequired.join(", ")}`,
      result,
    );
  }

  if (heldForOutage) {
    // Outbox-hold WITHOUT a reattach: the resting `surface` records the single distinct
    // outbox health item (no reattach pre-surface ran, so no duplicate).
    state = advance(state, ["outbox_held"]);
    return surface(
      state,
      `notebook slots held in outbox on Drive outage (retry on reconnect): ${result.heldForRetry.join(", ")}`,
      result,
    );
  }

  // Every slot upserted (created OR reused — receipt reuse = zero duplicate Drive doc,
  // inv-2). Advance to the happy terminal.
  state = advance(state, ["synced"]);
  state = advance(state, ["done"]);
  return {
    state,
    run: runResult,
    runReused,
    upserted: result.upserted,
    reattachRequired: result.reattachRequired,
    heldForRetry: result.heldForRetry,
  };
}
