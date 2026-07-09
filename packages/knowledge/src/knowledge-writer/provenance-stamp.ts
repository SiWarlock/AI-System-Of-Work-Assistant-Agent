// SignedProvenanceStamper (task 4.15, §6; write-through amendment invariant (iii)
// "signed provenance"). At the KnowledgeWriter atomic commit, mints an HMAC
// `SignedProvenanceStamp` that binds a fact's *content* + *location* to the
// KnowledgeWriter's exclusive authorship — turning "Markdown-provenanced" from a
// copyable label into an UNFORGEABLE property (design doc §2 leg 2, §3 row 2).
//
// The signature is (scheme v2)
//   sig = HMAC-SHA256(key, PREIMAGE(workspaceId, factIdentity, originPath,
//                                   mdContentSha))
// over a length-prefixed, domain-separated preimage (so no field's bytes can
// bleed into an adjacent field — a canonicalization/field-injection defense).
// `kwRevision` / `sourceEventRef` / `committedAt` ride in the stamp but are
// deliberately OUTSIDE the signed preimage: the sig protects the CONTENT+LOCATION
// tuple, and 4.17's serving gate re-derives exactly that tuple from committed
// Markdown to admit.
//
// WHY kwRevision IS NOT BOUND (v2 — the load-bearing correctness fix). A stamp binds a
// SINGLE note; `kwRevision` is the WHOLE-VAULT revision (a global content hash of every
// file), which advances on EVERY commit to ANY note. If the sig bound it, the serving
// gate — which re-derives `kwRevision` = the CURRENT whole-vault revision — would reject
// every stamp the instant an unrelated note committed (self-invalidating). Binding it
// buys NO security: revision-freshness is already enforced by the serving gate's leg A
// (rehydrated `mdContentSha` must equal the allow-set's `mdContentSha` AT the current
// revision) and leg C (allow-set membership at the current revision). Stale-content
// replay is impossible because rehydrate reads the trusted committed vault, not an
// attacker payload. So the stamp binds only the note-stable content+location tuple.
//
// SERVE-TIME CONTENT REBINDING (the load-bearing property): `verifyProvenanceStamp`
// recomputes the HMAC from the INDEPENDENTLY re-derived tuple (never the stamp's
// self-reported fields — an attacker controls those) and constant-time-compares
// to `stamp.sig`. A stamp copied onto fabricated bytes fails because the serve-
// time `mdContentSha` differs from the signed one; a stamp re-pointed to another
// note fails on `factIdentity`/`originPath`/`workspaceId`; a forged sig fails
// because the attacker lacks the key. (Design doc GO #3 (c).)
//
// SAFETY RULE 1 — the stamp's `writerActor` is pinned to the `"KnowledgeWriter"`
// literal by the frozen `SignedProvenanceStampSchema`; this module returns only
// schema-valid stamps.
// SAFETY RULE 7 — the signing key is resolved ONLY through the injected
// `SecretsPort` (macOS Keychain), by opaque reference. It is held in a local
// binding for the single HMAC call and NEVER placed in the returned stamp, in a
// typed error, or anywhere loggable; the generative / DB-write / runtime paths
// are never handed this port. Any thrown port is converted to a typed
// `secret_unresolved` — never a throw across the boundary (§16).
//
// Deterministic (same inputs + key ⇒ same sig); no clock/network/fs of its own —
// `committedAt` is supplied by the writer's injected clock. Returns a typed
// `Result`; NEVER throws.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ok, err } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  FactIdentity,
  MdContentSha,
  RevisionId,
  SignedProvenanceStamp,
} from "@sow/contracts";
import { SignedProvenanceStampSchema } from "@sow/contracts";
import { serializeScalar, readFrontmatterField, KW_STAMP_FRONTMATTER_KEY } from "./frontmatter";

// ── injected SecretsPort (safety rule 7) ─────────────────────────────────────

/**
 * Opaque handle to a secret managed by macOS Keychain / SecretsPort. It names a
 * key; it is NOT the key material and is safe to carry in a typed error.
 *
 * NOTE (arch_gap): §3 does not yet export a canonical `SecretsPort`; this is the
 * minimal in-package accessor task 4.15 needs. If/when a project-wide SecretsPort
 * lands, this interface is the seam to fold into it (resolve-by-reference only).
 */
export type SecretRef = string;

/** Typed, redaction-safe failure to resolve a signing key — carries only the ref. */
export interface SecretUnresolved {
  readonly code: "secret_unresolved";
  readonly ref: SecretRef;
  readonly reason?: string;
}

