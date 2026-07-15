// Task 14.2 (desktop leg) — the connector-instance UI-safe view type.
//
// The renderer mirror of the worker's `UiSafeConnectorInstance` (connectorConfig procedure). It
// carries ONLY the config-visible scalars the worker projects — crucially NO `tokenRef` (rule 7:
// the tokenRef is an opaque reference the user names; it is forwarded to the worker on register
// and never round-tripped back to the renderer). Defined store-side (not in lib/) so the store
// slice + reducers depend on it without a lib→store→lib cycle; the command-caller re-exports it.
export interface UiSafeConnectorInstanceView {
  readonly instanceId: string;
  readonly connectorId: string;
  readonly workspaceId: string;
  /** "enabled" | "paused" (the worker's frozen state set; a plain string at the UI boundary). */
  readonly state: string;
  /** The sync cadence (opaque cron/interval string). */
  readonly cadence: string;
}
