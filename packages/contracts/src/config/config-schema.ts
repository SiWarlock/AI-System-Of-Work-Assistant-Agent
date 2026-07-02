// Non-secret app-config contract + load-time secret-shape guard
// (plan task 10.7, contract portion; REQ-S-003 secrets are Keychain-only).
//
// Non-secret config lives in .env / config files; SECRETS never do — they are
// resolved only through SecretsPort/Keychain (safety rule 7). This module freezes
// the SHAPE of the non-secret config the app reads AND a pure load-time guard that
// REJECTS any secret-shaped value that leaked into a config file, fail-closed,
// BEFORE the config crosses into application services.
//
// This is a NEW plain typed contract, NOT an Appendix-A seam model — no JSON-Schema
// registry ceremony (no schemas/*.schema.json, no __snapshots__ field-set snap, no
// *_SCHEMA_ID). A focused Zod schema is the runtime gate; the guard adds the two
// secret-shape screens on top. PURE — imports only the foundation Result primitive.
//
// CARRY-FORWARD NOTE: the credential-shape detectors below (SECRET_KEY_NAME /
// CREDENTIAL_VALUE_SHAPE) intentionally DUPLICATE the ones in
// `packages/providers/src/redaction/provider-log-redaction.ts` for now. Task 10.1
// (the domain redactor, built later) will converge them into a SINGLE shared pure
// detector; until then both copies must be kept in lockstep. Do not let them drift.
import { z } from "zod";
import { ok, err } from "../primitives/result";
import type { Result } from "../primitives/result";

// ── Non-secret config shape ─────────────────────────────────────────────────
// A representative, extensible shape. It carries NO secret fields BY CONSTRUCTION
// — secrets are Keychain-only and never appear here. `.strict()` rejects any
// unknown top-level key so a smuggled field can't ride in unnoticed.

/** Supervision/backoff knobs for the worker crash-loop supervisor. */
const supervisionSchema = z
  .object({
    baseBackoffMs: z.number().int().nonnegative(),
    maxBackoffMs: z.number().int().nonnegative(),
    crashLoopThreshold: z.number().int().nonnegative(),
    crashLoopWindowMs: z.number().int().nonnegative(),
  })
  .strict();

export const appConfigSchema = z
  .object({
    // Path to the operational SQLite store (the one required field).
    operationalDbPath: z.string().min(1),
    // Local tRPC API port.
    apiPort: z.number().int().min(1).max(65535).optional(),
    // Temporal frontend address (host:port), NOT a secret.
    temporalAddress: z.string().min(1).optional(),
    // Per-workspace Markdown vault roots (slug → absolute path).
    vaultRootPaths: z.record(z.string(), z.string()).optional(),
    // Worker supervision knobs (all four required together when present).
    supervision: supervisionSchema.optional(),
    // How often to run the local backup routine.
    backupCadenceMs: z.number().int().nonnegative().optional(),
  })
  .strict();

/** The non-secret config the app reads. Inferred from `appConfigSchema`. */
export type AppConfig = z.infer<typeof appConfigSchema>;

// ── Load-time failure taxonomy ──────────────────────────────────────────────

/**
 * Why a config record was rejected at load time.
 * - `secret_in_config`: a secret-bearing KEY name, or a credential-shaped string
 *   VALUE, leaked into the config (secrets belong in Keychain — REQ-S-003).
 *   `offendingKey` names the top-level key that tripped the guard.
 * - `invalid_config`: the record does not conform to `appConfigSchema`.
 */
export interface ConfigLoadError {
  kind: "secret_in_config" | "invalid_config";
  message: string;
  offendingKey?: string;
}

// ── Secret-shape detectors (DUPLICATED from provider-log-redaction — see note) ─

// Secret-bearing KEY names. Any config key whose NAME matches this must never
// exist — the value belongs in Keychain, not a config file.
const SECRET_KEY_NAME =
  /secret|password|passwd|api[_-]?key|token|bearer|credential|private[_-]?key|passphrase/i;

// Credential-shaped string VALUES (provider API keys, cloud creds, PEM blocks,
// JWTs). A benign path/host value that merely contains "sk" as a substring does
// NOT match — the shapes are anchored to real credential prefixes.
const CREDENTIAL_VALUE_SHAPE =
  /sk-|sk_(live|test)|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\./;

// ── Recursive value scan ────────────────────────────────────────────────────

/** True iff `value` (recursively) contains a credential-shaped string. */
function hasCredentialShapedValue(value: unknown): boolean {
  if (typeof value === "string") return CREDENTIAL_VALUE_SHAPE.test(value);
  if (Array.isArray(value)) return value.some(hasCredentialShapedValue);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      hasCredentialShapedValue,
    );
  }
  return false;
}

// ── The guard ───────────────────────────────────────────────────────────────

/**
 * Load-time secret-shape guard. Returns `ok(config)` only when the record carries
 * no secret-bearing key, no credential-shaped value, AND conforms to
 * `appConfigSchema`. Fail-closed on secrets: the secret screens run BEFORE (and
 * take precedence over) structural validation, so a leaked secret is reported as
 * `secret_in_config` even if the record is also structurally invalid. PURE —
 * no clock, no I/O, no throw across a boundary.
 */
export function secretShapeGuard(
  record: Record<string, unknown>,
): Result<AppConfig, ConfigLoadError> {
  // (i) Reject any top-level key whose NAME looks secret-bearing.
  for (const key of Object.keys(record)) {
    if (SECRET_KEY_NAME.test(key)) {
      return err({
        kind: "secret_in_config",
        message: `secret-bearing config key "${key}" — secrets are Keychain-only (REQ-S-003)`,
        offendingKey: key,
      });
    }
  }

  // (ii) Reject any string VALUE (recursively) that looks credential-shaped.
  for (const [key, value] of Object.entries(record)) {
    if (hasCredentialShapedValue(value)) {
      return err({
        kind: "secret_in_config",
        message: `credential-shaped value under config key "${key}" — secrets are Keychain-only (REQ-S-003)`,
        offendingKey: key,
      });
    }
  }

  // (iii) Otherwise parse via the non-secret shape.
  const parsed = appConfigSchema.safeParse(record);
  if (!parsed.success) {
    return err({
      kind: "invalid_config",
      message: parsed.error.issues[0]?.message ?? "invalid config",
    });
  }
  return ok(parsed.data);
}
