// @sow/integrations — gateway-boundary log redaction (§16).
//
// The MANDATORY redaction layer every Connector Gateway (reads) and Tool Gateway
// (writes) diagnostic runs through BEFORE it reaches a log sink (safety rule 7 /
// §16). It strips credential-shaped strings (API keys, PEM blocks, URL basic-auth)
// and DROPS whole raw-content fields (fetched connector content, raw write
// payloads, response bodies) so raw fetched/written content or a secret never
// lands in a log. Only IDs + a typed status + credential-scrubbed diagnostic
// lines survive (`buildSafeConnectorLog` / `buildSafeToolWriteLog`).
//
// MIRRORS `@sow/providers` provider-log-redaction (same credential-prefix /
// sensitive-keyword / URL-userinfo patterns) rather than importing it — that
// module scrubs provider prompts/responses; this one scrubs connector-read
// content and external-write payloads. Kept in-package so the gateway boundary
// has no cross-track import into providers.
//
// A content hash such as "sha256:deadbeef" is judged SAFE (it is not a credential
// shape). PURE + DETERMINISTIC: no clock, no I/O, no throw across a boundary. A
// field that cannot be made safe is DROPPED (fail-safe), never logged raw.
import type { TargetSystem } from "@sow/contracts";

// --- placeholders -----------------------------------------------------------

/** Replaces an in-line credential-shaped substring inside an otherwise-safe string. */
export const REDACTED = "[REDACTED]" as const;

/**
 * Replaces a WHOLE field that could not be made redaction-safe (a diagnostic that
 * still trips a sensitive-keyword or an unrecognized credential shape after
 * scrubbing). Fail-safe: dropped rather than emitted raw. Chosen so it is itself
 * redaction-safe (no credential prefix / sensitive keyword / userinfo).
 */
export const DROPPED_FIELD = "[REDACTED:field-dropped]" as const;

// --- detection (mirrors @sow/providers provider-log-redaction) --------------

