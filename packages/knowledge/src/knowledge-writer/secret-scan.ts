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
// Detection REUSES the @sow/policy redaction predicate (`isRedactionSafe`) —
// the SAME credential-prefix + URL-userinfo + sensitive-keyword patterns that
// keep audit signals log-safe. Single source of truth ⇒ no pattern drift: a
// string is unsafe to commit iff it would be unsafe as an audit field. The
// matched value is NEVER carried in the typed error or the rejection audit
// (§16 redaction): the error holds only `path` + a fixed, keyword-free `kind`.
import { ok, err } from "@sow/contracts";
import type { Result, FailureClass } from "@sow/contracts";
import { buildAuditSignal, isRedactionSafe, type AuditSignal } from "@sow/policy";
import type { SecretScan, SecretScanContext, SecretFound } from "./writer";

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
 * True iff `value` carries a credential-shaped token (provider/cloud key
 * prefix, PEM block, JWT, URL userinfo credential, or a sensitive keyword).
 * Pure; reuses the @sow/policy redaction patterns via `isRedactionSafe`.
 */
export function contentContainsSecret(value: string): boolean {
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
