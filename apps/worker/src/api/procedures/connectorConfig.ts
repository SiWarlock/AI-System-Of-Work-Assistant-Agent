// Task 14.2 — the `connectorConfig` command procedure: register / setState / setCadence.
//
// The operational connector-config surface (§19.1 / §8 / §11). Validates the candidate input
// at the transport edge (rule 7: a tokenRef REFERENCE only — the parser WHITELISTS fields, so a
// smuggled raw secret/token never reaches the port or the persisted row), calls the injected
// ConnectorConfigCommandPort (the real binding wraps the composition over @sow/db), and returns
// typed UI-safe summaries. §16: never throws; a fault surfaces a STABLE code, never the tokenRef
// target / any secret (rule 7). The UI summary OMITS tokenRef (rule-7-conservative). Mirrors
// onboarding.ts / projectRegistry.ts.
import { publicProcedure, router, authedResolver } from "../router";
import { ok, err, failure, type Result, type FailureVariant } from "@sow/contracts";
import type { ConnectorInstanceRow, ConnectorInstanceState } from "@sow/db";
import {
  type ConnectorConfigCommandPort,
  type RegisterConnectorInstanceInput,
  type RegisterConnectorError,
  type ConnectorConfigError,
} from "../../composition/connectorConfig";

// Re-export the port type so the integrator (server.ts) imports the whole surface from here.
export type { ConnectorConfigCommandPort };

/** The frozen enable/pause state set — narrows an untrusted input string at the transport edge. */
export const CONNECTOR_INSTANCE_STATES = ["enabled", "paused"] as const;

/** Dependencies for {@link buildConnectorConfigRouter}. */
export interface ConnectorConfigDeps {
  readonly connectorConfig: ConnectorConfigCommandPort;
}

/** The renderer-facing connector-instance summary — OMITS tokenRef (rule-7-conservative). */
export interface UiSafeConnectorInstance {
  readonly instanceId: string;
  readonly connectorId: string;
  readonly workspaceId: string;
  readonly state: string;
  readonly cadence: string;
}

// ── Input validation (candidate-data gate — PURE, no new dependency) ─────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function invalidInput(code: string): FailureVariant {
  return failure("validation_rejected", "invalid connector-config input", { cause: { code } });
}
const passthroughInput = (raw: unknown): unknown => raw;

/**
 * Validate a raw `register` input at the transport edge. Builds a WHITELISTED
 * {@link RegisterConnectorInstanceInput} (tokenRef REFERENCE only — a smuggled `secret`/`token`
 * field is NOT read, so it can never reach the port / the persisted row, rule 7). Returns a typed
 * `err(validation_rejected)` on any malformed field — never a throw.
 */
function parseRegister(raw: unknown): Result<RegisterConnectorInstanceInput, FailureVariant> {
  if (typeof raw !== "object" || raw === null) return err(invalidInput("REGISTER_INPUT_SHAPE"));
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["instanceId"])) return err(invalidInput("REGISTER_INSTANCE_ID"));
  if (!isNonEmptyString(r["connectorId"])) return err(invalidInput("REGISTER_CONNECTOR_ID"));
  if (!isNonEmptyString(r["workspaceId"])) return err(invalidInput("REGISTER_WORKSPACE_ID"));
  if (!isNonEmptyString(r["tokenRef"])) return err(invalidInput("REGISTER_TOKEN_REF"));
  if (!isNonEmptyString(r["cadence"])) return err(invalidInput("REGISTER_CADENCE"));
  // WHITELIST — pick ONLY the config fields; any other key (a smuggled secret) is discarded.
  return ok({
    instanceId: r["instanceId"],
    connectorId: r["connectorId"],
    workspaceId: r["workspaceId"],
    tokenRef: r["tokenRef"],
    cadence: r["cadence"],
  });
}

function parseSetState(raw: unknown): Result<{ instanceId: string; state: ConnectorInstanceState }, FailureVariant> {
  if (typeof raw !== "object" || raw === null) return err(invalidInput("SET_STATE_INPUT_SHAPE"));
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["instanceId"])) return err(invalidInput("SET_STATE_INSTANCE_ID"));
  const state = r["state"];
  if (typeof state !== "string" || !(CONNECTOR_INSTANCE_STATES as readonly string[]).includes(state)) {
    return err(invalidInput("SET_STATE_STATE"));
  }
  return ok({ instanceId: r["instanceId"], state: state as ConnectorInstanceState });
}

