import { BrowserWindow } from "electron";
import { join } from "node:path";

// electron-vite sets ELECTRON_RENDERER_URL in dev (the Vite dev server); in a
// packaged build it is undefined and the renderer loads from disk.
const RENDERER_URL = process.env["ELECTRON_RENDERER_URL"];
const isDev = typeof RENDERER_URL === "string" && RENDERER_URL.length > 0;

// The single origin the renderer is ever permitted to sit at.
function isAllowedNavigation(url: string): boolean {
  if (isDev) return url.startsWith(RENDERER_URL as string);
  return url.startsWith("file://");
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1220,
    height: 842,
    minWidth: 980,
    minHeight: 640,
    show: false,
    // macOS-native Liquid Glass shell (per the locked design): real inset
    // traffic lights + unified toolbar, real system vibrancy behind the panes.
    titleBarStyle: "hiddenInset",
    vibrancy: "sidebar",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      // ── Security baseline (§5 / REQ-S-004) ──────────────────────────────
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // Node integration in workers/subframes is off by default; pinned here.
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
    },
  });

  // Deny navigation to any non-app origin and deny all new-window creation.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.once("ready-to-show", () => win.show());

  if (isDev) {
    void win.loadURL(RENDERER_URL as string);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}
