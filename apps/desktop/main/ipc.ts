import { app, ipcMain } from "electron";
import { sessionToken } from "./session-token";
import { getWorkerEndpoint } from "./worker-holder";

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
}
