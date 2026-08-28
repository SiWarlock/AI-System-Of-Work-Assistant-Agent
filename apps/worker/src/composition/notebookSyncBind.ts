// apps/worker — 21.9a: the NotebookLM sync worker-BIND factory (dormant, unbound).
//
// `createNotebookLmSync` (packages/integrations/src/notebook/notebooklm-sync.ts) is
// real and tested — a `NotebookPort` whose `sync` upserts the five 00–04 managed
// Drive docs through the §8 Tool Gateway (`dispatchExternalWrite`), using
// `deps.gateway.adapter` DIRECTLY (notebooklm-sync.ts:175). The worker's 21.1/21.2
// per-`targetSystem` routing registry (`dispatchRouted`/`buildWriteAdapterRegistry`,
// packages/integrations/src/tools/write-adapter-registry.ts) is what actually picks
// the vendor adapter; it is bound ONLY at buildActivities.ts, whose
// `externalWriteDeps.adapter = createUnroutedWriteAdapter()` (:625-629) is a
// fail-closed SENTINEL — every real dispatch goes through `dispatchRouted`
// (:669/:749), never that sentinel.
//
// `createNotebookLmSync` predates 21.1/21.2 and has NO injectable dispatch hook
// (unlike `createProposeActivity`'s `{dispatch, deps}` shape in
// packages/workflows/src/activities/proposeExternalActions.ts) — it always calls
// `dispatchExternalWrite` directly against whatever `deps.gateway.adapter` it is
// given. So a caller that owns only the registry-routed `dispatch` fn (never a raw
// per-vendor adapter) cannot hand `deps.gateway` through unchanged: its `.adapter`
// may be the unrouted sentinel, which rejects every operation.
//
// `buildNotebookSync` bridges this gap WITHOUT touching notebooklm-sync.ts (real,
// tested, out of this package's territory): it swaps `gateway.adapter` for a thin
// `TargetWriteAdapter` whose `create`/`update` reconstruct the slot's
// `ProposedAction` (from the envelope + payload the gateway hands them, plus the
// closed-over `approvalPolicy`) and re-run the write through the injected
// registry-routed `dispatch`.
//
// WHY THE WRAPPER'S `existenceCheck` ALWAYS REPORTS "NOT LOCALLY KNOWN" (returns
// `ok(null)`): the REAL pre-write existence check for a not-yet-synced slot runs
// INSIDE the nested `dispatch` call, against the registry-picked vendor adapter —
// never against this wrapper. A prior-write/replay hit is caught earlier still, by
// the OUTER `dispatchExternalWrite`'s own lookup on the REAL shared
// `gateway.receiptStore` (steps 3a/3b), before this wrapper's `existenceCheck` is
// ever reached — so the wrapper never needs to answer that question for real.
//
// WHY A THROWAWAY INNER RECEIPT STORE (load-bearing, not decorative): the OUTER
// `dispatchExternalWrite` call already RESERVES the object's
// (targetSystem, canonicalObjectKey) on the REAL shared `gateway.receiptStore`
// (§8 step 3.5, packages/integrations/src/tools/gateway.ts) BEFORE it ever calls
// `adapter.create`. If the NESTED dispatch (invoked from inside this wrapper's
// `create`) reserved against that SAME real store, it would collide with the
// reservation the outer call is still holding and come back
// `{status:'held', reason:'...in progress...'}` on EVERY sync — a guaranteed
// self-conflict, not a race (verified by reading
// packages/integrations/test/tool-gateway-race.test.ts's reservation semantics).
// A fresh, per-call throwaway `ReceiptStore` gives the nested dispatch its own
// reservation slot (always wins trivially) while the REAL concurrency guard stays
// exactly where it already is — the outer call's reservation on the real store —
// and the REAL de-duplication (a live-vendor hit) is still checked, by the nested
// call's existence probe against the registry-picked adapter (never this
// wrapper). The real receipt + the real audit entry are recorded exactly once, by
// the OUTER call, once this wrapper's `create`/`update` returns — the nested call
// is given a no-op `audit` so nothing is double-recorded.
//
// NOTHING ARMS: `buildNotebookSync` returns `undefined` unless `gate.enabled` is
// the literal `true` (a JSON-sourced `1`/`"true"`/`"false"`/`{}` never arms and
// never throws — mirrors `selectAdapterTransport`, backends.ts:693-706). No
// production file calls this factory (dormancy pin in the test file); the
// §ARM-21/21.9 flip that would is explicitly out of scope for this package.
import { ok, err } from "@sow/contracts";
import type { ProposedAction, ExternalWriteEnvelope, Result, WriteReceipt } from "@sow/contracts";
import { createNotebookLmSync } from "@sow/integrations";
import type {
  NotebookSyncDetailPort,
  ExternalWriteDeps,
  ExternalWriteResult,
  TargetWriteAdapter,
  AdapterError,
  ReceiptStore,
  ReceiptRecord,
  OutboxRepository,
  HoldDeps,
} from "@sow/integrations";

