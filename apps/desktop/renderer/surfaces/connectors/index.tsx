import { useState, type ReactElement } from "react";
import type {
  UiSafeConnectorInstanceView,
  RegisterConnectorInput,
  ConnectorConfigResult,
} from "../../lib/connector-config";
import { KNOWN_CONNECTORS } from "../../lib/connector-catalog";
import { connectorCredentialRef, isWriteTarget } from "../../lib/connector-credential-ref";

// Task 14.2 (desktop leg) — the connectors settings surface. Per the SELECTED onboarded workspace
// (WS-8): register a connector instance + enable/pause + set cadence, driving connectorConfig via
// injected callbacks (unit-testable without a live bridge). The list is the OPTIMISTIC store slice
// (no cold-load list read yet — a worker follow-up), so it's empty-until-data on cold load.
//
// RULE 7 — tokenRef is an opaque REFERENCE the user NAMES (e.g. `keychain://my-drive-token`), NOT a
// secret: it is forwarded on register (the worker resolves it via SecretsPort) and then CLEARED
// from the form; it is never displayed/echoed back (the UI-safe instance summary carries no
// tokenRef). WS-8 — with no onboarded workspace selected (workspaceId null), the form is disabled.


export interface ConnectorsProps {
  /** The SELECTED onboarded workspace's real id, or null (global / non-onboarded → disabled). */
  readonly workspaceId: string | null;
  /** The selected workspace's connector instances (WS-8 filtered upstream). */
  readonly instances: readonly UiSafeConnectorInstanceView[];
  readonly onRegister: (input: RegisterConnectorInput) => Promise<ConnectorConfigResult>;
  readonly onSetState: (instanceId: string, state: "enabled" | "paused") => Promise<ConnectorConfigResult>;
  readonly onSetCadence: (instanceId: string, cadence: string) => Promise<ConnectorConfigResult>;
  /**
   * Store a pasted API key in the Keychain at `ref` (owner-authorized 2026-09-03). Injected so this
   * surface stays testable without a live preload bridge (desktop L3).
   *
   * ⛔ ONE-WAY. There is no counterpart that reads a key back, and none may be added: the entire
   * justification for letting a credential reach the renderer is that a compromised renderer can
   * overwrite one but never exfiltrate one.
   */
  readonly onProvisionCredential: (ref: string, value: string) => Promise<{ readonly ok: boolean }>;
}

