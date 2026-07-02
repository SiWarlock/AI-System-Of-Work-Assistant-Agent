// 10.7 — worker config loader: secrets-out-of-config guard (REQ-S-003, safety rule 7).
//
// Non-secret config lives in .env / config files; SECRETS never do — they are
// resolved only through SecretsPort/Keychain. This is the worker-layer ENTRY POINT
// that runs the FROZEN @sow/contracts `secretShapeGuard` at load: it REJECTS any
// secret-shaped KEY name or credential-shaped VALUE that leaked into the config
// (fail-closed, BEFORE the config crosses into worker services), else parses via
// `appConfigSchema`, returning a typed Result<AppConfig, ConfigLoadError>.
//
// PURE + total: no I/O (the caller reads the raw env/file and hands us the record),
// no clock, and NEVER throws across the boundary (§16) — a hostile non-record input
// folds to a typed `invalid_config`, not an exception.

import { err, secretShapeGuard } from "@sow/contracts";
import type { AppConfig, ConfigLoadError, Result } from "@sow/contracts";

/**
 * Load + validate the non-secret app config from an already-parsed raw record
 * (e.g. the merged .env / config-file object). Runs the frozen secret-shape guard
 * first (secrets are Keychain-only — REQ-S-003), so a leaked credential is rejected
 * as `secret_in_config` even when the record is also structurally invalid. A
 * non-object / null input folds to `invalid_config`; nothing throws (§16).
 */
export function loadConfig(
  rawEnv: Record<string, unknown>,
): Result<AppConfig, ConfigLoadError> {
  // Defend the boundary: a caller may hand raw parsed JSON that isn't an object.
  // Fold it to a typed error rather than letting `Object.keys`/the guard throw.
  if (rawEnv === null || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    return err({
      kind: "invalid_config",
      message: "config must be a JSON object",
    });
  }
  return secretShapeGuard(rawEnv);
}