// Credential-shaped prefixes (provider/connector API keys, cloud creds, PEM
// blocks, JWTs). A content hash such as "sha256:deadbeef" does NOT match.
const CREDENTIAL_PREFIX =
  /(sk-[a-z0-9]|sk_(live|test)|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/i;

// Sensitive keywords that indicate a raw-content / secret leak. Deliberately
// omits bare "token" so a structured status code (e.g. AUTH_TOKEN_INVALID) is not
// a false hit.
const SENSITIVE_KEYWORD =
  /\b(pass(word|wd)|secret|api[_-]?key|bearer|credential|private[_ -]?key|passphrase)\b/i;

// A URL userinfo credential (`scheme://user:pass@host` or `//user:pass@host`).
const URL_USERINFO_CREDENTIAL = /\/\/[^/\s:@]+:[^/\s@]+@/;

// A Google API key (`AIza…`, ~39 chars). Fixed prefix + charset is distinctive; no
// delimiter needed. (An AKIA access-key id is already covered above; the AWS SECRET
// key has NO fixed prefix and is caught below only when it rides a credential query
// param — a bare 40-char opaque secret cannot be told apart from a content hash.)
const GOOGLE_API_KEY = /AIza[0-9A-Za-z_-]{10,}/;

// A credential-bearing URL/query parameter: `?key=…`, `&access_token=…`,
// `client_secret=…`, `?sig=…`, etc. The VALUE is the secret. This catches the
// common "secret echoed in a request URL" vendor-error leak (e.g. a Google API key
// in a 401 message, or an AWS secret in a signed URL) that no fixed prefix or bare
// keyword recognizes. The negative lookahead lets an ALREADY-scrubbed value (the
// `[REDACTED]` placeholder) pass, so a scrubbed URL is judged safe (no over-drop).
const URL_CREDENTIAL_PARAM =
  /[?&](?:x-amz-(?:signature|credential|security-token)|x-goog-signature|api[_-]?key|apikey|key|access[_-]?token|token|client[_-]?secret|secret|password|passwd|pwd|sig|signature|auth|bearer)=(?!\[REDACTED\])[^&#\s]+/i;

function looksUnsafe(s: string): boolean {
  return (
    CREDENTIAL_PREFIX.test(s) ||
    SENSITIVE_KEYWORD.test(s) ||
    URL_USERINFO_CREDENTIAL.test(s) ||
    GOOGLE_API_KEY.test(s) ||
    URL_CREDENTIAL_PARAM.test(s)
  );
}

/**
 * True iff the string carries no credential-shaped substring and no raw-content /
 * secret marker — i.e. it is safe to emit to a log sink verbatim. Pure.
 */
export function isGatewayLogSafe(value: string): boolean {
  return !looksUnsafe(value);
}

// --- scrubbing --------------------------------------------------------------

// A full PEM block (BEGIN … END). Matched (removed) first so residual key
// material never survives.
const PEM_BLOCK = /-----BEGIN[\s\S]*?-----END[^-]*-----/g;

// A URL basic-auth `user:pass@` segment — credential portion replaced, host kept.
const URL_USERINFO_SEGMENT = /(\/\/)[^/\s:@]+:[^/\s@]+@/g;

// Recognized credential TOKENS (the concrete shapes CREDENTIAL_PREFIX detects).
// Replacing the whole token both scrubs the secret and clears the prefix so the
// scrubbed result is redaction-safe.
const CREDENTIAL_TOKEN =
  /(sk-[A-Za-z0-9][A-Za-z0-9_-]{6,}|sk_(?:live|test)_[A-Za-z0-9]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{10,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?)/g;

// A credential-bearing URL/query parameter — global form for scrubbing. Keeps the
// param NAME + `=` (`$1`), replaces only the secret VALUE with `REDACTED`.
const URL_CREDENTIAL_PARAM_SEGMENT =
  /([?&](?:x-amz-(?:signature|credential|security-token)|x-goog-signature|api[_-]?key|apikey|key|access[_-]?token|token|client[_-]?secret|secret|password|passwd|pwd|sig|signature|auth|bearer)=)(?!\[REDACTED\])[^&#\s]+/gi;

/**
 * Scrub credential-shaped substrings from a diagnostic string. Recognized shapes
 * (API-key tokens incl. Google `AIza…`, PEM blocks, URL basic-auth, and secrets
 * carried in a URL/query parameter such as `?key=…`/`&access_token=…`) are replaced
 * with `REDACTED`, preserving surrounding non-sensitive text (a request URL keeps
 * its path + host, loses only the secret). If the result STILL trips the safety net
 * (an unrecognized credential shape or a residual sensitive keyword such as
 * `password`/`secret`), the whole field is UNREDACTABLE and dropped to
 * `DROPPED_FIELD` — never emitted raw. Idempotent + pure.
 */
export function redactString(value: string): string {
  const scrubbed = value
    .replace(PEM_BLOCK, REDACTED)
    .replace(URL_USERINFO_SEGMENT, `$1${REDACTED}@`)
    .replace(URL_CREDENTIAL_PARAM_SEGMENT, `$1${REDACTED}`)
    .replace(CREDENTIAL_TOKEN, REDACTED);
  if (looksUnsafe(scrubbed)) return DROPPED_FIELD;
  return scrubbed;
}

// --- connector-read safe record ---------------------------------------------

/**
 * The candidate fields a Connector Gateway read might want to log. `rawContent`
 * is the RAW fetched connector payload — NEVER emitted and never reaches the
 * output record. IDs + typed status + a scrubbed diagnostic are the only surface.
 */
export interface ConnectorLogFields {
  readonly connectorId?: string;
  readonly workspaceId?: string;
  readonly status?: string;
  readonly cursor?: string;
  readonly diagnostic?: string;
  /** Raw fetched connector content — dropped, never logged. */
  readonly rawContent?: string;
  /** Raw connector response body — dropped, never logged. */
  readonly responseBody?: unknown;
}

/**
 * The redacted record safe to hand a log sink for a connector read: IDs + typed
 * status + a credential-scrubbed diagnostic ONLY. Raw content / response body are
 * structurally absent.
 */
export interface SafeConnectorLog {
  readonly connectorId?: string;
  readonly workspaceId?: string;
  readonly status?: string;
  readonly cursor?: string;
  readonly diagnostic?: string;
}

/**
 * Build the safe connector-read log record. Drops raw content / response body
 * entirely; carries only IDs + typed status + a scrubbed diagnostic. Every
 * surviving string is run through `redactString` defensively. Optional fields
 * absent on the input are omitted. Pure.
 */
export function buildSafeConnectorLog(fields: ConnectorLogFields): SafeConnectorLog {
  return {
    ...(fields.connectorId !== undefined
      ? { connectorId: redactString(fields.connectorId) }
      : {}),
    ...(fields.workspaceId !== undefined
      ? { workspaceId: redactString(fields.workspaceId) }
      : {}),
    ...(fields.status !== undefined ? { status: redactString(fields.status) } : {}),
    ...(fields.cursor !== undefined ? { cursor: redactString(fields.cursor) } : {}),
    ...(fields.diagnostic !== undefined
      ? { diagnostic: redactString(fields.diagnostic) }
      : {}),
  };
}

// --- tool-write safe record -------------------------------------------------

/**
 * The candidate fields a Tool Gateway write might want to log. `rawPayload` /
 * `responseBody` are RAW write request/response payloads — NEVER emitted and
 * never reach the output record. Keys + typed status + a scrubbed diagnostic are
 * the only surface. `payloadHash` (a `sha256:` digest) is safe by construction.
 */
export interface ToolWriteLogFields {
  readonly targetSystem?: TargetSystem;
  readonly canonicalObjectKey?: string;
  readonly idempotencyKey?: string;
  readonly payloadHash?: string;
  readonly status?: string;
  readonly diagnostic?: string;
  /** Raw external-write request payload — dropped, never logged. */
  readonly rawPayload?: unknown;
  /** Raw external-write response body — dropped, never logged. */
  readonly responseBody?: unknown;
}

/**
 * The redacted record safe to hand a log sink for a tool write: canonical /
 * idempotency keys + payloadHash + typed status + a credential-scrubbed
 * diagnostic ONLY. Raw payload / response body are structurally absent.
 */
export interface SafeToolWriteLog {
  readonly targetSystem?: TargetSystem;
  readonly canonicalObjectKey?: string;
  readonly idempotencyKey?: string;
  readonly payloadHash?: string;
  readonly status?: string;
  readonly diagnostic?: string;
}

/**
 * Build the safe tool-write log record. Drops raw payload / response body
 * entirely; carries only keys + payloadHash + typed status + a scrubbed
 * diagnostic. Every surviving string is run through `redactString` defensively;
 * `targetSystem` is a closed enum and passes through unchanged. Optional fields
 * absent on the input are omitted. Pure.
 */
export function buildSafeToolWriteLog(fields: ToolWriteLogFields): SafeToolWriteLog {
  return {
    ...(fields.targetSystem !== undefined ? { targetSystem: fields.targetSystem } : {}),
    ...(fields.canonicalObjectKey !== undefined
      ? { canonicalObjectKey: redactString(fields.canonicalObjectKey) }
      : {}),
    ...(fields.idempotencyKey !== undefined
      ? { idempotencyKey: redactString(fields.idempotencyKey) }
      : {}),
    ...(fields.payloadHash !== undefined
      ? { payloadHash: redactString(fields.payloadHash) }
      : {}),
    ...(fields.status !== undefined ? { status: redactString(fields.status) } : {}),
    ...(fields.diagnostic !== undefined
      ? { diagnostic: redactString(fields.diagnostic) }
      : {}),
  };
}
