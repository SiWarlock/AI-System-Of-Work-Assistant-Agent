import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import type { UiSafeConnectorInstanceView } from "../store/connectors";

// Task 14.2 (desktop leg) — the renderer connector-config command-callers. The renderer only
// REQUESTS config — the worker (connectorConfig.register/setState/setCadence) owns the candidate-
// data gate, the tokenRef reference-only whitelist, the one-writer persist, and the UI-safe summary
// (which OMITS tokenRef). These wrappers fold a typed err / transport throw / malformed ok to
// { ok: false } (desktop Lesson 6). RULE 7: tokenRef is an opaque REFERENCE the user names — it is
// forwarded on register (the worker resolves it via SecretsPort) and NEVER round-tripped back.
export type { UiSafeConnectorInstanceView };

/** The register form input (tokenRef is a REFERENCE the user names, never a raw secret). */
export interface RegisterConnectorInput {
  readonly instanceId: string;
  readonly connectorId: string;
  readonly workspaceId: string;
  readonly tokenRef: string;
  readonly cadence: string;
}

export type ConnectorConfigResult =
  | { readonly ok: true; readonly instance: UiSafeConnectorInstanceView }
  | { readonly ok: false };

/** Accept only a well-formed ok whose value is a connector-instance summary (defense-in-depth). */
function foldInstance(res: { ok?: unknown; value?: unknown }): ConnectorConfigResult {
  if (
    res.ok === true &&
    res.value != null &&
    typeof res.value === "object" &&
    typeof (res.value as Record<string, unknown>)["instanceId"] === "string" &&
    typeof (res.value as Record<string, unknown>)["workspaceId"] === "string" &&
    typeof (res.value as Record<string, unknown>)["state"] === "string"
  ) {
    const v = res.value as Record<string, unknown>;
    // Reconstruct from the allowlisted fields ONLY — a stray field (e.g. a leaked tokenRef from a
    // future server regression) is dropped, never folded into the store (rule 7).
    return {
      ok: true,
      instance: {
        instanceId: v["instanceId"] as string,
        connectorId: typeof v["connectorId"] === "string" ? (v["connectorId"] as string) : "",
        workspaceId: v["workspaceId"] as string,
        state: v["state"] as string,
        cadence: typeof v["cadence"] === "string" ? (v["cadence"] as string) : "",
      },
    };
  }
  return { ok: false };
}

/** Register a connector instance (config only; the instance is created PAUSED, worker-side). */
export function createRegisterConnector(
  client: CreateTRPCClient<AppRouter>,
): (input: RegisterConnectorInput) => Promise<ConnectorConfigResult> {
  return async (input: RegisterConnectorInput): Promise<ConnectorConfigResult> => {
    try {
      return foldInstance(await client.connectorConfig.register.mutate(input));
    } catch {
      return { ok: false };
    }
  };
}

/** Toggle an instance's enable/pause state. */
export function createSetConnectorState(
  client: CreateTRPCClient<AppRouter>,
): (instanceId: string, state: "enabled" | "paused") => Promise<ConnectorConfigResult> {
  return async (instanceId: string, state: "enabled" | "paused"): Promise<ConnectorConfigResult> => {
    try {
      return foldInstance(await client.connectorConfig.setState.mutate({ instanceId, state }));
    } catch {
      return { ok: false };
    }
  };
}

/** Update an instance's cadence. */
export function createSetConnectorCadence(
  client: CreateTRPCClient<AppRouter>,
): (instanceId: string, cadence: string) => Promise<ConnectorConfigResult> {
  return async (instanceId: string, cadence: string): Promise<ConnectorConfigResult> => {
    try {
      return foldInstance(await client.connectorConfig.setCadence.mutate({ instanceId, cadence }));
    } catch {
      return { ok: false };
    }
  };
}
