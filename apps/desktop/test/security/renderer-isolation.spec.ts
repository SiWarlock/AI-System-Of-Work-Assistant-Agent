import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 9.14 renderer-ISOLATION adversarial verify spec (§5 Electron security / §12) ──
//
// A simulated renderer-side XSS must not be able to (a) reach Node/Electron
// internals, (b) invoke any privileged op beyond the enumerated preload bridge,
// or (c) execute injected inline script. This spec asserts the PRODUCTION config
// that guarantees those properties — the REAL `createMainWindow` webPreferences,
// the REAL `registerIpcHandlers` channel set, the exposed bridge surface, and the
// production CSP — at a deterministic altitude (no real BrowserWindow / Electron
// runtime — that belongs to e2e). TEST-ONLY: a failure here is a real isolation
// gap (a Step-9 Finding), never a reason to touch production.

// vi.mock is hoisted; capture the REAL production config the mock records.
const captured = vi.hoisted(() => ({
  browserWindowOptions: [] as Array<{ webPreferences?: Record<string, unknown> }>,
  windowOpenHandler: null as null | (() => unknown),
  willNavigateHandler: null as null | ((event: { preventDefault: () => void }, url: string) => void),
  ipcChannels: [] as string[],
}));

vi.mock("electron", () => {
  class BrowserWindow {
    webContents = {
      on: (event: string, handler: (e: { preventDefault: () => void }, url: string) => void): void => {
        if (event === "will-navigate") captured.willNavigateHandler = handler;
      },
      setWindowOpenHandler: (handler: () => unknown): void => {
        captured.windowOpenHandler = handler;
      },
    };
    constructor(options: { webPreferences?: Record<string, unknown> }) {
      captured.browserWindowOptions.push(options);
    }
    once(): this {
      return this;
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    show(): void {}
  }
  return {
    BrowserWindow,
    app: { getVersion: (): string => "0.0.0-test" },
    ipcMain: {
      handle: (channel: string): void => {
        captured.ipcChannels.push(channel);
      },
    },
    shell: {
      openPath: (): Promise<string> => Promise.resolve(""),
      showItemInFolder: (): void => {},
    },
  };
});

import { createMainWindow } from "../../main/window";
import { registerIpcHandlers } from "../../main/ipc";
import { buildSowBridge } from "../../preload/bridge";
import { cspHeader } from "../../main/security";
import inventory from "../../preload/inventory.json";

beforeEach(() => {
  captured.browserWindowOptions.length = 0;
  captured.windowOpenHandler = null;
  captured.willNavigateHandler = null;
  captured.ipcChannels.length = 0;
});

// Recursively collect every own-enumerable key of the exposed bridge object tree
// (namespaces + method names). Functions are leaves (not recursed into), so this
// surfaces exactly what a renderer walking `window.sow` could enumerate.
function deepKeys(obj: unknown, acc: string[] = []): string[] {
  if (obj === null || typeof obj !== "object") return acc;
  for (const [k, v] of Object.entries(obj)) {
    acc.push(k);
    if (v !== null && typeof v === "object") deepKeys(v, acc);
  }
  return acc;
}

describe("renderer isolation (§5 — a renderer XSS cannot reach Node or escape the bridge)", () => {
  it("createMainWindow enforces the isolation baseline (nodeIntegration off, contextIsolation+sandbox on, nav locked)", () => {
    createMainWindow();

    expect(captured.browserWindowOptions).toHaveLength(1);
    const wp = captured.browserWindowOptions[0]?.webPreferences ?? {};
    // The isolation baseline (§5 / REQ-S-004): with node integration off + context
    // isolation + sandbox on, the renderer's realm has no `require`/`process`/module.
    expect(wp["contextIsolation"]).toBe(true);
    expect(wp["nodeIntegration"]).toBe(false);
    expect(wp["sandbox"]).toBe(true);
    expect(wp["webSecurity"]).toBe(true);
    expect(wp["allowRunningInsecureContent"]).toBe(false);
    expect(wp["nodeIntegrationInWorker"]).toBe(false);
    expect(wp["nodeIntegrationInSubFrames"]).toBe(false);
    expect(wp["experimentalFeatures"]).toBe(false);

    // XSS cannot pop a new window / navigate the app to a foreign origin.
    expect(typeof captured.windowOpenHandler).toBe("function");
    expect(captured.windowOpenHandler?.()).toEqual({ action: "deny" });

    expect(typeof captured.willNavigateHandler).toBe("function");
    let blocked = false;
    captured.willNavigateHandler?.({ preventDefault: () => { blocked = true; } }, "https://evil.example.com/steal");
    expect(blocked).toBe(true);
    // …but the app's own origin is NOT blocked (non-vacuous — the guard isn't a blanket deny).
    let appNavBlocked = false;
    captured.willNavigateHandler?.({ preventDefault: () => { appNavBlocked = true; } }, "app://sow/anything");
    expect(appNavBlocked).toBe(false);
  });

  it("the exposed bridge invokes EXACTLY the inventory channels and exposes no Node escape hatch", () => {
    const seen: string[] = [];
    const bridge = buildSowBridge((channel) => {
      seen.push(channel);
      return Promise.resolve(undefined);
    }) as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>;
    for (const namespace of Object.values(bridge)) {
      for (const fn of Object.values(namespace)) {
        if (typeof fn === "function") fn();
      }
    }
    // Least-privilege: the only privileged ops the renderer can reach == the checked-in inventory.
    expect(seen.sort()).toEqual([...inventory.channels].sort());

    // Nothing on the exposed surface re-introduces a Node/Electron primitive an XSS could pivot through.
    const FORBIDDEN = new Set([
      "require", "process", "module", "exports", "global", "globalThis", "Buffer",
      "eval", "Function", "ipcRenderer", "ipcMain", "contextBridge", "webFrame",
      "child_process", "fs", "exec", "spawn", "shell", "__dirname", "__filename",
    ]);
    const offenders = deepKeys(bridge).filter((k) => FORBIDDEN.has(k));
    expect(offenders).toEqual([]);
  });

  it("main registers a handler for EXACTLY the enumerated inventory channels (closed bridge — a non-enumerated channel has no handler)", () => {
    registerIpcHandlers();
    // Both ends match: an `ipcRenderer.invoke("evil:channel")` from a compromised renderer
    // reaches no handler and rejects. (The renderer-side PRELOAD_CHANNELS == inventory is
    // pinned by preload-inventory.snapshot.test.ts; this pins the MAIN handler set.)
    expect([...captured.ipcChannels].sort()).toEqual([...inventory.channels].sort());
  });

  it("the production CSP blocks inline + eval script (an injected inline <script> cannot execute)", () => {
    const csp = cspHeader(false);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(csp).toContain("object-src 'none'");
  });
});
