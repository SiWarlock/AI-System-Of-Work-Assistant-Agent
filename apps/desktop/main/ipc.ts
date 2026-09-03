import { app, ipcMain, shell } from "electron";
import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { sessionToken } from "./session-token";
import { getWorkerEndpoint } from "./worker-holder";
import { getVaultRoots } from "./vault-roots";
import { performVaultAction, type VaultActionDeps } from "./open-in-vault";
import {
  readOnboardingComplete,
  markOnboardingComplete,
  type FirstRunDeps,
  type FirstRunStatus,
} from "./first-run";
import { getFirstRunMarkerPath } from "./first-run-holder";
import {
  provisionCredential,
  type CredentialExec,
  type CredentialProvisionResult,
} from "./credential-provision";

// The real fs + shell seams for the path-scoped vault handlers (9.12). Kept OUT of open-in-vault.ts so that
// module stays electron-free + unit-testable under the DOM-less node tsconfig (desktop LESSONS §2/§3); the
// real `shell` + `node:fs` are bound HERE, where electron already lives.
const vaultSeams: VaultActionDeps = {
  realpath: (p) => fsRealpath(p),
  stat: (p) => fsStat(p),
  openPath: (p) => shell.openPath(p),
  showInFolder: (p) => shell.showItemInFolder(p),
  // A1 (9.12-A1): the `obsidian://` deep-link opener for the true Open-in-Obsidian.
  openExternal: (uri) => shell.openExternal(uri),
};

// The real node:fs seams for the durable first-run marker (9.17). Kept OUT of first-run.ts so that module
// stays electron-free + node-testable under the DOM-less node tsconfig (LESSON 13/16); bound HERE, where
// node/electron already live.
const firstRunSeams: FirstRunDeps = {
  fileExists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, d) => writeFileSync(p, d),
};

/**
 * The real `security(1)` seam for one-way credential provisioning (§14.2, owner-authorized
 * 2026-09-03). Kept OUT of credential-provision.ts so that module stays electron-free + node-testable
 * under the DOM-less node tsconfig (desktop LESSONS §3); bound HERE, where node already lives.
 *
 * ⛔ `execFile` with a DISCRETE ARGS ARRAY and NO `shell` option — a shell is structurally impossible,
 * so a service/account/value can never be re-read as a command (mirrors the worker's Keychain
 * backend). Absolute path so a PATH-shadowed `security` cannot be substituted.
 * ⚠ BOUNDED: a locked Keychain makes `security` block on a modal dialog rather than erroring, so an
 * unbounded call would hang the handler — and with it the user's click — indefinitely.
 * ⛔ RULE 7: stdout/stderr are DISCARDED. Only the exit code is read. `security` can echo item
 * attributes on failure, and nothing here may carry that back toward the renderer.
 */
const SECURITY_BIN = "/usr/bin/security";
const CREDENTIAL_EXEC_TIMEOUT_MS = 10_000;
const credentialExec: CredentialExec = (args) =>
  new Promise((resolve) => {
    execFile(
      SECURITY_BIN,
      [...args],
      { timeout: CREDENTIAL_EXEC_TIMEOUT_MS, maxBuffer: 1024 * 64 },
      (error) => {
        // A non-zero exit, a timeout, and a spawn fault all mean "not stored". The code is the ONLY
        // thing read; `error.message` can quote argv and must never travel (rule 7).
        if (error === null) return resolve({ code: 0 });
        const code = typeof error.code === "number" ? error.code : 1;
        resolve({ code: code === 0 ? 1 : code });
      },
    );
  });

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

  // Open / reveal a repo in the OS file manager (9.12r Option A, REQ-UX-003 / §11). The renderer names a CLOSED
  // TARGET ("workspace" | "global") — NEVER a path; main resolves it to a configured root + scope-opens it, so an
  // out-of-root path is unrepresentable by construction (§5). Roots are read lazily (set once at boot).
  ipcMain.handle("vault:open", (_event, target: unknown) =>
    performVaultAction("open", target, getVaultRoots(), vaultSeams),
  );
  ipcMain.handle("vault:reveal", (_event, target: unknown) =>
    performVaultAction("reveal", target, getVaultRoots(), vaultSeams),
  );

  // Durable first-run marker (9.17, §11). Main owns the marker under app-data (the path is set once at boot
  // in startWorker); the handlers read it lazily. A path still unset (pre-boot) or an fs fault is treated as
  // INCONCLUSIVE — a typed err the renderer gate maps to the registry-derived fallback (never a lock-out).
  // Gates ONLY the onboarding mount, never the WS-8 predicate.
  // ⛔⛔ THE ONE CHANNEL THAT CARRIES A SECRET, owner-authorized 2026-09-03 with the cost stated.
  // WRITE-ONLY BY CONSTRUCTION: there is no read counterpart and none may be added — a compromised
  // renderer can overwrite a credential, never exfiltrate one. That asymmetry is the entire
  // mitigation for letting a vendor key transit the renderer at all, and it is pinned by
  // `test/security/preload-inventory.snapshot.test.ts`.
  // ⚠ Both args arrive as `unknown` from an UNTRUSTED renderer: the bridge authenticates the CHANNEL,
  // never the VALUES (desktop L16). Non-string input is refused here, before `provisionCredential`
  // does its own ref-charset validation in front of the exec.
  ipcMain.handle(
    "secret:provision",
    async (_event, ref: unknown, value: unknown): Promise<CredentialProvisionResult> => {
      if (typeof ref !== "string" || typeof value !== "string") {
        return { ok: false, reason: "invalid_ref" };
      }
      return provisionCredential(ref, value, credentialExec);
    },
  );

  ipcMain.handle("lifecycle:firstRunStatus", (): FirstRunStatus => {
    const path = getFirstRunMarkerPath();
    if (path === null) return { ok: false, error: "read_fault" };
    return readOnboardingComplete(path, firstRunSeams);
  });
  ipcMain.handle("lifecycle:markOnboarded", (): FirstRunStatus => {
    const path = getFirstRunMarkerPath();
    if (path === null) return { ok: false, error: "write_fault" };
    return markOnboardingComplete(path, firstRunSeams);
  });
}
