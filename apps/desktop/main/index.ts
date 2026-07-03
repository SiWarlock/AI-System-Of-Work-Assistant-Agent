import { app, BrowserWindow, session } from "electron";
import { createMainWindow } from "./window";
import { installCsp } from "./security";
import { registerIpcHandlers } from "./ipc";
import { sessionToken } from "./session-token";

const isDev = typeof process.env["ELECTRON_RENDERER_URL"] === "string";

// Single-instance lock: a second launch focuses the existing window rather than
// spawning a rival process (each launch would otherwise mint its own token).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Mint the per-launch session token BEFORE the window loads, so the renderer's
  // very first bridge call already has a token to authenticate the worker with.
  sessionToken.mint();

  void app.whenReady().then(() => {
    installCsp(session.defaultSession, isDev);
    registerIpcHandlers();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
