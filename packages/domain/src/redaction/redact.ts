// @sow/domain — the CANONICAL redaction API (task 10.1, §16 / safety rule 7).
//
// Three pure primitives every log/error sink MUST run BEFORE emitting:
//   (a) redactString  — credential-scrub with a fail-safe whole-field drop.
//   (b) redactRecord  — field-level ALLOWLIST classifier (unknown field ⇒ REDACTED;
//       output structurally stable — field present, value replaced).
//   (c) redactError   — strips a secret / prompt / raw-content embedded in an
//       Error's message / stack / cause chain, exposing only a typed cause `.code`.
//
// Output uses the FROZEN @sow/contracts markers (REDACTED_CREDENTIAL / REDACTED_RAW
// / REDACTED_FIELD) so log SHAPE is stable and tests/parsers can assert on it
// without ever seeing a secret. Employer-Work raw content stays redacted even
// behind a debug flag (safety rule 5) — `redactRecord`'s `debug` option NEVER
// unlocks raw content; it exists only to widen NON-content diagnostics.
//
// PURE + DETERMINISTIC: no clock, no I/O, no throw across a boundary. `redactError`
// tolerates a non-Error thrown value (returns a redacted structured shape) so it is
// total. §16: never throw across a subsystem boundary.
import {
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
} from "@sow/contracts";
import {
  looksUnsafe,
  looksLikeRawContent,
  isAllowlistedField,
  PEM_BLOCK,
  URL_USERINFO_SEGMENT,
  CREDENTIAL_TOKEN,
} from "./redaction-rules";

// Re-export the classifier surface so downstream consumers depend on ONE module.
// The scrub patterns (PEM_BLOCK / URL_USERINFO_SEGMENT / CREDENTIAL_TOKEN) are
// re-exported too so the provider boundary can reuse the SAME detectors instead of
// keeping a second copy (task 10.1 "generalize, do not duplicate").
export {
  SAFE_FIELD_ALLOWLIST,
  isAllowlistedField,
  looksUnsafe,
  looksLikeRawContent,
  CREDENTIAL_PREFIX,
  SENSITIVE_KEYWORD,
  URL_USERINFO_CREDENTIAL,
  PEM_BLOCK,
  URL_USERINFO_SEGMENT,
  CREDENTIAL_TOKEN,
  RAW_CONTENT_MAX_LEN,
} from "./redaction-rules";

/**
 * True iff the string carries no credential-shaped substring and no secret marker
 * — i.e. it is safe to emit verbatim. Pure. (Raw-content shape is a separate,
 * field-level concern handled by `redactRecord`.)
 */
export function isRedactionSafe(value: string): boolean {
  return !looksUnsafe(value);
}

/**
 * Scrub credential-shaped substrings from a diagnostic string. Recognized shapes
 * (API-key tokens, PEM blocks, URL basic-auth) are replaced with the frozen
 * `REDACTED_CREDENTIAL` marker, preserving the surrounding non-sensitive text. If
 * the result STILL trips the safety net (an unrecognized credential shape or a
 * residual sensitive keyword such as `password`/`secret`), the WHOLE field is
 * UNREDACTABLE and is dropped to `REDACTED_FIELD` — never emitted raw. Idempotent
 * + pure.
 */
export function redactString(value: string): string {
  const scrubbed = value
    .replace(PEM_BLOCK, REDACTED_CREDENTIAL)
    .replace(URL_USERINFO_SEGMENT, `$1${REDACTED_CREDENTIAL}@`)
    .replace(CREDENTIAL_TOKEN, REDACTED_CREDENTIAL);
  if (looksUnsafe(scrubbed)) return REDACTED_FIELD;
  return scrubbed;
}

// ── field-value classification ───────────────────────────────────────────────

/**
 * Classify a single scalar-ish value that sits under an ALLOWLISTED field name.
 * Order of screens (most-specific → catch-all):
 *   1. raw-content shape (multi-line / over-length) ⇒ REDACTED_RAW (never unlocked
 *      by debug — safety rule 5);
 *   2. credential/keyword scrub via `redactString` (may yield REDACTED_CREDENTIAL,
 *      a clean string, or REDACTED_FIELD if unredactable);
 *   3. finite primitives (number/boolean) pass through;
 *   4. anything else (nested object/array) is recursed by `redactRecord`.
 */
function redactAllowlistedValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (looksLikeRawContent(value)) return REDACTED_RAW;
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactAllowlistedValue);
  if (typeof value === "object") {
    return redactRecord(value as Record<string, unknown>);
  }
  // functions / symbols / bigint — never safe to serialize; drop.
  return REDACTED_FIELD;
}

