import { useState, type ReactElement } from "react";
import type {
  UiSafeConnectorInstanceView,
  RegisterConnectorInput,
  ConnectorConfigResult,
} from "../../lib/connector-config";

// Task 14.2 (desktop leg) — the connectors settings surface. Per the SELECTED onboarded workspace
// (WS-8): register a connector instance + enable/pause + set cadence, driving connectorConfig via
// injected callbacks (unit-testable without a live bridge). The list is the OPTIMISTIC store slice
// (no cold-load list read yet — a worker follow-up), so it's empty-until-data on cold load.
//
// RULE 7 — tokenRef is an opaque REFERENCE the user NAMES (e.g. `keychain://my-drive-token`), NOT a
// secret: it is forwarded on register (the worker resolves it via SecretsPort) and then CLEARED
// from the form; it is never displayed/echoed back (the UI-safe instance summary carries no
// tokenRef). WS-8 — with no onboarded workspace selected (workspaceId null), the form is disabled.

/** The known connector vendors (a UI convenience list; the worker validates the id). */
const KNOWN_CONNECTORS = ["drive", "calendar", "linear", "granola", "github", "gmail", "asana"] as const;

export interface ConnectorsProps {
  /** The SELECTED onboarded workspace's real id, or null (global / non-onboarded → disabled). */
  readonly workspaceId: string | null;
  /** The selected workspace's connector instances (WS-8 filtered upstream). */
  readonly instances: readonly UiSafeConnectorInstanceView[];
  readonly onRegister: (input: RegisterConnectorInput) => Promise<ConnectorConfigResult>;
  readonly onSetState: (instanceId: string, state: "enabled" | "paused") => Promise<ConnectorConfigResult>;
  readonly onSetCadence: (instanceId: string, cadence: string) => Promise<ConnectorConfigResult>;
}

export function Connectors(props: ConnectorsProps): ReactElement {
  const { workspaceId, instances, onRegister, onSetState, onSetCadence } = props;
  const [connectorId, setConnectorId] = useState<string>(KNOWN_CONNECTORS[0]);
  const [tokenRef, setTokenRef] = useState("");
  const [cadence, setCadence] = useState("@daily");
  // Per-instance cadence edits (seeded from each instance's own cadence) — the "Set cadence" button
  // applies THIS row's value, never the register form's (which is for register only).
  const [rowCadence, setRowCadence] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scoped = workspaceId !== null;
  const canRegister = scoped && tokenRef.trim().length > 0 && cadence.trim().length > 0 && !busy;

  const submitRegister = (): void => {
    if (!canRegister || workspaceId === null) return;
    setBusy(true);
    setError(null);
    const input: RegisterConnectorInput = {
      // Deterministic, idempotent id: one instance per connector per workspace (re-register updates).
      instanceId: `${connectorId}@${workspaceId}`,
      connectorId,
      workspaceId,
      tokenRef: tokenRef.trim(),
      cadence: cadence.trim(),
    };
    void onRegister(input)
      .then((r) => {
        if (!r.ok) setError("Couldn't register the connector. Check the reference and try again.");
      })
      .catch(() => setError("Couldn't register the connector. Check the reference and try again."))
      .finally(() => {
        setBusy(false);
        // Rule 7: clear the entered reference after submit regardless of outcome — never retained.
        setTokenRef("");
      });
  };

  const toggle = (inst: UiSafeConnectorInstanceView): void => {
    setError(null);
    void onSetState(inst.instanceId, inst.state === "enabled" ? "paused" : "enabled").then((r) => {
      if (!r.ok) setError("Couldn't change the connector state.");
    });
  };

  const applyCadence = (inst: UiSafeConnectorInstanceView): void => {
    setError(null);
    const next = (rowCadence[inst.instanceId] ?? inst.cadence).trim();
    void onSetCadence(inst.instanceId, next).then((r) => {
      if (!r.ok) setError("Couldn't update the cadence.");
    });
  };

  return (
    <div className="sow-connectors" role="main" aria-label="Connectors">
      <h1>Connectors</h1>

      {!scoped ? (
        <div className="sow-empty" role="status">
          Select an onboarded workspace to configure its connectors.
        </div>
      ) : (
        <>
          <section aria-label="Register a connector">
            <label>
              Connector
              <select value={connectorId} onChange={(e) => setConnectorId(e.target.value)} aria-label="Connector">
                {KNOWN_CONNECTORS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Token reference
              <input
                type="text"
                value={tokenRef}
                placeholder="keychain://my-connector-token"
                onChange={(e) => setTokenRef(e.target.value)}
                aria-label="Token reference"
              />
            </label>
            <label>
              Cadence
              <input
                type="text"
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
                aria-label="Cadence"
              />
            </label>
            <button type="button" disabled={!canRegister} onClick={submitRegister}>
              Register connector
            </button>
          </section>

          {error !== null ? (
            <div role="alert" className="sow-connectors-error">
              {error}
            </div>
          ) : null}

          {instances.length === 0 ? (
            <div className="sow-empty" role="status">
              No connectors registered for this workspace yet.
            </div>
          ) : (
            <ul className="sow-connector-list" aria-label="Registered connectors">
              {instances.map((inst) => (
                <li key={inst.instanceId} className="sow-connector-item" data-instance-id={inst.instanceId} data-state={inst.state}>
                  <span className="sow-connector-id">{inst.connectorId}</span>
                  <span className="sow-connector-state">{inst.state}</span>
                  <span className="sow-connector-cadence">{inst.cadence}</span>
                  <button
                    type="button"
                    onClick={() => toggle(inst)}
                    aria-label={`${inst.state === "enabled" ? "Pause" : "Enable"} ${inst.connectorId}`}
                  >
                    {inst.state === "enabled" ? "Pause" : "Enable"}
                  </button>
                  <input
                    type="text"
                    value={rowCadence[inst.instanceId] ?? inst.cadence}
                    onChange={(e) => setRowCadence((m) => ({ ...m, [inst.instanceId]: e.target.value }))}
                    aria-label={`Cadence for ${inst.connectorId}`}
                  />
                  <button type="button" onClick={() => applyCadence(inst)} aria-label={`Set cadence for ${inst.connectorId}`}>
                    Set cadence
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
