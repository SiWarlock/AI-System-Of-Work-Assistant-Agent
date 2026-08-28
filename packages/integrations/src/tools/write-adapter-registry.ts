// @sow/integrations — task 21.1 + 21.2: the per-`TargetSystem` write-adapter
// ROUTING REGISTRY (pure composition logic; the worker binds it at the composition
// root — backends.ts builds it over the owner-gated transport, buildActivities.ts
// routes each dispatch through it).
//
// WHY: the §8 Tool Gateway (`dispatchExternalWrite`) writes through ONE injected
// `TargetWriteAdapter` (`deps.adapter`). Before this, a single hard-coded todoist
// adapter handled EVERY external write regardless of `action.targetSystem` (G15/G16).
// This module selects the correct vendor adapter per target and FAILS CLOSED on an
// unknown one — no silent no-op, no default adapter.
//
// DORMANCY (§ARM-21): this module constructs NOTHING real. Every adapter is built
// over the INJECTED `AdapterDeps.transport`; the shipped default (the worker's stub
// transport) reaches only the in-memory stub. A real per-vendor transport is bound
// ONLY by deliberate owner config at 21.5/21.6 — never here. Registering the seven
// factories opens no real external write.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  TargetSystem,
  ProposedAction,
  ExternalWriteEnvelope,
} from "@sow/contracts";
import type { TargetWriteAdapter, AdapterError } from "./adapter-port";
import type { AdapterDeps } from "./adapters/adapter-core";
import { createCalendarWriteAdapter } from "./adapters/calendar";
import { createTodoistWriteAdapter } from "./adapters/todoist";
import { createLinearWriteAdapter } from "./adapters/linear";
import { createAsanaWriteAdapter } from "./adapters/asana";
import { createDriveWriteAdapter } from "./adapters/drive";
import { createGithubWriteAdapter } from "./adapters/github";
import { createTelegramWriteAdapter } from "./adapters/telegram";
import {
  dispatchExternalWrite,
  type DispatchOptions,
  type ExternalWriteDeps,
  type ExternalWriteResult,
} from "./gateway";

/**
 * The exhaustive per-target write-adapter registry. Keyed by the frozen
 * `TargetSystem` enum — a `Record` (not a `Map`) so the type system enforces
 * COMPLETENESS: a future enum member won't compile until it is registered in
 * {@link buildWriteAdapterRegistry}, so a new target can never silently mis-route.
 */
export type WriteAdapterRegistry = Record<TargetSystem, TargetWriteAdapter>;

/**
 * The routing fail-closed fault. Code-only (redaction-safe, safety rule 7 — the
 * untrusted `targetSystem` value is NEVER echoed). An unregistered/unknown target
 * is a PERMANENT rejection, never a retryable hold.
 */
export interface WriteAdapterRoutingError {
  readonly code: "unregistered_target";
}

/**
 * Build the exhaustive registry by calling all SEVEN built-but-uncalled vendor
 * write-adapter factories over the INJECTED `AdapterDeps` (this IS 21.2's "wire the
 * seven factories"). Every adapter shares the one injected transport + clock, so
 * the shipped default (stub transport) is byte-equivalent + fully dormant; a real
 * transport is the owner's to bind at 21.5/21.6 (§ARM-21).
 */
export function buildWriteAdapterRegistry(deps: AdapterDeps): WriteAdapterRegistry {
  return {
    calendar: createCalendarWriteAdapter(deps),
    todoist: createTodoistWriteAdapter(deps),
    linear: createLinearWriteAdapter(deps),
    asana: createAsanaWriteAdapter(deps),
    drive: createDriveWriteAdapter(deps),
    github: createGithubWriteAdapter(deps),
    telegram: createTelegramWriteAdapter(deps),
  };
}

