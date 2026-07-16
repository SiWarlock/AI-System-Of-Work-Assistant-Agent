// Task 16.1 — boot composition of the connector-engine substrate (worker leg). RED-first.
//
// `composeConnectors()` builds a ComposedConnectors port set over ConnectorPorts from every read
// adapter factory (7 vendor + url/telegram) against a FAKE/INERT transport with NO
// tokenRef bound. LOAD-BEARING dormancy (§19.3 / §8, NO hard line): the composed
// substrate exists + all adapters are wired, but NO adapter can perform a live vendor
// call (no real transport, no secret read) — binding a real HttpTransport is Phase 23.
import { describe, it, expect } from "vitest";
import { isErr } from "@sow/contracts";
import type {
  ConnectorTransport,
  ConnectorTransportResult,
  TransportRequest,
} from "@sow/integrations";
import { makeConnector } from "@sow/integrations";
import {
  composeConnectors,
  createInertConnectorTransport,
  buildConnectorPorts,
} from "../../src/composition/connectors";

// The full read-adapter set the composed gateway must expose (7 vendor + url/telegram).
// todoist is DROPPED (no real HttpTransport); the obsidian-vault surface is a different
// shape (read-tool descriptors, not a ConnectorPort) — both intentionally excluded.
const EXPECTED_ADAPTERS = [
  "asana",
  "drive",
  "calendar",
  "granola",
  "github",
  "linear",
  "gmail",
  "url-source",
  "telegram-capture",
] as const;

describe("composeConnectors (16.1 — boot composition of the connector engine substrate)", () => {
  it("boot_composes_a_connector_gateway_over_all_adapters: exposes every read adapter (7 vendor + url/telegram); no missing / no duplicate [spec(§19.3)]", () => {
    const gateway = composeConnectors();
    expect([...gateway.ports.keys()].sort()).toEqual([...EXPECTED_ADAPTERS].sort());
    expect(gateway.ports.size).toBe(EXPECTED_ADAPTERS.length); // a collision would shrink the map
    // Every entry is a real ConnectorPort whose connectorId matches its map key.
    for (const [id, port] of gateway.ports) expect(port.connectorId).toBe(id);
  });

  it("composed_gateway_binds_no_real_transport: the shipped default is INERT — zero live vendor call at boot, fail-closed on fetch [spec(§8)]", async () => {
    // (a) composition drives NO fetch — a spy transport is invoked 0 times by composeConnectors
    //     (factory-spy zero-invocation — the dormancy pin, worker L11/L27).
    let calls = 0;
    const spy: ConnectorTransport = async (): Promise<ConnectorTransportResult> => {
      calls += 1;
      return { ok: false, code: "unreachable", message: "spy" };
    };
    const spied = composeConnectors(spy);
    expect(calls).toBe(0);
    expect(spied.ports.size).toBe(EXPECTED_ADAPTERS.length);

    // (b) the SHIPPED-DEFAULT inert transport performs NO real send — it fails closed with a
    //     typed `unreachable`, so a driven port NEVER produces a real vendor page.
    const inert = createInertConnectorTransport();
    const raw = await inert({ readScope: "x" });
    expect(raw.ok).toBe(false);
    expect(raw.ok === false && raw.code).toBe("unreachable");
    const asana = composeConnectors().ports.get("asana");
    const fetched = await asana!.fetch();
    expect(isErr(fetched) && fetched.error.code).toBe("unreachable");
  });

  it("composition_binds_no_tokenref_reads_no_secret: composeConnectors takes no SecretsAccessor; a driven fetch routes a request carrying ONLY {cursor?, readScope} — no token/secret [spec(§8)]", async () => {
    let seen: TransportRequest | undefined;
    const spy: ConnectorTransport = async (req): Promise<ConnectorTransportResult> => {
      seen = req;
      return { ok: false, code: "unreachable", message: "spy" };
    };
    const gateway = composeConnectors(spy);
    await gateway.ports.get("gmail")!.fetch("cur-1");
    // The request carries the adapter's least-privilege readScope + the resume cursor —
    // and NOTHING else. No tokenRef / secret / credential is bound by composition.
    expect(seen).toBeDefined();
    expect(Object.keys(seen as object).sort()).toEqual(["cursor", "readScope"]);
    expect((seen as TransportRequest).readScope).toBe("gmail.readonly");
    expect((seen as TransportRequest).cursor).toBe("cur-1");
  });

  it("duplicate_connectorId_fails_fast: two factories emitting the SAME connectorId throw at composition (no silent drop, worker L39/L30)", () => {
    const inert = createInertConnectorTransport();
    const dupFactory = (t: ConnectorTransport) => makeConnector({ connectorId: "dup", readScope: "r" }, t);
    // A duplicate would silently overwrite (dropping a connector = a source never polled);
    // buildConnectorPorts fails loud instead.
    expect(() => buildConnectorPorts([dupFactory, dupFactory], inert)).toThrow(/duplicate connectorId "dup"/);
    // A distinct set builds fine (positive control).
    const distinct = (t: ConnectorTransport) => makeConnector({ connectorId: "solo", readScope: "r" }, t);
    expect(buildConnectorPorts([dupFactory, distinct], inert).size).toBe(2);
  });
});
