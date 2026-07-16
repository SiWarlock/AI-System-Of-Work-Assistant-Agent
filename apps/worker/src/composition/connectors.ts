// Task 16.1 — boot composition of the connector-engine substrate (§19.3 / §8).
//
// Composes a `ComposedConnectors` over the full set of read-adapter `ConnectorPort`s
// (7 vendor + url/telegram) at worker boot, each built over a SINGLE injected
// `ConnectorTransport`. The shipped default is the INERT transport
// (`createInertConnectorTransport`) — it binds NO real network client and NO tokenRef,
// so every fetch fails closed with a typed `unreachable`: the substrate exists + all
// adapters are wired, but NO adapter can perform a live vendor call.
//
// DORMANCY (LOAD-BEARING, NO hard line): composition reads NO secret (SecretsPort is
// Phase 17) and drives NO fetch — it only constructs in-memory ports. Binding a real
// `HttpTransport` (+ its SecretsAccessor tokenRef) is the Phase-23 owner-arming crossing
// (a HARD LINE); until then this engine is inert. 16.2 binds the poll registration that
// drives `gateway.ports` through the §8 `runConnectorSync` engine.
import {
  createAsanaConnector,
  createDriveConnector,
  createCalendarConnector,
  createGranolaConnector,
  createGithubConnector,
  createLinearConnector,
  createGmailConnector,
  createUrlSourceConnector,
  createTelegramCaptureConnector,
  type ConnectorPort,
  type ConnectorTransport,
  type ConnectorTransportResult,
} from "@sow/integrations";

/** The composed set of connector ports, keyed by `connectorId` (a stable, unique set). */
export type ConnectorPorts = ReadonlyMap<string, ConnectorPort>;

/** The boot-composed connector engine substrate: the full read-adapter port set. */
export interface ComposedConnectors {
  readonly ports: ConnectorPorts;
}

/**
 * The INERT default connector transport — the shipped default. It binds NO real
 * network send and NO tokenRef: every call fails closed with a typed `unreachable`,
 * so a composed port can never produce a real vendor page. Binding a real
 * `HttpTransport` (+ its SecretsAccessor tokenRef) in its place is the Phase-23
 * owner-arming crossing (a HARD LINE) — the whole engine is armed by that ONE
 * transport injection (L23/L27 dormancy seam).
 */
export function createInertConnectorTransport(): ConnectorTransport {
  return async (): Promise<ConnectorTransportResult> => ({
    ok: false,
    code: "unreachable",
    message: "connector transport not bound (dormant substrate — Phase 23)",
  });
}

/**
 * The read-adapter factory set composed at boot (7 vendor + url/telegram). Each takes
 * the injected `ConnectorTransport` and returns a `ConnectorPort` with a unique
 * `connectorId`.
 *
 * EXCLUSIONS (intentional, not an oversight):
 *   • todoist — has `createTodoistConnector` but NO real `createTodoistHttpTransport`
 *     yet, so composing it now would be a permanently-inert entry with nothing for
 *     Phase-23 to bind; it joins this set WHEN its real transport is built.
 *   • obsidian-vault — a read-tool-descriptor surface (KN-4/KN-9), NOT a ConnectorPort.
 */
const ADAPTER_FACTORIES: readonly ((transport: ConnectorTransport) => ConnectorPort)[] = [
  createAsanaConnector,
  createDriveConnector,
  createCalendarConnector,
  createGranolaConnector,
  createGithubConnector,
  createLinearConnector,
  createGmailConnector,
  createUrlSourceConnector,
  createTelegramCaptureConnector,
];

/**
 * Build the `connectorId → ConnectorPort` map from a factory set over one transport.
 * FAIL-FAST on a duplicate `connectorId` (worker L39/L30): a silent map overwrite would
 * drop a connector — a source that is then never polled (a silent black hole). Throwing
 * at composition surfaces the misconfiguration loudly, once, before any record flows.
 */
export function buildConnectorPorts(
  factories: readonly ((transport: ConnectorTransport) => ConnectorPort)[],
  transport: ConnectorTransport,
): Map<string, ConnectorPort> {
  const ports = new Map<string, ConnectorPort>();
  for (const factory of factories) {
    const port = factory(transport);
    if (ports.has(port.connectorId)) {
      throw new Error(`connector composition: duplicate connectorId "${port.connectorId}"`);
    }
    ports.set(port.connectorId, port);
  }
  return ports;
}

/**
 * Compose the connector-engine substrate at boot: build every read adapter over a
 * single injected `transport` (default: the inert, no-tokenRef transport) and index
 * the ports by `connectorId`. DORMANT by construction — no real transport, no secret
 * read, and ZERO fetch driven (composition only constructs ports). 16.2 binds the poll
 * registration that drives these ports.
 */
export function composeConnectors(
  transport: ConnectorTransport = createInertConnectorTransport(),
): ComposedConnectors {
  return { ports: buildConnectorPorts(ADAPTER_FACTORIES, transport) };
}