/** Default-OFF arming gate (§ARM-21/21.9). `enabled` must be the literal `true`. */
export interface NotebookSyncGate {
  readonly enabled?: boolean;
}

/**
 * Injected deps for the bind. `gateway` is the SAME fully-wired `ExternalWriteDeps`
 * bundle `buildActivities.ts:625` constructs — its `.adapter` may be the unrouted
 * sentinel; this bind never relies on it. `dispatch` is the registry-routed
 * dispatch fn (`dispatchRouted` curried over the write-adapter registry, exactly
 * `buildActivities.ts:669`'s `(env, action, deps) => dispatchRouted(registry, env,
 * action, deps)`). `approvalPolicy`/`clock`/`outbox` map straight through to
 * `NotebookSyncDeps` (packages/integrations/src/notebook/notebooklm-sync.ts:56-90);
 * an absent `outbox` fails an unreachable hold closed rather than dropping it
 * (see that file's comment at :73-83). `registerSchedule`, when given, is called
 * with the built port ONLY on the armed path.
 */
export interface NotebookSyncBindDeps {
  readonly gate?: NotebookSyncGate;
  readonly gateway: ExternalWriteDeps;
  readonly dispatch: (
    env: ExternalWriteEnvelope,
    action: ProposedAction,
    deps: ExternalWriteDeps,
  ) => Promise<ExternalWriteResult>;
  readonly approvalPolicy: string;
  readonly clock: () => string;
  readonly outbox?: {
    readonly repo: OutboxRepository;
    readonly hold: HoldDeps;
    readonly workspaceId: string;
  };
  /**
   * Called with the built port ONLY on the armed path. Typed to the DETAIL port
   * (`NotebookSyncDetailPort`) so a schedule consumer can read `outcome` and the
   * per-slot `heldDetail` causes rather than only the slot-name lists; a callback
   * declared against the plain `NotebookPort` remains assignable.
   */
  readonly registerSchedule?: (port: NotebookSyncDetailPort) => void;
}

// A single-use, in-process ReceiptStore for the nested dispatch (see module header
// "WHY A THROWAWAY..."). It gives the nested `dispatchExternalWrite` run its own
// fresh reservation slot so it never collides with the outer call's already-held
// reservation on the real store; it is discarded once `create`/`update` returns —
// the real receipt lands on `deps.gateway.receiptStore` via the OUTER call.
function createThrowawayReceiptStore(): ReceiptStore {
  const byIdempotencyKey = new Map<string, ReceiptRecord>();
  const byObjectKey = new Map<string, ReceiptRecord>();
  return {
    getByIdempotencyKey: (k) => Promise.resolve(byIdempotencyKey.get(k)),
    getByCanonicalObjectKey: (sys, k) => Promise.resolve(byObjectKey.get(`${sys}|${k}`)),
    reserve: () => Promise.resolve({ kind: "reserved" }),
    release: () => Promise.resolve(undefined),
    put: (r) => {
      byIdempotencyKey.set(r.idempotencyKey, r);
      byObjectKey.set(`${r.targetSystem}|${r.canonicalObjectKey}`, r);
      return Promise.resolve(undefined);
    },
  };
}