/**
 * Select the write adapter for a target. `targetSystem` is TYPED `TargetSystem`,
 * but a tampered/malformed action (or a future unregistered enum member) could
 * carry a value outside the enum at RUNTIME — so the lookup is runtime-robust and
 * fails CLOSED. `Object.hasOwn` closes the prototype-pollution fail-OPEN vector: a
 * bare `registry[targetSystem]` returns a truthy PROTOTYPE member for
 * `"__proto__"`/`"constructor"`/`"prototype"`/`"toString"`/… — which would route an
 * external write to (e.g.) `Object.prototype.toString`. Fail-closed, code-only.
 */
export function selectWriteAdapter(
  registry: WriteAdapterRegistry,
  targetSystem: TargetSystem,
): Result<TargetWriteAdapter, WriteAdapterRoutingError> {
  if (!Object.hasOwn(registry, targetSystem)) {
    return err<WriteAdapterRoutingError>({ code: "unregistered_target" });
  }
  return ok(registry[targetSystem]);
}

const UNROUTED_MESSAGE =
  "write adapter not routed — select the vendor adapter by targetSystem via the registry";

/**
 * A fail-closed sentinel adapter — the defense-in-depth placeholder the composition
 * root puts on the `ExternalWriteDeps` bundle (the type requires an `adapter`).
 * Every op REJECTS, so an UNrouted dispatch writes NOTHING (never a silent
 * single-vendor write). {@link dispatchRouted} always overrides this with the
 * registry pick before dispatching; the sentinel only matters if routing is ever
 * bypassed, where fail-closed is the safe direction. `targetSystem` is INERT — the
 * ops reject before any transport request is built, so it is never read; it is
 * tagged with an arbitrary member solely to satisfy the port type.
 */
export function createUnroutedWriteAdapter(): TargetWriteAdapter {
  const rejected = (): Promise<Result<never, AdapterError>> =>
    Promise.resolve(err<AdapterError>({ code: "rejected", message: UNROUTED_MESSAGE }));
  return {
    targetSystem: "calendar",
    existenceCheck: rejected,
    create: rejected,
    update: rejected,
  };
}

/**
 * Route an external write through the registry: pick the vendor adapter by the
 * ACTION's `targetSystem`, override `deps.adapter` (a sentinel/placeholder) with it,
 * then run the §8 dispatch pipeline. An unregistered target FAILS CLOSED with a
 * `rejected` outcome WITHOUT dispatching (no existence probe, no create). The
 * `dispatch` fn is injected (defaults to `dispatchExternalWrite`) so the routing
 * logic is unit-testable without the full candidate-gate.
 */
export async function dispatchRouted(
  registry: WriteAdapterRegistry,
  env: ExternalWriteEnvelope,
  action: ProposedAction,
  deps: ExternalWriteDeps,
  dispatch: typeof dispatchExternalWrite = dispatchExternalWrite,
  /** C3 ordering — forwarded verbatim to the gateway (see `DispatchOptions`). A
   *  re-drive path supplies it; a fresh dispatch omits it. */
  opts?: DispatchOptions,
): Promise<ExternalWriteResult> {
  // Defense-in-depth: the adapter is selected by `action.targetSystem`, but the downstream
  // write (existence probe + receipt-store key) is namespaced by `env.targetSystem`.
  // `dispatchExternalWrite`'s candidate-gate (`envelopeMatchesAction`) already rejects a
  // divergence before any side effect — but `dispatch` is INJECTABLE, so guard the equality
  // HERE too: a mismatched env↔action FAILS CLOSED, never a mis-routed write to a vendor the
  // envelope was not built for (safety rule 3). Code-only reason (rule 7).
  if (env.targetSystem !== action.targetSystem) {
    return { status: "rejected", reason: "envelope/action targetSystem mismatch" };
  }
  const selected = selectWriteAdapter(registry, action.targetSystem);
  if (!selected.ok) {
    return {
      status: "rejected",
      reason: "unregistered target system: no write adapter registered",
    };
  }
  return dispatch(env, action, { ...deps, adapter: selected.value }, opts);
}