/** Options for {@link redactRecord}. `debug` NEVER unlocks raw/secret content. */
export interface RedactRecordOptions {
  /**
   * Debug logging flag. It may widen NON-content diagnostics elsewhere, but it does
   * NOT relax the redaction rules here — an Employer-Work raw field stays
   * REDACTED_RAW even at debug (safety rule 5). Present so callers can pass a
   * uniform options object; intentionally has no effect on redaction.
   */
  readonly debug?: boolean;
}

/**
 * Field-level ALLOWLIST classifier. Returns a NEW record with EVERY input key
 * preserved (structurally stable) but each value replaced per policy:
 *   - key NOT on the allowlist                    ⇒ REDACTED_FIELD (value unseen);
 *   - allowlisted key, raw-content-shaped value   ⇒ REDACTED_RAW;
 *   - allowlisted key, credential-shaped value    ⇒ scrubbed via `redactString`;
 *   - allowlisted key, clean scalar / nested obj  ⇒ passed through / recursed.
 *
 * Denylist is INSUFFICIENT: an unrecognized field defaults to REDACTED, never
 * passed through. Pure — no clock/network/random; `_opts` is accepted for a
 * uniform call shape but does not relax any rule (safety rule 5). §16 no-throw.
 */
export function redactRecord(
  record: Record<string, unknown>,
  _opts?: RedactRecordOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isAllowlistedField(key)) {
      out[key] = REDACTED_FIELD;
      continue;
    }
    out[key] = redactAllowlistedValue(value);
  }
  return out;
}

// ── error redaction ──────────────────────────────────────────────────────────

/**
 * The redacted, log-safe projection of a thrown value. `message` and `stack` are
 * credential/secret-scrubbed; `causeCode` carries ONLY a stable code string from a
 * typed cause (`{ code }`), never the raw cause object / message / stack. There is
 * no field here that can carry a raw prompt, a raw body, or a secret.
 */
export interface RedactedError {
  readonly message: string;
  readonly stack?: string;
  /** Stable cause code from a typed `{ code }` cause — never the raw cause. */
  readonly causeCode?: string;
}

/**
 * Redact the value of an inner cause down to a stable code string. A typed cause
 * (`{ code: string }`) yields its code (itself scrubbed defensively); anything else
 * yields undefined — the raw cause never surfaces. Recurses one level to find a
 * code on a wrapped Error's own cause. Pure.
 */
function extractCauseCode(cause: unknown): string | undefined {
  if (cause === null || cause === undefined) return undefined;
  if (typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.trim().length > 0) {
      const scrubbed = redactString(code);
      return scrubbed === REDACTED_FIELD ? undefined : scrubbed;
    }
    // a wrapped Error whose OWN cause carries the code
    const nested = (cause as { cause?: unknown }).cause;
    if (nested !== undefined) return extractCauseCode(nested);
  }
  return undefined;
}

/**
 * Redact a thrown value BEFORE logging (closes the unlogged-egress gap). Strips a
 * prompt / raw-content / secret embedded in the Error's `message`, `stack`, and
 * `cause` chain; the surfaced projection exposes only a scrubbed message + stack
 * and a typed cause `.code` (drivers/subsystems surface only `.code`, per the
 * Phase-7 LOW). Multi-line messages/stacks that survive scrubbing but still look
 * like raw content are dropped whole to `REDACTED_RAW`. Total: a non-Error thrown
 * value is coerced to its string form and scrubbed. Pure — §16 no-throw.
 */
export function redactError(err: unknown): RedactedError {
  if (err instanceof Error) {
    const message = redactMessageLike(err.message);
    const causeCode = extractCauseCode(err.cause);
    if (typeof err.stack === "string") {
      const stack = redactMessageLike(err.stack);
      return causeCode !== undefined
        ? { message, stack, causeCode }
        : { message, stack };
    }
    return causeCode !== undefined ? { message, causeCode } : { message };
  }
  // non-Error thrown value: coerce + scrub.
  return { message: redactMessageLike(stringifyThrown(err)) };
}

/**
 * Scrub a message/stack string: credential-scrub first, then treat a surviving
 * multi-line / over-length payload as raw content and drop it whole. So a raw
 * multi-line prompt in an Error message can never survive. Pure.
 */
function redactMessageLike(s: string): string {
  const scrubbed = redactString(s);
  if (scrubbed === REDACTED_FIELD) return scrubbed;
  if (looksLikeRawContent(scrubbed)) return REDACTED_RAW;
  return scrubbed;
}

/** Best-effort, no-throw string form of a non-Error thrown value. Pure. */
function stringifyThrown(err: unknown): string {
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  return "[non-error thrown value]";
}
