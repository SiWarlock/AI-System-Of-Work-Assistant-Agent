#!/usr/bin/env node
// Install-doctor process entry (task 11.5-d, §13) — the reachability holder. THIN: read env → build
// the doctor's AppConfig view + resolve the entry-only values (workerPrincipal via os.userInfo,
// repoDir, canonicalBrainPath) → runInstallDoctor over the real adapters → stdout + exit code.
// REPORT-ONLY, LOCAL-ONLY. Not unit-tested (a process wrapper); runInstallDoctor is the tested unit.
import { userInfo } from "node:os";
import { createLocalCommandRunner, createLoopbackBindProbe } from "../probe-adapters";
import { runInstallDoctor } from "../doctor-cli";
import type { AppConfig } from "@sow/contracts";

/** Parse `SOW_VAULT_ROOT_PATHS` (a JSON `slug→path` map); malformed ⇒ undefined ⇒ fail-closed vault finding. */
function parseVaultRoots(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Build the doctor's AppConfig view from named non-secret env vars (no secret-shaped keys read). */
function configFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const apiPort = env.SOW_API_PORT !== undefined ? Number(env.SOW_API_PORT) : undefined;
  const vaultRootPaths = parseVaultRoots(env.SOW_VAULT_ROOT_PATHS);
  return {
    // operationalDbPath is required by AppConfig; the doctor does NOT read it (a placeholder is fine).
    operationalDbPath: env.SOW_OPERATIONAL_DB_PATH ?? "sow.db",
    ...(apiPort !== undefined && Number.isInteger(apiPort) && apiPort >= 1 && apiPort <= 65535 ? { apiPort } : {}),
    ...(env.SOW_TEMPORAL_ADDRESS !== undefined ? { temporalAddress: env.SOW_TEMPORAL_ADDRESS } : {}),
    ...(vaultRootPaths !== undefined ? { vaultRootPaths } : {}),
  };
}

async function main(): Promise<number> {
  const env = process.env;
  return runInstallDoctor({
    config: configFromEnv(env),
    run: createLocalCommandRunner(),
    bindLoopback: createLoopbackBindProbe(),
    write: (output) => process.stdout.write(output + "\n"),
    workerPrincipal: userInfo().username,
    canonicalBrainPath: env.SOW_CANONICAL_BRAIN_PATH ?? "",
    repoDir: process.cwd(),
    localBackupAccepted: env.SOW_LOCAL_BACKUP_ACCEPTED === "1",
  });
}

// Set `process.exitCode` + let the event loop DRAIN (never `process.exit()` mid-write — that can
// truncate the piped report an install script reads). Any unforeseen rejection fails CLOSED (exit 1).
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.exitCode = 1;
  });