/**
 * Minimal SecretsPort: resolves signing-key material by opaque reference. The
 * SOLE holder of the HMAC key. Implementations MUST NOT log the resolved value.
 * Returns a typed `Result`; a real Keychain adapter converts its own faults to
 * `SecretUnresolved` rather than throwing.
 */
export interface SecretsPort {
  resolveSigningKey(
    ref: SecretRef,
  ): Promise<Result<Uint8Array, SecretUnresolved>>;
}

/** Injected dependencies for minting/verifying a stamp. */
export interface StamperDeps {
  readonly secrets: SecretsPort;
  /** Opaque Keychain reference to the KW provenance-signing key. */
  readonly signingKeyRef: SecretRef;
}

// ── signing inputs / outputs ─────────────────────────────────────────────────

/**
 * The full set of stamp inputs. The FOUR content-binding fields (workspaceId, factIdentity, originPath,
 * mdContentSha) form the signed preimage; `kwRevision` + `sourceEventRef` + `committedAt` are carried UNSIGNED
 * informational metadata in the emitted stamp (see module header — `kwRevision` records the vault revision the
 * note was committed against, but is NOT part of the security binding).
 */
export interface StampInputs {
  readonly workspaceId: WorkspaceId;
  readonly factIdentity: FactIdentity;
  readonly originPath: string;
  readonly mdContentSha: MdContentSha;
  /** UNSIGNED informational metadata (not bound by the sig) — the vault revision at commit. */
  readonly kwRevision: RevisionId;
  readonly sourceEventRef: string;
  /** ISO-8601, supplied by the writer's injected clock. */
  readonly committedAt: string;
}

/** The four content-binding fields the signature covers (revision-independent — see module header). */
export interface SignedTuple {
  readonly workspaceId: WorkspaceId;
  readonly factIdentity: FactIdentity;
  readonly originPath: string;
  readonly mdContentSha: MdContentSha;
}

/** Serve-time verify inputs: the stamp + the INDEPENDENTLY re-derived tuple. */
export interface VerifyInputs extends SignedTuple {
  readonly stamp: SignedProvenanceStamp;
}

