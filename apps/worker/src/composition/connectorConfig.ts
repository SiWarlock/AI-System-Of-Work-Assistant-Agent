// Task 14.2 — the per-workspace connector-instance config registry composition (worker leg).
//
// The OPERATIONAL connector-config surface: register a connector instance bound to a
// 14.1-registered workspace (recording an opaque tokenRef REFERENCE — never credential
// bytes, rule 7), and toggle its enable/pause state + cadence. CONFIG ONLY — no live vendor
// call, no credential resolution (SecretsPort/Keychain resolve the tokenRef at arming,
// Phase 17/23). The Phase-16 connector composition + Phase-23 arming CONSUME this record.
//
// WS-8 (rule 4): register binds only to a workspace KNOWN in the 14.1 registry (fail-closed),
// and the project's workspace binding is IMMUTABLE — re-registering an existing instanceId
// with a changed workspaceId is rejected (consistent with 14.1/14.6). §16: never throws.
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import type {
  ConnectorInstanceRepository,
  ConnectorInstanceRow,
  ConnectorInstanceState,
  ReadModelRepository,
} from "@sow/db";
import { resolveKnownWorkspace } from "../api/adapters/readModel";

/** The onboarding inputs to register a connector instance. `state` is NOT an input — a fresh
 * (or re-)register always lands `paused` (fail-safe); enabling is an explicit `setState` toggle. */
export interface RegisterConnectorInstanceInput {
  readonly instanceId: string;
  readonly connectorId: string;
  /** The BOUND workspace — MUST be a 14.1-registered workspace; IMMUTABLE once set. */
  readonly workspaceId: string;
  /** Opaque Keychain REFERENCE to the credential — NEVER the secret bytes (rule 7). */
  readonly tokenRef: string;
  /** Opaque cadence expression (cron/interval). */
  readonly cadence: string;
}

/** Deps for register — the repo + the 14.1 workspace registry read (WS-8 gate). NO secrets/vault. */
export interface RegisterConnectorInstanceDeps {
  readonly repo: ConnectorInstanceRepository;
  readonly readModels: ReadModelRepository;
}

/** Deps for the state/cadence toggles — the repo only (the instance is already ws-bound). */
export interface ConnectorConfigStateDeps {
  readonly repo: ConnectorInstanceRepository;
}

/** Typed, redaction-safe register failures (never a raw driver cause / tokenRef target — rule 7). */
export type RegisterConnectorError =
  | { readonly code: "workspace_unknown"; readonly message: string }
  // The connector instance's workspaceId is its WS-2/WS-8 binding anchor — IMMUTABLE.
  | { readonly code: "connector_instance_workspace_immutable"; readonly message: string }
  | { readonly code: "store_fault"; readonly message: string };

/** Typed, redaction-safe state/cadence-toggle failures. */
export type ConnectorConfigError =
  | { readonly code: "instance_unknown"; readonly message: string }
  | { readonly code: "store_fault"; readonly message: string };

/**
 * Register (or re-register) a connector instance bound to a 14.1-REGISTERED workspace. Persists
 * ONLY config — the opaque tokenRef REFERENCE (never credential bytes), never a live vendor call.
 * Fails closed on an unregistered workspace, a changed workspace binding, or a store fault.
 * Never throws.
 */
