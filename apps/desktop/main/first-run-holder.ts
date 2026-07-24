// A tiny main-side holder for the durable first-run marker PATH (9.17), so the IPC handler (ipc.ts) reads it
// lazily at invoke-time while index.ts sets it once at boot (inside startWorker) — mirrors vault-roots.ts,
// dodging registration-order / import-cycle fragility (registerIpcHandlers runs BEFORE startWorker resolves
// `userData`, so the path isn't known at registration time).
//
// Main-only: NEVER exposed via preload. Set EXACTLY ONCE at boot — not a runtime re-config surface. `null`
// until set ⇒ the handler treats a request as inconclusive (typed err → the renderer gate falls back).
let markerPath: string | null = null;

export function setFirstRunMarkerPath(path: string): void {
  markerPath = path;
}

export function getFirstRunMarkerPath(): string | null {
  return markerPath;
}