/** A minted stamp that failed the frozen contract gate (should be unreachable). */
export interface StampInvalid {
  readonly code: "stamp_invalid";
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

export type StampError = SecretUnresolved | StampInvalid;
export type VerifyError = SecretUnresolved;

// ── signed preimage (length-prefixed, domain-separated) ──────────────────────

// v2: the signed preimage binds CONTENT+LOCATION only (workspaceId, factIdentity, originPath, mdContentSha) —
// the volatile whole-vault `kwRevision` was REMOVED from the binding (see the module header). The scheme bump
// domain-separates v2 sigs from any v1 sig so a v1 stamp can never be replayed under v2.
const PREIMAGE_SCHEME = "sow:provenance-stamp:v2";
// NUL separator (matches the CanonicalFactDeriver convention). The separator is
// belt-and-braces only — each field is already utf8-byte-length-prefixed, so the
// preimage is unambiguous regardless of separator choice.
const FIELD_SEP = String.fromCharCode(0);

/**
 * Canonical, injection-resistant preimage over the four content-binding fields.
 * Each field is length-prefixed (`<utf8-byte-length>:<field>`) so no field's
 * bytes can be reinterpreted as part of an adjacent field regardless of the
 * separator; a scheme tag domain-separates this signature from any other HMAC
 * use of the same key.
 */
function signingPreimage(t: SignedTuple): string {
  const fields = [
    PREIMAGE_SCHEME,
    t.workspaceId,
    t.factIdentity,
    t.originPath,
    t.mdContentSha,
  ];
  return fields
    .map((f) => `${Buffer.byteLength(f, "utf8")}:${f}`)
    .join(FIELD_SEP);
}

/** Resolve the key + compute the hex HMAC-SHA256 sig; typed, never throws. */
async function computeSig(
  tuple: SignedTuple,
  deps: StamperDeps,
): Promise<Result<string, SecretUnresolved>> {
  let resolved: Result<Uint8Array, SecretUnresolved>;
  try {
    resolved = await deps.secrets.resolveSigningKey(deps.signingKeyRef);
  } catch (cause) {
    // A port that throws is still contained here — never a throw across the boundary.
    return err({
      code: "secret_unresolved",
      ref: deps.signingKeyRef,
      reason: cause instanceof Error ? cause.name : "resolve_threw",
    });
  }
  if (!resolved.ok) {
    return resolved;
  }
  // `key` lives only in this frame for the single HMAC call — never returned/logged.
  const key = resolved.value;
  const sig = createHmac("sha256", key)
    .update(signingPreimage(tuple), "utf8")
    .digest("hex");
  return ok(sig);
}

// ── mint ─────────────────────────────────────────────────────────────────────

/**
 * Mint a `SignedProvenanceStamp` for one fact at the KW atomic commit. Resolves
 * the signing key via the injected SecretsPort, HMAC-signs the content-binding
 * tuple, and returns the schema-valid stamp (`writerActor: 'KnowledgeWriter'`).
 * Typed `Result`; NEVER throws (safety rules 1 + 7, §16).
 */
export async function stampProvenance(
  inputs: StampInputs,
  deps: StamperDeps,
): Promise<Result<SignedProvenanceStamp, StampError>> {
  const signed = await computeSig(inputs, deps);
  if (!signed.ok) {
    return signed;
  }

  const candidate = {
    kwRevision: inputs.kwRevision,
    originPath: inputs.originPath,
    mdContentSha: inputs.mdContentSha,
    writerActor: "KnowledgeWriter" as const,
    sourceEventRef: inputs.sourceEventRef,
    committedAt: inputs.committedAt,
    sig: signed.value,
  };

  // Emit only stamps that survive the frozen contract gate (one-writer literal,
  // datetime, sha256-hex, non-empty ref/sig). A failure here is an internal
  // contract-drift bug, not candidate data — still typed, never thrown.
  const parsed = SignedProvenanceStampSchema.safeParse(candidate);
  if (!parsed.success) {
    return err({
      code: "stamp_invalid",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return ok(parsed.data);
}

// ── verify (serve-time content rebinding) ────────────────────────────────────

/**
 * Verify a stamp at serve time. Recomputes the HMAC from the INDEPENDENTLY
 * re-derived tuple (`workspaceId/factIdentity/originPath/mdContentSha/kwRevision`
 * from `CanonicalFactDeriver` @ the current revision — NOT the stamp's own
 * fields) and constant-time-compares to `stamp.sig`. Returns `ok(true)` iff the
 * sig matches; `ok(false)` on any mismatch (copied/forged/re-pointed stamp,
 * wrong key). A malformed-length sig is a non-match, not a fault. Returns a
 * typed `secret_unresolved` only when the key cannot be resolved; NEVER throws.
 */
export async function verifyProvenanceStamp(
  inputs: VerifyInputs,
  deps: StamperDeps,
): Promise<Result<boolean, VerifyError>> {
  const expected = await computeSig(inputs, deps);
  if (!expected.ok) {
    return expected;
  }
  return ok(constantTimeHexEqual(expected.value, inputs.stamp.sig));
}

// ── frontmatter storage (gate 4 G1c — where the stamp lives on disk) ─────────────

/**
 * Serialize a stamp to the compact-JSON value stored under the reserved `kwStamp` frontmatter key. It is a
 * single physical line (JSON escapes any newline), so the writer's line-based `composeNote` and the deriver's
 * first-colon `parseNote` both keep it intact. The deriver carves `kwStamp` out of the page hash (G1b), so
 * storing this value does NOT perturb the `mdContentSha` the stamp itself signs.
 */
export function serializeStampFieldValue(stamp: SignedProvenanceStamp): string {
  return serializeScalar(stamp);
}

/**
 * Read + VALIDATE a note's provenance stamp back from its committed Markdown. Returns the stamp iff the note
 * carries a `kwStamp` key whose value is JSON that satisfies `SignedProvenanceStampSchema`; otherwise `null`
 * (no key, non-JSON, or schema-invalid — all fail closed). Reads through `readFrontmatterField`, so an
 * UNTRUSTED note framed by another tool (BOM / CRLF / trailing-fence-at-EOF) is normalized first. Pure; never
 * throws. This is the read half the serving gate's `RehydrateFn` (G1e) uses to recover the stamp for
 * re-verification; validating here means a tampered/garbage stamp value degrades to "no stamp", not a crash.
 */
export function readStampField(content: string): SignedProvenanceStamp | null {
  const raw = readFrontmatterField(content, KW_STAMP_FRONTMATTER_KEY);
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // non-JSON kwStamp value (hand-edited / corrupt) → fail closed
  }
  const result = SignedProvenanceStampSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Constant-time hex comparison. Unequal-length inputs (or non-decodable hex)
 * are a non-match — decoded to equal-length buffers only when the lengths agree,
 * so `timingSafeEqual` never throws.
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  // Buffer.from(hex) silently drops invalid/odd nibbles; if that desynced the
  // lengths, it cannot be a match.
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
