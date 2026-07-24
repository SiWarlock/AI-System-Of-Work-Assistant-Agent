// 9.17 (renderer leg) — the window-free, DI'd first-run gate decisions (LESSON 3). Pure over the durable
// marker signal (the `lifecycle:firstRunStatus` preload channel's Result, or `undefined` while the async
// read is pending) + the registry-derived `hasAnyOnboardedWorkspace` boolean the caller passes in. NO
// window/DOM coupling (mirrors reroute-picker.ts — the caller passes the slice), so it compiles + unit-tests
// under the DOM-less node tsconfig. Gates ONLY the onboarding MOUNT — never the WS-8 isolation predicate
// (`isWorkspaceScope`/`isGlobal` stays registry-derived; safety rule 4 / LESSON 9).
import type { FirstRunStatus } from "../../preload/bridge";

/** What the renderer holds: the marker Result once read, or `undefined` while the async read is pending. */
export type FirstRunSignal = FirstRunStatus | undefined;

/** True ONLY when the marker CONCLUSIVELY says onboarding is complete (`ok(true)`). */
function markerComplete(signal: FirstRunSignal): boolean {
  return signal?.ok === true && signal.value === true;
}

/**
 * Show onboarding? The durable marker is ADDITIVE authority, never a hard lock (brief Q2): a complete marker
 * suppresses onboarding even under a transiently-empty registry (the worker-down-at-boot bug this fixes);
 * absent / faulted / pending ⇒ defer to the registry-derived gate (`!registryHasOnboardedWorkspace`), so a
 * real install is never dropped into re-onboarding.
 */
export function shouldShowOnboarding(signal: FirstRunSignal, registryHasOnboardedWorkspace: boolean): boolean {
  return markerComplete(signal) ? false : !registryHasOnboardedWorkspace;
}

/**
 * Backfill the durable marker? An existing / pre-feature install has a populated registry but NO marker, so
 * the durable authority never engages until the marker is written once. Backfill IFF the registry shows
 * onboarded AND the marker read RESOLVED to not-complete (absent OR fault — the WS-8 registry is fail-closed
 * authoritative evidence that onboarding happened, so writing the marker is the correct state, and it is
 * idempotent). NEVER while PENDING (`undefined` — don't write before the read resolves) and NEVER when the
 * marker is already complete (no-op). The caller fires the write once (a fire-once guard) so a persistent
 * read fault can't loop writes.
 */
export function shouldBackfillMarker(signal: FirstRunSignal, registryHasOnboardedWorkspace: boolean): boolean {
  return registryHasOnboardedWorkspace && signal !== undefined && !markerComplete(signal);
}