export function Connectors(props: ConnectorsProps): ReactElement {
  const { workspaceId, instances, onRegister, onSetState, onSetCadence, onProvisionCredential } = props;
  const [connectorId, setConnectorId] = useState<string>(KNOWN_CONNECTORS[0]);
  const [tokenRef, setTokenRef] = useState("");
  // ⛔ RULE 7 — the pasted key lives ONLY in this state, for the seconds between paste and submit,
  // and is cleared unconditionally in `finally`. It is never placed in a ref, never logged, never
  // sent anywhere but `onProvisionCredential`, and never read back (nothing can read it back).
  const [apiKey, setApiKey] = useState("");
  const [cadence, setCadence] = useState("@daily");
  // Per-instance cadence edits (seeded from each instance's own cadence) — the "Set cadence" button
  // applies THIS row's value, never the register form's (which is for register only).
  const [rowCadence, setRowCadence] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scoped = workspaceId !== null;
  // Where a pasted key WILL be stored — shown to the user so the destination is never a mystery, and
  // so a key provisioned here is findable in Keychain Access afterwards.
  const derivedRef = workspaceId === null ? "" : connectorCredentialRef(workspaceId, connectorId);
  const hasKey = apiKey.trim().length > 0;
  // Either path identifies a credential: paste a key (we store it and use the derived ref), or name
  // a ref for an item already in the Keychain. Requiring both would make the common case harder.
  const canRegister =
    scoped && (hasKey || tokenRef.trim().length > 0) && cadence.trim().length > 0 && !busy;

  const submitRegister = (): void => {
    if (!canRegister || workspaceId === null) return;
    setBusy(true);
    setError(null);
    // A pasted key is stored FIRST and the connector is registered against the ref it was stored at.
    // ⛔ ORDER IS LOAD-BEARING: registering first would leave an instance pointing at a ref holding
    // nothing if the Keychain write then failed — a connector that looks configured and cannot
    // authenticate. Store, verify, then register; a failed store aborts without registering.
    const ref = hasKey ? derivedRef : tokenRef.trim();
    const store = hasKey
      ? onProvisionCredential(derivedRef, apiKey)
      : Promise.resolve({ ok: true as const });
    void store
      .then((stored) => {
        if (!stored.ok) {
          // Deliberately says nothing about WHY beyond the actionable part — the failure reasons are
          // a closed token set and none of them may carry the value or the Keychain's own output.
          setError("Couldn't save the key to your Keychain. The connector was not registered.");
          return null;
        }
        const input: RegisterConnectorInput = {
          // Deterministic, idempotent id: one instance per connector per workspace (re-register updates).
          instanceId: `${connectorId}@${workspaceId}`,
          connectorId,
          workspaceId,
          tokenRef: ref,
          cadence: cadence.trim(),
        };
        return onRegister(input);
      })
      .then((r) => {
        if (r !== null && !r.ok) {
          setError("Couldn't register the connector. Check the reference and try again.");
        }
      })
      .catch(() => setError("Couldn't register the connector. Check the reference and try again."))
      .finally(() => {
        setBusy(false);
        // Rule 7: clear BOTH the reference and the pasted key after submit, whatever the outcome —
        // neither is retained, and the key in particular must not survive a failed attempt on screen.
        setTokenRef("");
        setApiKey("");
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
    <main className="sow-content sow-connectors" aria-label="Connectors">
      <div className="sow-page-head">
        <h1>Connectors</h1>
      </div>

      {!scoped ? (
        <div className="sow-empty" role="status">
          Select an onboarded workspace to configure its connectors.
        </div>
      ) : (
        <>
          <section className="sow-form-section" aria-label="Register a connector">
            <div className="sow-field-row">
              <label className="sow-field">
                <span className="sow-field-label">Connector</span>
                <select className="sow-input" value={connectorId} onChange={(e) => setConnectorId(e.target.value)} aria-label="Connector">
                  {KNOWN_CONNECTORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sow-field">
                <span className="sow-field-label">API key</span>
                <input
                  // ⛔ `type="password"` so the value is not shoulder-readable and browsers do not
                  // offer to remember it. `autoComplete="off"` keeps it out of form autofill stores.
                  type="password"
                  className="sow-input"
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the key — stored in your Keychain, never shown again"
                  onChange={(e) => setApiKey(e.target.value)}
                  aria-label="API key"
                />
              </label>
              <label className="sow-field">
                <span className="sow-field-label">Token reference (optional)</span>
                <input
                  type="text"
                  className="sow-input"
                  value={tokenRef}
                  disabled={hasKey}
                  placeholder={hasKey ? derivedRef : "keychain://my-connector-token"}
                  onChange={(e) => setTokenRef(e.target.value)}
                  aria-label="Token reference"
                />
              </label>
              <label className="sow-field">
                <span className="sow-field-label">Cadence</span>
                <input
                  type="text"
                  className="sow-input"
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value)}
                  aria-label="Cadence"
                />
              </label>
            </div>
            <p className="sow-field-hint" role="note">
              {hasKey ? (
                <>
                  The key will be saved in your macOS Keychain as <code>{derivedRef}</code>. It is
                  write-only: nothing in this app can read it back, and it is never shown again.
                  {!isWriteTarget(connectorId) && (
                    <> This connector only reads, so the key is stored but not used for writing.</>
                  )}
                </>
              ) : (
                <>
                  Paste an API key to have it saved to your Keychain, or name a reference for an item
                  you have already stored there.
                </>
              )}
            </p>
            <div className="sow-form-actions">
              <button
                type="button"
                className="sow-btn sow-btn--primary"
                disabled={!canRegister}
                aria-busy={busy}
                onClick={submitRegister}
              >
                {busy && <span className="sow-spinner" aria-hidden="true" />}
                Register connector
              </button>
            </div>
          </section>

          {error !== null ? (
            <div role="alert" className="sow-inline-error sow-connectors-error">
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
                  <span className={`sow-pill sow-pill--state-${inst.state}`}>{inst.state}</span>
                  <span className="sow-connector-cadence">{inst.cadence}</span>
                  <div className="sow-row-actions">
                    <button
                      type="button"
                      className={`sow-btn sow-btn--${inst.state === "enabled" ? "warn" : "primary"}`}
                      onClick={() => toggle(inst)}
                      aria-label={`${inst.state === "enabled" ? "Pause" : "Enable"} ${inst.connectorId}`}
                    >
                      {inst.state === "enabled" ? "Pause" : "Enable"}
                    </button>
                    <input
                      type="text"
                      className="sow-input sow-input--inline"
                      value={rowCadence[inst.instanceId] ?? inst.cadence}
                      onChange={(e) => setRowCadence((m) => ({ ...m, [inst.instanceId]: e.target.value }))}
                      aria-label={`Cadence for ${inst.connectorId}`}
                    />
                    <button type="button" className="sow-btn" onClick={() => applyCadence(inst)} aria-label={`Set cadence for ${inst.connectorId}`}>
                      Set cadence
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