// Fold a nested dispatch outcome onto the TargetWriteAdapter.create/update return
// shape. created/reused both carry a receipt the outer call can record; every
// other status folds to an AdapterError so the outer §8 pipeline's own fault
// handling (held→outbox-hold-eligible, conflict→never-overwrite,
// rejected→typed reject) runs unchanged.
//
// CODE: `outcome.adapterCode` (gateway.ts's `ExternalWriteResult`) is the INNER
// adapter's own closed code — e.g. a nested existence-check/create fault of
// `not_found`, which notebooklm-sync.ts's per-slot reattach signal branches on
// (gateway.ts's `ExternalWriteResult` doc comment). Forwarding it here (rather
// than collapsing every "held"/"rejected" to a fixed `"unreachable"`/
// `"rejected"`) lets that signal survive this extra fold layer.
//
// ⚠ WHAT "matches the pre-adapterCode behavior" DOES AND DOES NOT MEAN — an
// earlier version of this comment ended "matching the PRE-adapterCode behavior
// exactly", which reads as a claim about the fold and is only true of its
// FALLBACKS. Measured against the pre-adapterCode fold (commit `3fe75d1a`, which
// returned a FIXED `unreachable`/`conflict`/`rejected` per status):
//   • `adapterCode` ABSENT ⇒ each `??` fallback yields the SAME code that version
//     returned for that status. Exact, and that is the whole of the claim.
//   • `adapterCode` PRESENT ⇒ the forwarded code deliberately DIFFERS from the
//     fixed one. That divergence IS the change; it is what carries a nested
//     `not_found` through to the reattach signal. Nothing here is behaviour-
//     preserving in that case, and it should not be described as if it were.
//
// WHERE AN ABSENT `adapterCode` ACTUALLY COMES FROM. It is absent only for a
// failure that never originated from an `AdapterError`. gateway.ts has three such
// sites, and their reachability through THIS nested dispatch differs — a prior
// version of this comment called all of them reachable and said "four sites":
//   • REACHABLE — the candidate-gate rejection (gateway.ts:215). The nested call
//     re-admits a RECONSTRUCTED `ProposedAction` (built in `routeWrite` from the
//     envelope + payload), so it can reject where the outer admission passed.
//   • NOT REACHABLE — the reservation-in-progress hold (gateway.ts:320). The
//     nested dispatch runs over `createThrowawayReceiptStore`, whose `reserve`
//     returns `{kind:"reserved"}` UNCONDITIONALLY (see the module header's "WHY A
//     THROWAWAY..." — winning trivially is the entire point of that store), so
//     the `in_progress` arm cannot be entered from here.
//   • REACHABLE ONLY ON A CHANGED VERDICT — the §21.10 credential-fault hold
//     (gateway.ts:239). The nested deps are `{...gateway, receiptStore, audit}`,
//     so `secrets` IS inherited — but the OUTER `dispatchExternalWrite` runs the
//     SAME credential gate at its own step 2.5, BEFORE `adapter.create`. A stably
//     faulting accessor therefore holds at the OUTER call and the nested dispatch
//     is never invoked at all (driven end-to-end and pinned: notebook-sync-bind
//     .test.ts's locked-Keychain case asserts `dispatch` was not called). It
//     reaches this fold only if the accessor's verdict CHANGES between the two
//     resolutions — e.g. the Keychain re-locks mid-sync. Real, but a race, not
//     the ordinary path.
// The fourth entry that prior version listed, the `approval_pending` guard below,
// is not an absent-`adapterCode` fallback at all — it is its own case arm with a
// hardcoded code. The `?? "conflict"` fallback is likewise dead on this path (the
// gateway only emits `conflict` from an adapter fault); both are kept as total,
// fail-closed defence rather than removed.
//
// ⚠ KNOWN COST on that changed-verdict path: the credential fault folds to
// `code: "unreachable"`, so a locked Keychain would be labelled here as a
// transient outage. The MESSAGE still carries the closed `"locked"`/`"missing"`/
// `"denied"`/`"empty"` token (see the MESSAGE note below), so the operator signal
// survives — but the CODE does not distinguish it, and `ExternalWriteResult`
// exposes no `faultDetail` field to carry that distinction typed (`faultDetail`
// exists on `AdapterError`, not on the gateway result). Widening
// `ExternalWriteResult` is a gateway change, not a change this bind can make.
// On the ORDINARY path the distinction is intact: the outer hold carries no
// `adapterCode` at all, which is exactly how notebooklm-sync.ts's
// `NotebookHeldSlot` tells a credential hold from an adapter outage.
//
// MESSAGE: `outcome.reason` is forwarded VERBATIM (`message: outcome.reason`)
// below and needs NO redaction here: the §8 Tool Gateway builds `reason`
// REDACTION-SAFE BY CONSTRUCTION at every site (packages/integrations/src/tools/
// gateway.ts:81-119's `ExternalWriteResult` doc comment) — a closed code or a
// fixed literal, never adapter/vendor/Zod free text — with the ONE deliberate
// exception being the credential-fault reason (21.10), which carries the closed
// `"locked"`/`"empty"`/fault-code tokens an operator needs (worker LESSONS §41)
// to distinguish "your keychain is locked" from "the vendor rejected the
// write". This nested `AdapterError` itself then re-enters the OUTER
// `dispatchExternalWrite` call as an `adapter.create`/`update` fault (module
// header), which folds it through the SAME gateway construction sites
// (gateway.ts:310, `create fault (${code}): ${message}`) — so a redaction here
// would be not only redundant but WRONG twice over: it never reaches an
// activity boundary carrying the original text anyway.
// ⛔ DO NOT add a fixed-message redaction to this fold — see buildActivities.ts's
// matching comment at its `approvedGateway.dispatch` switch for the invariant this
// protects.
function foldDispatchOutcome(outcome: ExternalWriteResult): Result<WriteReceipt, AdapterError> {
  switch (outcome.status) {
    case "created":
    case "reused":
      return ok(outcome.receipt);
    case "held":
      return err({ code: outcome.adapterCode ?? "unreachable", message: outcome.reason });
    case "conflict":
      return err({ code: outcome.adapterCode ?? "conflict", message: outcome.reason });
    case "rejected":
      return err({ code: outcome.adapterCode ?? "rejected", message: outcome.reason });
    case "approval_pending":
      // Should not occur: by the time create/update runs, the OUTER call's own
      // approval step already granted this exact action. Total + fail-closed.
      return err({ code: "rejected", message: "nested dispatch awaiting approval" });
  }
}

