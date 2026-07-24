// A tiny main-side holder for the configured vault roots (9.12), so the IPC handler (ipc.ts) reads them
// lazily at invoke-time while index.ts sets them once at boot (inside startWorker) — mirrors worker-holder.ts,
// dodging registration-order / import-cycle fragility.
//
// Main-only: NEVER exposed via preload. Set EXACTLY ONCE at boot — not a runtime re-config surface. The
// renderer requests open-BY-PATH only; it never learns or enumerates the roots (§5 / REQ-S-004).
let roots: readonly string[] = [];

export function setVaultRoots(next: readonly string[]): void {
  roots = next;
}

export function getVaultRoots(): readonly string[] {
  return roots;
}
