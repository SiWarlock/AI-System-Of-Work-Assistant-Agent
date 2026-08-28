// Blocking pre-commit secret scan (task 4.3, §6) — REJECT, DO NOT REDACT.
//
// The writer projects a KnowledgeMutationPlan into fully-rendered post-apply
// file bytes; this scan runs over that content AFTER the ownership check and
// IMMEDIATELY BEFORE the atomic commit (writer.ts pipeline step 6). On ANY
// credential-shaped match the ENTIRE commit is rejected with `secret_found` —
// the writer never redacts-and-writes and never lands a partial / sanitized
// file (reject-not-redact is normative; safety rule 7 + §16). Because the
// scanned `content` is the whole rendered file, frontmatter and link mutations
// are covered, not only the note body.
//
// Detection runs the two credential-SHAPE nets — `CREDENTIAL_PREFIX` and
// `URL_USERINFO_CREDENTIAL`, imported from `@sow/domain` so there is still exactly
// ONE source per net (24.127's drift rule).
//
// ⛔ THIS FILE USED TO SAY: "reuses `isRedactionSafe` … a string is unsafe to commit
// IFF it would be unsafe as an audit field." ⭐ THAT IFF IS EXACTLY THE COLLAPSE
// 24.123 REMOVED, and it is corrected here rather than softened, because a reader who
// believes it will re-collapse the two granularities — the header would then be the
// instruction for reintroducing the defect. The commit path does NOT call
// `isRedactionSafe` and does NOT carry the keyword arm; see the granularity-split
// block below for the measurement that forced the split, and
// {@link auditFieldContainsSecret} for the predicate that still answers the audit
// question.
//
// The matched value is NEVER carried in the typed error or the rejection audit
// (§16 redaction): the error holds only `path` + a fixed, keyword-free `kind`.
import { ok, err } from "@sow/contracts";
import type { Result, FailureClass } from "@sow/contracts";
import { buildAuditSignal, isRedactionSafe, type AuditSignal } from "@sow/policy";
import { CREDENTIAL_PREFIX, URL_USERINFO_CREDENTIAL } from "@sow/domain";
import type { SecretScan, SecretScanContext, SecretFound } from "./writer";

// ── task 24.123 — THE GRANULARITY SPLIT (owner decision 2026-08-25) ──────────────
//
// ⛔ THE FINDING, restated because the remedy only makes sense against it: ONE
// predicate was reused across TWO VERY DIFFERENT SCAN GRANULARITIES.
//   * AUDIT granularity — short structured refs (`actor`, `event`, a ref token).
//     There, the bare word "password" IS suspicious: nothing legitimate puts it in
//     a structured audit field.
//   * COMMIT granularity — a WHOLE RENDERED MARKDOWN FILE of human prose. There,
//     "password" is just a word people write.
//
// MEASURED on this repo's real Markdown (668 tracked `.md` files), which is the
// closest realistic-note corpus available in-repo:
//   * rejected under the shared predicate ......... 219 / 668  (32.8%)
//   * of those, tripped by SENSITIVE_KEYWORD ...... 218
//   * tripped by a genuine credential SHAPE ....... 12 (prefix) + 11 (URL userinfo)
//   * rejected with the keyword arm removed ....... 20 / 668  (3.0%)
// ⇒ the keyword arm was 218 of 219 rejections and caught nothing a shape net did not.
//
// ⭐ THE COST THIS BUYS BACK IS NOT COSMETIC: this is the SOLE-WRITER path (safety
// rule 1) and its failure mode is REFUSAL TO WRITE. A third of the vault being
// unwritable is an availability failure on the one path that owns canonical truth.
//
// ⛔ WHAT IS DELIBERATELY KEPT: the credential-SHAPE nets. They cost 3% and they are
// the only thing standing between a pasted `sk-…` / PEM block / JWT / `user:pass@host`
// and a durable commit into the vault. Turning those off too would have made the
// scan's remaining 1-in-33 rejections vanish along with its entire reason to exist.
//
// The audit path is UNCHANGED — `isRedactionSafe` keeps every arm, including the
// keyword, because at audit granularity the keyword is doing real work.
const CONTENT_CREDENTIAL_NETS: readonly RegExp[] = Object.freeze([
  CREDENTIAL_PREFIX,
  URL_USERINFO_CREDENTIAL,
]);

/** Fixed, redaction-safe category label for a rejection — never the value. */
export const SECRET_SCAN_KIND = "credential_shaped" as const;

/**
 * Audit event for a pre-commit secret rejection. Deliberately keyword-free
 * (no `secret`/`credential`/`password` token) so the built AuditSignal is
 * itself redaction-safe and survives the §16 log-sink redaction layer intact.
 */