// Build the TargetWriteAdapter this bind installs as `gateway.adapter`. See the
// module header for why `existenceCheck` always reports "not locally known" and
// why the nested dispatch runs over a throwaway receipt store.
function buildRoutedDriveAdapter(
  dispatch: NotebookSyncBindDeps["dispatch"],
  gateway: ExternalWriteDeps,
  approvalPolicy: string,
): TargetWriteAdapter {
  const routeWrite = async (
    env: ExternalWriteEnvelope,
    payload: Record<string, unknown>,
  ): Promise<Result<WriteReceipt, AdapterError>> => {
    const action: ProposedAction = {
      actionId: env.actionId,
      targetSystem: env.targetSystem,
      canonicalObjectKey: env.canonicalObjectKey,
      payload,
      approvalPolicy,
      idempotencyKey: env.idempotencyKey,
    };
    const innerDeps: ExternalWriteDeps = {
      ...gateway,
      receiptStore: createThrowawayReceiptStore(),
      // The outer call records the ONE real audit entry once this returns.
      audit: () => Promise.resolve(undefined),
    };
    const outcome = await dispatch(env, action, innerDeps);
    return foldDispatchOutcome(outcome);
  };

  return {
    targetSystem: "drive",
    existenceCheck: () => Promise.resolve(ok(null)),
    create: routeWrite,
    update: routeWrite,
  };
}

/**
 * Build a dormant, worker-bound `NotebookPort` over the §8 Tool Gateway's
 * registry-routed write path. GATE FIRST, STRICT: any `gate.enabled` other than
 * the literal `true` (absent, `1`, `"true"`, `"false"`, `{}`) returns `undefined`
 * — no `NotebookPort` is constructed, no schedule is registered, and the injected
 * `dispatch` is never invoked. Never throws.
 *
 * Returns the DETAIL port (`NotebookSyncDetailPort`, a `NotebookPort` whose result
 * also carries `outcome` + the per-slot `heldDetail` causes), so a held slot's cause is
 * not flattened away at this bind. See notebooklm-sync.ts's `NotebookHeldSlot` for
 * what that cause can and cannot distinguish.
 */
export function buildNotebookSync(deps: NotebookSyncBindDeps): NotebookSyncDetailPort | undefined {
  if (deps.gate?.enabled !== true) {
    return undefined;
  }

  const routedAdapter = buildRoutedDriveAdapter(deps.dispatch, deps.gateway, deps.approvalPolicy);
  const gateway: ExternalWriteDeps = { ...deps.gateway, adapter: routedAdapter };

  const port = createNotebookLmSync({
    gateway,
    approvalPolicy: deps.approvalPolicy,
    clock: deps.clock,
    ...(deps.outbox !== undefined ? { outbox: deps.outbox } : {}),
  });

  deps.registerSchedule?.(port);

  return port;
}
