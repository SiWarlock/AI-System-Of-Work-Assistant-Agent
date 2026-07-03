import { app, BrowserWindow, session, protocol, net } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMainWindow } from "./window";
import { installCsp } from "./security";
import { registerIpcHandlers } from "./ipc";
import { sessionToken } from "./session-token";
import { resolveAppRequest } from "./app-protocol";

const isDev = typeof process.env["ELECTRON_RENDERER_URL"] === "string";

// The packaged renderer is served from a custom privileged scheme (app://sow), NOT
// file:// — file:// has an opaque `null` Origin (unusable with the worker's Origin
// allowlist) and broad filesystem semantics. Registered as a STANDARD, SECURE,
// fetch+CORS-enabled scheme so the renderer has a real tuple origin (app://sow) the
// browser sends as the Origin header on its cross-origin calls to the loopback
// worker (which reflects it via CORS). Must run before app 'ready'. Dev serves the
// renderer from Vite instead, so the handler below is prod-only.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

/** Serve the packaged renderer bundle over app://sow/<path> (prod only), traversal-safe. */
function registerAppProtocol(): void {
  const rendererRoot = join(__dirname, "../renderer");
  protocol.handle("app", (request) => {
    const filePath = resolveAppRequest(request.url, rendererRoot);
    if (filePath === null) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

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
    if (!isDev) registerAppProtocol();
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
