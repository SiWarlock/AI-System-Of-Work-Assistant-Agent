// 18.32 — Path-β desktop arming: the WORKER-HOST-side WorkerHostConfig → bootWorker forward mapping.
//
// Pure; type-only imports keep it side-effect-free (NO runtime import of the process.on-registering entry
// module — worker-host/index.ts). Default-OFF: an unset `subscriptionArm` yields `{}`, so the conditional
// spread into the bootWorker arg is byte-equivalent to today's construction. This makes the app CAPABLE of
// forwarding the plain-data arm; it flips nothing on (bootWorker's FAIL-CLOSED reachability default keeps an
// env-only arm HEALTH-denied — ARCHITECTURE §19.5).
//
// The egressAllowedProcessors → gateAutoIngest opts pass (`buildAutoIngestGateOpts`) integrates with 18.31,
// which adds `egressAllowedProcessors: readonly string[]` to the worker's `AutoIngestGateOpts` (branded to
// `ProcessorId` worker-side, so the desktop passes plain strings straight through — no cast).
import type { boot } from "@sow/worker";
import type { WorkerHostConfig } from "./index";

/**
 * The conditional-spread slice forwarding the plain-data subscription arm into the bootWorker arg.
 * Unset ⇒ `{}` (the `subscriptionArm` key is OMITTED, never `subscriptionArm: undefined`) ⇒ byte-equivalent
 * shipped default. bootWorker supplies the real `makeCompletion`; the IPC channel carries no thunks.
 */
export function subscriptionArmForward(
  config: WorkerHostConfig,
): { readonly subscriptionArm?: WorkerHostConfig["subscriptionArm"] } {
  return config.subscriptionArm !== undefined ? { subscriptionArm: config.subscriptionArm } : {};
}

/**
 * Build the `gateAutoIngest` opts from the received config — forwarding the existing auto-ingest knobs plus the
 * §5 egress allowlist (18.31). `egressAllowedProcessors` is passed as PLAIN strings (branded to `ProcessorId`
 * worker-side in `buildAutoIngestProofSpineParams`) and OMITTED when unset (never `: undefined`), so the opts —
 * and the resulting proof-spine EgressPolicy — stay fail-closed-empty/byte-equivalent to today's default.
 * Supplying the allowlist arms nothing on its own: it is an independent OFF-lock from the auto-ingest opt-in
 * (`gateAutoIngest` still returns `undefined` unless `autoIngest === true` AND a vaultRoot is present).
 */
export function buildAutoIngestGateOpts(config: WorkerHostConfig): boot.AutoIngestGateOpts {
  return {
    autoIngest: config.autoIngest,
    ingestWorkspaceId: config.ingestWorkspaceId,
    // sensitivity is not an owner env knob this slice — the gate defaults it to "normal".
    temporalAddress: config.temporalAddress,
    ...(config.egressAllowedProcessors !== undefined
      ? { egressAllowedProcessors: config.egressAllowedProcessors }
      : {}),
  };
}
