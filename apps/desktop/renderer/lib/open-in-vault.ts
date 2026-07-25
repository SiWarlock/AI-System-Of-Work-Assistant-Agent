// 9.12r — the renderer glue that invokes the typed preload vault bridge (`window.sow.vault.open/reveal`) with a
// CLOSED target (Option A). The renderer is PATH-BLIND — it names WHICH repo ("workspace" | "global"); main
// resolves the configured root and opens/reveals it (§5 / REQ-UX-003). window-coupled, so it lives here (not a
// node-testable module, desktop L3) and a jsdom test drives it. Fail-closed like every renderer command-caller
// (desktop L6): fold any typed-err / transport-throw / absent-bridge to a SILENT no-op — surface nothing.
import type { SowBridge, VaultRepoTarget } from "../../preload/bridge";
export type { VaultRepoTarget } from "../../preload/bridge";

async function callVault(op: "open" | "reveal", target: VaultRepoTarget): Promise<void> {
  const bridge = (window as unknown as { sow?: SowBridge }).sow;
  try {
    await bridge?.vault?.[op]?.(target);
  } catch {
    // fail-closed: open nothing, surface nothing (main is the authority; the renderer only requests)
  }
}

/** Ask main to OPEN the named repo in the OS file manager (folder-open — A2). Never passes a path. */
export async function requestVaultOpen(target: VaultRepoTarget): Promise<void> {
  await callVault("open", target);
}

/** Ask main to REVEAL the named repo in the OS file manager (Finder). Never passes a path. */
export async function requestVaultReveal(target: VaultRepoTarget): Promise<void> {
  await callVault("reveal", target);
}
