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

/**
 * 11.3a — the conditional-spread slice forwarding the resolved gbrain.pin path into the bootWorker arg.
 * Unset `gbrainPinPath` ⇒ `{}` (the `gbrainStartupVerify` key is OMITTED, never `gbrainStartupVerify:
 * undefined`) ⇒ byte-equivalent shipped default (the startup verify never runs — today's degraded boot).
 * Mirrors `subscriptionArmForward`'s conditional-spread shape exactly. `bootWorker` supplies the real
 * `probe` default (`createGbrainVersionProbe()`) — this forwards only the plain-data `pinPath`.
 */
export function gbrainStartupVerifyForward(
  config: WorkerHostConfig,
): { readonly gbrainStartupVerify?: { readonly pinPath: string } } {
  return config.gbrainPinPath !== undefined
    ? { gbrainStartupVerify: { pinPath: config.gbrainPinPath } }
    : {};
}

// ── task 20.1 — the provenance-bundle forward: PROVISIONING IS THE ARMING ACT ─────────────────────
//
// ⭐ Owner directive (2026-08-29): the CODE must not be the bottleneck. The owner provisions the
// Keychain item and drops `config/gbrain.pin`; nothing else arms this — no flag, no rebuild.
//
// ⛔ PURE, and it takes the ALREADY-DECIDED outcome rather than deciding anything itself. The
// decision — which requires actually RESOLVING the signing key, not merely constructing a port —
// lives in `@sow/worker`'s `resolveProvenanceArming`, with its own tests and its own mutation proof.
// This function only shapes the `BootConfig` fragment, so it stays testable without a Keychain.
//
// ⛔⛔ ALL THREE FIELDS MOVE TOGETHER OR NONE DO, and that is load-bearing rather than tidy.
// `copilotProvenanceStamping` + `provenanceServingOracle` are what CONSTRUCT the loader-backed
// oracle; `copilotServingOracleGoLive` is what SELECTS it. Forwarding a subset would produce a
// half-armed state that `bootWorker`'s own OFF-locks are written to treat as OFF — inert, but it
// would report a DIFFERENT `gateProposeArming` precondition set than the operator expects, which is
// the split-brain shape `worker L52` names.
//
// ⚠ NOT ARMED ⇒ `{}` — byte-equivalent to today's shipped boot. The unarmed path forwards nothing,
// constructs nothing, and is indistinguishable from this code not existing.
export function provenanceArmForward(outcome: {
  readonly armed: boolean;
  readonly bundle?: unknown;
}): Record<string, unknown> {
  if (!outcome.armed || outcome.bundle === undefined) return {};
  return {
    // OFF-lock 2's supplier — the REAL Keychain adapter, built inside bootWorker.
    keychainSecrets: {},
    provenanceServingOracle: outcome.bundle,
    // OFF-lock 3 (construction) and OFF-lock 1 (selection). See the block comment above for why
    // these cannot be forwarded independently.
    copilotProvenanceStamping: true,
    copilotServingOracleGoLive: true,
  };
}
