// 18.32 — Path-β desktop arming: the MAIN-side env → the plain-data WorkerHostConfig arming slice.
//
// Pure + electron-free so it compiles under tsconfig.node.json and no window/electron import reaches a
// test (apps/desktop LESSONS §3). Default-OFF/dormant: with no arming env set the result is `{}`, so the
// conditional-spread into the WorkerHostConfig build in main/index.ts stays byte-equivalent to today's boot.
//
// IPC constraint (ARCHITECTURE §19.5): WorkerHostConfig crosses a child_process.fork structured-clone
// channel, so only PLAIN DATA crosses — never the makeCompletion/checkReachable thunks. bootWorker supplies
// the real makeCompletion default + a FAIL-CLOSED reachability probe, so arming via env ALONE stays
// HEALTH-denied (dormant) until a worker-host-side real checkReachable is injected — the owner ENABLE step,
// NOT this slice. This makes the app CAPABLE of subscription-armed auto-ingest; it flips nothing on.

/** The plain-data arming slice spread into the WorkerHostConfig build. Absent keys ⇒ dormant/byte-equivalent. */
export interface WorkerArmingConfig {
  /** Subscription-extraction arming opt-in (Option B). enabled=false / absent ⇒ dormant (worker gates on `=== true`). */
  readonly subscriptionArm?: { readonly enabled: boolean; readonly model?: string };
  /** §5 egress-processor allowlist forwarded into the auto-ingest proof-spine EgressPolicy (18.31). */
  readonly egressAllowedProcessors?: readonly string[];
}

/** Strict opt-in: only the exact tokens arm — never a truthy-coerce (mirrors SOW_INGEST_WATCH; worker Lesson 28). */
function isArmed(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

/**
 * Map the Electron-main environment to the plain-data arming slice. Reads three owner env knobs, all
 * default-absent:
 *   - `SOW_SUBSCRIPTION_ARM`  (strict "1"|"true") → `subscriptionArm.enabled`
 *   - `SOW_SUBSCRIPTION_MODEL`                    → `subscriptionArm.model`
 *   - `SOW_EGRESS_ALLOWED_PROCESSORS` (comma-list) → `egressAllowedProcessors`
 * Each new key is OMITTED (never `: undefined`) when its inputs are absent, so an unset environment yields
 * `{}` and the spread is byte-identical to today's WorkerHostConfig.
 */
export function readWorkerArmingEnv(env: NodeJS.ProcessEnv): WorkerArmingConfig {
  const armRaw = env["SOW_SUBSCRIPTION_ARM"];
  const egressRaw = env["SOW_EGRESS_ALLOWED_PROCESSORS"];

  // model: trimmed + empty-guarded (mirrors the egress cleanup), so a whitespace/empty SOW_SUBSCRIPTION_MODEL
  // is treated as absent — never forwarded as a blank model that would trap the owner at the ENABLE step.
  const modelTrimmed = env["SOW_SUBSCRIPTION_MODEL"]?.trim();
  const model = modelTrimmed !== undefined && modelTrimmed.length > 0 ? modelTrimmed : undefined;

  // subscriptionArm: emitted iff the arming flag OR a (non-empty) model is provided; plain data only (no thunks).
  // A model set without the arm flag is preserved but dormant (`enabled:false`; worker gates on `=== true`).
  const subscriptionArm =
    armRaw !== undefined || model !== undefined
      ? {
          enabled: isArmed(armRaw),
          ...(model !== undefined ? { model } : {}),
        }
      : undefined;

  // egressAllowedProcessors: comma-split, trimmed, empties dropped; emitted only when a non-empty list remains.
  const egressAllowedProcessors =
    egressRaw !== undefined
      ? egressRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  return {
    ...(subscriptionArm !== undefined ? { subscriptionArm } : {}),
    ...(egressAllowedProcessors.length > 0 ? { egressAllowedProcessors } : {}),
  };
}
