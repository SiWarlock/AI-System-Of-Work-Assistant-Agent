import { app, BrowserWindow, session, protocol, net } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createMainWindow } from "./window";
import { installCsp } from "./security";
import { registerIpcHandlers } from "./ipc";
import { sessionToken } from "./session-token";
import { resolveAppRequest } from "./app-protocol";
import {
  WORKER_LOOPBACK_HOST,
  WORKER_LOOPBACK_PORT,
  buildWorkerAllowlist,
  workerConnection,
} from "./worker-launch";
import {
  createWorkerSupervisor,
  type WorkerSupervisor,
  type WorkerHostConfig,
  type WorkerChild,
} from "./worker-supervisor";
import { setWorkerEndpoint } from "./worker-holder";
import { readWorkerArmingEnv } from "./worker-arming-env";

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

// ── worker child supervision (9.4b D4) ───────────────────────────────────────
// Main spawns the built worker-host as a supervised background child. It runs under
// SYSTEM node (not the Electron binary) so the worker's native deps (better-sqlite3)
// keep their system-node ABI in dev — packaging moves this to Electron utilityProcess
// + @electron/rebuild. The child resolves the built @sow/* dist via --conditions and
// the resolve-loader; the launch config (token / allowlist / pinned port) is injected
// over the child IPC channel (never env/argv — the token is a secret).
let supervisor: WorkerSupervisor | null = null;

function startWorker(): void {
  const mode = isDev ? "dev" : "prod";
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  const allowlist = buildWorkerAllowlist(mode, WORKER_LOOPBACK_PORT, devUrl);
  const userData = app.getPath("userData");
  // The vault the app watches: the owner's real Obsidian vault via SOW_VAULT_ROOT, else the userData default.
  const vaultRoot = process.env["SOW_VAULT_ROOT"] ?? join(userData, "vault");
  mkdirSync(vaultRoot, { recursive: true });
  // OPEN-THE-GATES auto-ingest opt-in (owner env; default OFF). Read HERE in Electron main (env lives here, not
  // in the worker-host) and threaded to the worker-host over IPC via WorkerHostConfig — the same path vaultRoot
  // takes. Unset ⇒ today's degraded boot. `boot.gateAutoIngest` requires BOTH this flag AND vaultRoot to wire.
  const autoIngest = process.env["SOW_INGEST_WATCH"] === "1" || process.env["SOW_INGEST_WATCH"] === "true";
  const config: WorkerHostConfig = {
    token: sessionToken.get(),
    launchId: randomUUID(),
    origins: allowlist.origins,
    hosts: allowlist.hosts,
    apiHost: WORKER_LOOPBACK_HOST,
    apiPort: WORKER_LOOPBACK_PORT,
    // Persist the operational store + vault under the app's userData (survives launches).
    dbPath: join(userData, "sow.db"),
    vaultRoot,
    autoIngest,
    ...(process.env["SOW_INGEST_WORKSPACE"] !== undefined
      ? { ingestWorkspaceId: process.env["SOW_INGEST_WORKSPACE"] }
      : {}),
    ...(process.env["SOW_TEMPORAL_ADDRESS"] !== undefined
      ? { temporalAddress: process.env["SOW_TEMPORAL_ADDRESS"] }
      : {}),
    // Path-β subscription-extraction arming + §5 egress allowlist (18.32), read HERE in Electron main and
    // threaded to the worker-host over IPC (plain data only). Unset ⇒ `{}` ⇒ byte-equivalent to today's config.
    ...readWorkerArmingEnv(process.env),
  };
  const entryPath = join(__dirname, "../worker/desktop-host.mjs");
  const loaderPath = join(__dirname, "../../worker-host/register-loader.mjs");
  const nodeBin = process.env["SOW_WORKER_NODE"] ?? "node";

  supervisor = createWorkerSupervisor({
    fork: (): WorkerChild =>
      fork(entryPath, [], {
        execPath: nodeBin,
        execArgv: ["--conditions=sow-built", "--import", loaderPath],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      }) as unknown as WorkerChild,
    config,
    connection: workerConnection(WORKER_LOOPBACK_PORT),
    scheduleRestart: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    log: (event, fields) => console.log(`[worker] ${event}`, fields ?? ""),
  });
  supervisor.start();
  // Publish the non-secret loopback endpoint for the preload bridge (D5). The token
  // stays on the separate audited session:getToken channel (one token-bearing channel).
  setWorkerEndpoint(workerConnection(WORKER_LOOPBACK_PORT));
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
    startWorker();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  // Tear the worker child down cleanly on quit so no orphan process leaks.
  app.on("before-quit", () => {
    supervisor?.stop();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