function parseSetCadence(raw: unknown): Result<{ instanceId: string; cadence: string }, FailureVariant> {
  if (typeof raw !== "object" || raw === null) return err(invalidInput("SET_CADENCE_INPUT_SHAPE"));
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r["instanceId"])) return err(invalidInput("SET_CADENCE_INSTANCE_ID"));
  if (!isNonEmptyString(r["cadence"])) return err(invalidInput("SET_CADENCE_CADENCE"));
  return ok({ instanceId: r["instanceId"], cadence: r["cadence"] });
}

/** Map a `RegisterConnectorError` → the §16 boundary taxonomy (redaction-safe — stable codes only). */
function registerErrorToFailure(e: RegisterConnectorError): FailureVariant {
  switch (e.code) {
    case "workspace_unknown":
      return failure("validation_rejected", "connector workspace is not registered", {
        cause: { code: "CONNECTOR_WORKSPACE_UNKNOWN" },
      });
    case "connector_instance_workspace_immutable":
      return failure("validation_rejected", "connector instance workspace is immutable", {
        cause: { code: "CONNECTOR_WORKSPACE_IMMUTABLE" },
      });
    case "store_fault":
      return failure("degraded_unavailable", "connector registry unavailable", {
        retryable: true,
        cause: { code: "CONNECTOR_STORE_FAULT" },
      });
  }
}

/** Map a `ConnectorConfigError` (state/cadence toggles) → the §16 boundary taxonomy. */
function toggleErrorToFailure(e: ConnectorConfigError): FailureVariant {
  switch (e.code) {
    case "instance_unknown":
      return failure("validation_rejected", "connector instance not found", {
        cause: { code: "CONNECTOR_INSTANCE_UNKNOWN" },
      });
    case "store_fault":
      return failure("degraded_unavailable", "connector registry unavailable", {
        retryable: true,
        cause: { code: "CONNECTOR_STORE_FAULT" },
      });
  }
}

/** Project a row → the UI-safe summary (drops tokenRef — rule-7-conservative). */
function toUiSafe(row: ConnectorInstanceRow): UiSafeConnectorInstance {
  return {
    instanceId: row.instanceId,
    connectorId: row.connectorId,
    workspaceId: row.workspaceId,
    state: row.state,
    cadence: row.cadence,
  };
}

// ── Router factory ──────────────────────────────────────────────────────────

/**
 * Build the connector-config router the integrator mounts at `appRouter.connectorConfig`. Each
 * procedure is a tRPC `.mutation()` wrapped in the 8.2 `authedResolver`, returning a
 * `Result<T, FailureVariant>` — never throws. Config routes through the injected port (one-writer;
 * config only — no live vendor call, tokenRef reference-only rule 7).
 */
export function buildConnectorConfigRouter(deps: ConnectorConfigDeps) {
  const { connectorConfig } = deps;
  return router({
    /** Register a connector instance bound to a 14.1-registered workspace (config only; paused). */
    register: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeConnectorInstance>(
        async (_ctx, input): Promise<Result<UiSafeConnectorInstance, FailureVariant>> => {
          const parsed = parseRegister(input);
          if (!parsed.ok) return err(parsed.error);
          const res = await connectorConfig.register(parsed.value);
          if (!res.ok) return err(registerErrorToFailure(res.error));
          return ok(toUiSafe(res.value));
        },
      ),
    ),

    /** Toggle an existing instance's enable/pause state. */
    setState: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeConnectorInstance>(
        async (_ctx, input): Promise<Result<UiSafeConnectorInstance, FailureVariant>> => {
          const parsed = parseSetState(input);
          if (!parsed.ok) return err(parsed.error);
          const res = await connectorConfig.setState(parsed.value);
          if (!res.ok) return err(toggleErrorToFailure(res.error));
          return ok(toUiSafe(res.value));
        },
      ),
    ),

    /** Update an existing instance's cadence. */
    setCadence: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeConnectorInstance>(
        async (_ctx, input): Promise<Result<UiSafeConnectorInstance, FailureVariant>> => {
          const parsed = parseSetCadence(input);
          if (!parsed.ok) return err(parsed.error);
          const res = await connectorConfig.setCadence(parsed.value);
          if (!res.ok) return err(toggleErrorToFailure(res.error));
          return ok(toUiSafe(res.value));
        },
      ),
    ),
  });
}
