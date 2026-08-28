// apps/worker — 21.4b: the wake-drain DEPS FACTORY (pure, unbound).
//
// Two composition-root INGREDIENTS the boot binding (PROV-6) will assemble, built
// here with NO call-site:
//
//   • buildDrainDeps — assembles the §8 `DrainDeps` `drainOutbox` needs, with its
//     `dispatch` seam bound to `dispatchRouted(writeAdapters, env, action, deps)` —
//     the SAME expression already bound to the live `propose`/`dispatchApproved`
//     paths at `buildActivities.ts:669`/`:749`. Because the drain shares that exact
//     routing decision, a held entry re-driven through it reaches the correct
//     per-vendor adapter, never the fail-closed `createUnroutedWriteAdapter()`
//     sentinel that sits on `gatewayDeps.adapter` (backends.ts's defense-in-depth
//     placeholder — see write-adapter-registry.ts's header).
//   • buildWakeDrainHook — wraps `runWakeDrain` (packages/workflows/src/runtime/
//     wakeHooks.ts) into the exact `wakeDrain: (event) => Promise<DrainResult>`
//     shape `createKeychainLockController` (apps/worker/src/lifecycle/degraded/
//     keychain-locked.ts:123) demands, so the integrator can hand it straight to
//     `KeychainLockDeps.wakeDrain` with no adapter shim.
//
// PURE ASSEMBLY: neither function does I/O, reads a real clock, constructs a real
// transport, or keeps module state. `buildDrainDeps` reads its `now` from the
// INJECTED `clock()` (never `Date.now()`); `jitter` is passed through unchanged —
// no built-in randomness is ever called here. `workspaceId` (task 24.50, safety
// rule 4) is threaded straight onto `DrainDeps.workspaceId`, never re-derived —
// the caller must name the SAME workspace `gatewayDeps` was bound for. No
// production file imports this module yet (the dormancy pin in the test file
// proves it); PROV-6 adds the boot-time call-site.
import type {
  DrainDeps,
  DrainResult,
  ExternalWriteDeps,
  ExternalWriteResult,
  DispatchOptions,
  OutboxRepository,
  WriteAdapterRegistry,
} from "@sow/integrations";
import { dispatchRouted, type BackoffConfig } from "@sow/integrations";
import type { ExternalWriteEnvelope, ProposedAction } from "@sow/contracts";
import { runWakeDrain, DEFAULT_WAKE_LIMIT, type WakeEvent } from "@sow/workflows";

/**
 * The default bounded-backoff window for a re-held drain entry when the caller
 * supplies none. Mirrors the outbox-drain suite's own fixture (§8) — bounded,
 * never spins, never drops a still-unreachable entry.
 */
export const DEFAULT_DRAIN_BACKOFF: BackoffConfig = {
  baseMs: 1000,
  maxMs: 60000,
  maxAttempts: 5,
};

/** Injected args for {@link buildDrainDeps}. Every effect is injected — nothing built here. */
export interface BuildDrainDepsArgs {
  /** The SAME `ExternalWriteDeps` bundle the live Tool Gateway uses (adapter/receiptStore/approval/audit/clock). */
  readonly gatewayDeps: ExternalWriteDeps;
  /**
   * Task 24.50 / safety rule 4 (workspace isolation). The workspace `gatewayDeps`
   * was bound for — threaded verbatim onto `DrainDeps.workspaceId`. REQUIRED,
   * deliberately: `drainOutbox` skips any due entry whose OWN `workspaceId`
   * disagrees rather than evaluating it against the wrong workspace's approval
   * posture, so every caller must state its scope. A mixed-workspace outbox is
   * drained by one pass per workspace, each with `gatewayDeps` + this field bound
   * to the SAME workspace.
   */
  readonly workspaceId: string;
  /** The 21.1/21.2 per-`TargetSystem` routing registry — `dispatch` routes through it, never the raw adapter. */
  readonly writeAdapters: WriteAdapterRegistry;
  /** Injected ISO clock — `now`'s source. Never `Date.now()`. */
  readonly clock: () => string;
  /** Sweep limit for the pass. Non-positive or absent clamps UP to {@link DEFAULT_WAKE_LIMIT} — never a zero-width sweep. */
  readonly limit?: number;
  /** Bounded backoff for a re-held entry. Defaults to {@link DEFAULT_DRAIN_BACKOFF}. */
  readonly backoffCfg?: BackoffConfig;
  /** Optional injected jitter. Absent ⇒ no jitter (no built-in randomness is called here). */
  readonly jitter?: (baseDelayMs: number) => number;
}

/**
 * Assemble the `DrainDeps` `drainOutbox` needs (packages/integrations/src/tools/
 * outbox-drain.ts). `dispatch` is bound to `dispatchRouted(writeAdapters, env,
 * action, deps)` — the identical expression the composition root binds to the live
 * dispatch paths — so a drained entry provably shares the SAME target-routing
 * decision and can never reach the unrouted sentinel. `workspaceId` is threaded
 * verbatim (task 24.50 — never re-derived, never defaulted) so a cross-workspace
 * entry is skipped rather than evaluated against the wrong posture. `now` is read
 * from the injected `clock()` once, at assembly time. Pure: no I/O, no real
 * clock, no real transport construction, no exported singleton.
 */
export function buildDrainDeps(args: BuildDrainDepsArgs): DrainDeps {
  const limit = args.limit !== undefined && args.limit > 0 ? args.limit : DEFAULT_WAKE_LIMIT;
  return {
    gatewayDeps: args.gatewayDeps,
    workspaceId: args.workspaceId,
    now: args.clock(),
    limit,
    backoffCfg: args.backoffCfg ?? DEFAULT_DRAIN_BACKOFF,
    clock: args.clock,
    // `opts` (C3 `intentCreatedAt`) is supplied by the DRAIN, which knows each
    // entry's `enqueuedAt`. Declaring and forwarding it is load-bearing: a
    // fixed-arity lambda here silently drops the ordering fact, and a stale held
    // entry then writes its old payload back over a fresher one.
    dispatch: (
      env: ExternalWriteEnvelope,
      action: ProposedAction,
      deps: ExternalWriteDeps,
      opts?: DispatchOptions,
    ): Promise<ExternalWriteResult> => dispatchRouted(args.writeAdapters, env, action, deps, undefined, opts),
    ...(args.jitter !== undefined ? { jitter: args.jitter } : {}),
  };
}

/** Injected args for {@link buildWakeDrainHook}. */
export interface BuildWakeDrainHookArgs {
  readonly outbox: OutboxRepository;
  readonly drainDeps: DrainDeps;
}

/**
 * Build the LIFE-6 wake-drain hook: exactly the `(event) => Promise<DrainResult>`
 * shape `createKeychainLockController`'s `KeychainLockDeps.wakeDrain`
 * (apps/worker/src/lifecycle/degraded/keychain-locked.ts:123) demands. Delegates
 * to `runWakeDrain` (packages/workflows/src/runtime/wakeHooks.ts) — this module
 * re-implements neither `planWake` nor the drain loop itself. Pure: constructs
 * nothing, does no I/O of its own.
 */
export function buildWakeDrainHook(
  args: BuildWakeDrainHookArgs,
): (event: WakeEvent) => Promise<DrainResult> {
  return (event: WakeEvent): Promise<DrainResult> =>
    runWakeDrain(event, { outbox: args.outbox, drainDeps: args.drainDeps });
}