export const SECRET_SCAN_REJECTED_EVENT = "knowledge.precommit_scan.rejected" as const;

// ARCH_GAP (flagged): the frozen FailureClass enum names no `secret_scan_rejected`
// member. A pre-commit secret rejection is a candidate-data / pre-commit-gate
// rejection that BLOCKS the write, so it maps to `schema_rejection` (the
// pre-commit-gate bucket); the offending PATH is the distinct subjectRef
// (§10.3 dedupe = (failureClass, subjectRef)) so the System Health item is
// per-note distinct. Not a new enum member.
export const SECRET_SCAN_FAILURE_CLASS: FailureClass = "schema_rejection";

// Fixed, keyword-free placeholders for the probe's non-content fields so ONLY
// the scanned content drives the redaction verdict. (`isRedactionSafe` scans
// actor/event/payloadHash/before/after/refs — none of these may itself trip a
// pattern, else every scan would false-positive.)
const PROBE_ACTOR = "knowledge:kw";
const PROBE_EVENT = "scan.probe";
const PROBE_HASH = "sha256:scan";

/**
 * True iff `value` carries a credential SHAPE — a provider/cloud key prefix, a PEM
 * block, a JWT, or a URL userinfo credential. COMMIT granularity: this is the
 * predicate the sole-writer pre-commit scan runs over a whole rendered file.
 *
 * ⛔ NOT a keyword net, and NOT `isRedactionSafe`. This docstring previously claimed
 * both ("or a sensitive keyword … reuses the @sow/policy redaction patterns via
 * `isRedactionSafe`") and was left stale by 24.123's granularity split, which is the
 * one direction a stale claim here must never point: it describes the scan as STRICTER
 * than it is, so a reader auditing the sole-writer path would tick off a keyword
 * defence that is not there. For the keyword-inclusive audit question use
 * {@link auditFieldContainsSecret}.
 */
export function contentContainsSecret(value: string): boolean {
  return CONTENT_CREDENTIAL_NETS.some((net) => net.test(value));
}

/**
 * The pre-24.123 predicate — the AUDIT-granularity one, keyword arm included.
 *
 * ⛔ RETAINED, NOT DEAD: it is the honest way to ask "would this string be safe as an
 * AUDIT FIELD?", which is a different question from "may this file be committed?".
 * Anything scanning short structured values should use THIS, not
 * {@link contentContainsSecret}. Collapsing the two again is exactly the defect
 * 24.123 records.
 */
export function auditFieldContainsSecret(value: string): boolean {
  const probe: AuditSignal = buildAuditSignal({
    actor: PROBE_ACTOR,
    event: PROBE_EVENT,
    refs: [value],
    payloadHash: PROBE_HASH,
    beforeSummary: "",
    afterSummary: "",
  });
  return !isRedactionSafe(probe);
}

/**
 * Blocking pre-commit secret scan. Rejects the whole commit on a match
 * (`secret_found`) — it NEVER returns sanitized content and NEVER redacts. The
 * typed error carries only `path` + a fixed redaction-safe `kind`, never the
 * matched value. Wired as `KnowledgeWriterDeps.secretScan` (writer.ts step 6);
 * never throws across the boundary (§16).
 */
export const scanForSecrets: SecretScan = (
  ctx: SecretScanContext,
): Result<void, SecretFound> => {
  if (contentContainsSecret(ctx.content)) {
    return err({ code: "secret_found", path: ctx.path, kind: SECRET_SCAN_KIND });
  }
  return ok(undefined);
};

/**
 * Clock-free, redaction-safe `AuditSignal` for a secret-scan rejection — the
 * seam the writer's reject path stamps into an `AuditRecord` (§16) and from
 * which it opens a distinct `SECRET_SCAN_FAILURE_CLASS` System Health item.
 * Carries only the path ref + fixed kind; the matched secret is never
 * referenced. If the PATH itself looks credential-shaped it is elided, so the
 * signal is guaranteed log-safe (`isRedactionSafe` holds by construction).
 */
export function buildSecretScanRejectionAudit(found: SecretFound): AuditSignal {
  const pathRef = contentContainsSecret(found.path)
    ? "path:<elided>"
    : `path:${found.path}`;
  return buildAuditSignal({
    actor: "KnowledgeWriter",
    event: SECRET_SCAN_REJECTED_EVENT,
    refs: [pathRef, `kind:${found.kind ?? SECRET_SCAN_KIND}`],
    payloadHash: PROBE_HASH,
    beforeSummary: "pre-commit scan",
    afterSummary: "commit rejected",
  });
}
