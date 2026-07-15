// Task 14.2 — the `connectorConfig` tRPC procedure. RED-first spec.
//
// register / setState / setCadence over the injected ConnectorConfigCommandPort. Validates
// the candidate input at the transport edge (rule 7: a tokenRef REFERENCE only — no secret
// field is accepted), returns typed UI-safe summaries, never throws, never echoes the
// tokenRef target / any secret (§16 / rule 7). Behind the auth gate.
import { describe, it, expect } from "vitest";
import { isErr, isOk, type Result } from "@sow/contracts";
import type { ConnectorInstanceRow } from "@sow/db";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import {
  buildConnectorConfigRouter,
  type ConnectorConfigCommandPort,
} from "../../../src/api/procedures/connectorConfig";
import type {
  RegisterConnectorInstanceInput,
  RegisterConnectorError,
  ConnectorConfigError,
} from "../../../src/composition/connectorConfig";

const AUTHED_CTX: ApiContext = { auth: { ok: true, value: { authenticated: true } } };
const UNAUTH_CTX: ApiContext = {
  auth: { ok: false, error: { kind: "validation_rejected", message: "unauthenticated", retryable: false } },
};

const VALID_REGISTER = {
  instanceId: "gdrive-1",
  connectorId: "google-drive",
  workspaceId: "employer-work",
  tokenRef: "keychain:sow/employer-work/google-drive",
  cadence: "0 */6 * * *",
};

function rowOf(input: RegisterConnectorInstanceInput): ConnectorInstanceRow {
  return {
    instanceId: input.instanceId,
    connectorId: input.connectorId,
    workspaceId: input.workspaceId as ConnectorInstanceRow["workspaceId"],
    tokenRef: input.tokenRef,
    state: "paused",
    cadence: input.cadence,
  };
}

class FakePort implements ConnectorConfigCommandPort {
  registerCalls: RegisterConnectorInstanceInput[] = [];
  constructor(
    private readonly registerOutcome: (i: RegisterConnectorInstanceInput) => Result<ConnectorInstanceRow, RegisterConnectorError>,
  ) {}
  async register(input: RegisterConnectorInstanceInput): Promise<Result<ConnectorInstanceRow, RegisterConnectorError>> {
    this.registerCalls.push(input);
    return this.registerOutcome(input);
  }
  async setState(input: { instanceId: string; state: "enabled" | "paused" }): Promise<Result<ConnectorInstanceRow, ConnectorConfigError>> {
    return { ok: true, value: { ...rowOf(VALID_REGISTER), state: input.state } };
  }
  async setCadence(input: { instanceId: string; cadence: string }): Promise<Result<ConnectorInstanceRow, ConnectorConfigError>> {
    return { ok: true, value: { ...rowOf(VALID_REGISTER), cadence: input.cadence } };
  }
}

function caller(port: ConnectorConfigCommandPort, ctx: ApiContext = AUTHED_CTX) {
  const appRouter = router({ connectorConfig: buildConnectorConfigRouter({ connectorConfig: port }) });
  return createCallerFactory(appRouter)(ctx);
}

describe("connectorConfig procedure (14.2)", () => {
  it("register_round_trips: validates input, calls the port, returns a typed UI-safe summary [spec(§8)]", async () => {
    const port = new FakePort((i) => ({ ok: true, value: rowOf(i) }));
    const res = await caller(port).connectorConfig.register(VALID_REGISTER);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.instanceId).toBe("gdrive-1");
      expect(res.value.state).toBe("paused");
    }
    expect(port.registerCalls).toHaveLength(1);
  });

  it("register_rejects_malformed_input: an unknown state / empty tokenRef / empty cadence ⇒ validation_rejected, never reaches the port [spec(§16)]", async () => {
    const port = new FakePort((i) => ({ ok: true, value: rowOf(i) }));
    const c = caller(port);
    const emptyTokenRef = await c.connectorConfig.register({ ...VALID_REGISTER, tokenRef: "" });
    const emptyCadence = await c.connectorConfig.register({ ...VALID_REGISTER, cadence: "" });
    const missingConnector = await c.connectorConfig.register({ ...VALID_REGISTER, connectorId: "" });
    expect(isErr(emptyTokenRef)).toBe(true);
    expect(isErr(emptyCadence)).toBe(true);
    expect(isErr(missingConnector)).toBe(true);
    expect(port.registerCalls).toHaveLength(0);
  });

  it("register_rejects_raw_secret_field: an input carrying a raw secret field is NOT accepted as a credential — only the tokenRef reference is persisted (rule 7) [spec(§8)]", async () => {
    const port = new FakePort((i) => ({ ok: true, value: rowOf(i) }));
    // Even if a caller smuggles a `secret`/`token` field — OR a `state:"enabled"` to bypass the
    // always-paused fail-safe — the parser builds a whitelisted input (config fields only), so the
    // raw field never reaches the port / the persisted row.
    const res = await caller(port).connectorConfig.register({
      ...VALID_REGISTER,
      secret: "hunter2",
      token: "raw-bytes",
      state: "enabled",
    } as never);
    expect(isOk(res)).toBe(true);
    const forwarded = port.registerCalls[0] as Record<string, unknown> | undefined;
    expect(forwarded).toBeDefined();
    expect(forwarded).not.toHaveProperty("secret");
    expect(forwarded).not.toHaveProperty("token");
    expect(forwarded).not.toHaveProperty("state"); // the always-paused fail-safe can't be smuggled past
  });

  it("error_is_typed_no_secret_echoed: a fault ⇒ stable code; the tokenRef target / raw driver cause never crosses (§16 / rule 7) [spec(§16)]", async () => {
    const port = new FakePort(() => ({
      ok: false,
      error: { code: "store_fault", message: "postgres: FATAL keychain:sow/SECRET-REF refused" },
    }));
    const res = await caller(port).connectorConfig.register(VALID_REGISTER);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(JSON.stringify(res.error)).not.toContain("SECRET-REF");
      expect(JSON.stringify(res.error)).not.toContain("postgres");
    }
  });

  it("setState / setCadence round-trip through the procedure [spec(§8)]", async () => {
    const port = new FakePort((i) => ({ ok: true, value: rowOf(i) }));
    const c = caller(port);
    const enabled = await c.connectorConfig.setState({ instanceId: "gdrive-1", state: "enabled" });
    const cadence = await c.connectorConfig.setCadence({ instanceId: "gdrive-1", cadence: "@daily" });
    expect(isOk(enabled) && enabled.value.state).toBe("enabled");
    expect(isOk(cadence) && cadence.value.cadence).toBe("@daily");
  });

  it("requires_auth: an unauthenticated caller gets a typed err, the port never runs [spec(§16)]", async () => {
    const port = new FakePort((i) => ({ ok: true, value: rowOf(i) }));
    const res = await caller(port, UNAUTH_CTX).connectorConfig.register(VALID_REGISTER);
    expect(isErr(res)).toBe(true);
    expect(port.registerCalls).toHaveLength(0);
  });
});
