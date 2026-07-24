import { app, ipcMain, shell } from "electron";
import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { sessionToken } from "./session-token";
import { getWorkerEndpoint } from "./worker-holder";
import { getVaultRoots } from "./vault-roots";
import { performVaultAction, type VaultActionDeps } from "./open-in-vault";

// The real fs + shell seams for the path-scoped vault handlers (9.12). Kept OUT of open-in-vault.ts so that
// module stays electron-free + unit-testable under the DOM-less node tsconfig (desktop LESSONS §2/§3); the
// real `shell` + `node:fs` are bound HERE, where electron already lives.
const vaultSeams: VaultActionDeps = {
  realpath: (p) => fsRealpath(p),
  stat: (p) => fsStat(p),
  openPath: (p) => shell.openPath(p),
  showInFolder: (p) => shell.showItemInFolder(p),
};

// Main-side handlers for the enumerated preload channels. Every channel exposed
// by preload/bridge.ts must have exactly one handler here.
export function registerIpcHandlers(): void {
  ipcMain.handle("app:getVersion", () => app.getVersion());

  // The per-launch session token (§5, task 9.2). Delivered to the renderer ONLY
  // over this audited bridge channel — never on a global, in the HTML, or a log.
  ipcMain.handle("session:getToken", () => sessionToken.get());

  // The non-secret loopback worker endpoint { httpUrl, wsUrl } for the renderer's
  // tRPC client (9.4b D5). Null until main has spawned the worker. Carries NO token
  // — the renderer pairs it with session:getToken.
  ipcMain.handle("worker:getConnection", () => getWorkerEndpoint());

  // Open-in-Obsidian / reveal-in-vault (9.12, REQ-UX-003 / §11). The renderer requests open-BY-PATH only;
  // main path-scopes the untrusted path (realpath containment under the configured vault roots) BEFORE any
  // shell call — no arbitrary path open (§5). Roots are read lazily (set once at boot in startWorker).
  ipcMain.handle("vault:open", (_event, path: unknown) =>
    performVaultAction("open", path, getVaultRoots(), vaultSeams),
  );
  ipcMain.handle("vault:reveal", (_event, path: unknown) =>
    performVaultAction("reveal", path, getVaultRoots(), vaultSeams),
  );
}