export async function registerConnectorInstance(
  deps: RegisterConnectorInstanceDeps,
  input: RegisterConnectorInstanceInput,
): Promise<Result<ConnectorInstanceRow, RegisterConnectorError>> {
  try {
    // 1. WS-8: a connector instance can only bind to a workspace KNOWN in the 14.1 registry.
    const known = await resolveKnownWorkspace(deps.readModels, input.workspaceId);
    if (!known.ok) {
      return err({ code: "store_fault", message: "workspace registry unavailable" });
    }
    if (!known.value) {
      return err({ code: "workspace_unknown", message: "cannot bind a connector to an unregistered workspace" });
    }

    // 2. WS-2/WS-8 ANCHOR IMMUTABILITY guard (consistent with 14.1/14.6). A connector's
    //    workspaceId binds which workspace's data it reads + where its future reads land —
    //    re-registering an existing instanceId with a DIFFERENT workspaceId would silently move
    //    it across the isolation boundary. Reject it; a get-fault fails closed (no upsert).
    //    arch_gap (concurrency): this get-then-upsert is non-atomic (TOCTOU) — two concurrent
    //    same-instanceId registers with different workspaces could race the guard. Near-impossible
    //    on the local single-operator loopback control plane; a single-writer/CAS is the follow-up.
    const existing = await deps.repo.get(input.instanceId);
    if (isOk(existing)) {
      if (existing.value.workspaceId !== input.workspaceId) {
        return err({ code: "connector_instance_workspace_immutable", message: "connector instance workspace is immutable" });
      }
      // same workspace ⇒ an idempotent config re-write; fall through.
    } else if (existing.error.code !== "not_found") {
      return err({ code: "store_fault", message: "connector instance get failed" });
    }

    // 3. Build the config row. A (re-)register always lands `paused` — INTENTIONAL: a credential/
    //    config re-bind re-pauses until the operator re-enables (fail-safe; enabling is an explicit
    //    setState toggle). tokenRef is stored as an opaque REFERENCE (rule 7 — never resolved here).
    const row: ConnectorInstanceRow = {
      instanceId: input.instanceId,
      connectorId: input.connectorId,
      workspaceId: input.workspaceId as WorkspaceId,
      tokenRef: input.tokenRef,
      state: "paused",
      cadence: input.cadence,
    };

    // 4. Upsert the CONFIG row (no live vendor call, no credential resolution).
    const up = await deps.repo.upsert(row);
    if (isErr(up)) {
      return err({ code: "store_fault", message: "connector instance upsert failed" });
    }
    return ok(up.value);
  } catch {
    return err({ code: "store_fault", message: "connector instance registration failed" });
  }
}

/** Map a repo `setState`/`setCadence` fault → the typed toggle error (not_found ⇒ instance_unknown). */
function toggleError(code: string): ConnectorConfigError {
  return code === "not_found"
    ? { code: "instance_unknown", message: "connector instance not found" }
    : { code: "store_fault", message: "connector instance update failed" };
}

/** Set an existing instance's enable/pause state. Absent instance ⇒ instance_unknown. Never throws. */
export async function setConnectorInstanceState(
  deps: ConnectorConfigStateDeps,
  instanceId: string,
  state: ConnectorInstanceState,
): Promise<Result<ConnectorInstanceRow, ConnectorConfigError>> {
  try {
    const res = await deps.repo.setState(instanceId, state);
    return isErr(res) ? err(toggleError(res.error.code)) : ok(res.value);
  } catch {
    return err({ code: "store_fault", message: "connector instance state update failed" });
  }
}

/** Set an existing instance's cadence. Absent instance ⇒ instance_unknown. Never throws. */
export async function setConnectorInstanceCadence(
  deps: ConnectorConfigStateDeps,
  instanceId: string,
  cadence: string,
): Promise<Result<ConnectorInstanceRow, ConnectorConfigError>> {
  try {
    const res = await deps.repo.setCadence(instanceId, cadence);
    return isErr(res) ? err(toggleError(res.error.code)) : ok(res.value);
  } catch {
    return err({ code: "store_fault", message: "connector instance cadence update failed" });
  }
}

// ── injected command port (mirror onboarding / projectRegistry) ───────────────

/** The injected connector-config command port — the procedure's ONLY registry I/O. */
export interface ConnectorConfigCommandPort {
  register(input: RegisterConnectorInstanceInput): Promise<Result<ConnectorInstanceRow, RegisterConnectorError>>;
  setState(input: { instanceId: string; state: ConnectorInstanceState }): Promise<Result<ConnectorInstanceRow, ConnectorConfigError>>;
  setCadence(input: { instanceId: string; cadence: string }): Promise<Result<ConnectorInstanceRow, ConnectorConfigError>>;
}

/** Build the real {@link ConnectorConfigCommandPort} over the composition fns + the durable store. */
export function createConnectorConfigCommandPort(deps: RegisterConnectorInstanceDeps): ConnectorConfigCommandPort {
  return {
    register: (input) => registerConnectorInstance(deps, input),
    setState: (input) => setConnectorInstanceState({ repo: deps.repo }, input.instanceId, input.state),
    setCadence: (input) => setConnectorInstanceCadence({ repo: deps.repo }, input.instanceId, input.cadence),
  };
}
