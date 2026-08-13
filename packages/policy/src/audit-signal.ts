// §5 audit signal — the CLOCK-FREE precursor to a contracts AuditRecord.
//
// `packages/policy` is PURE (no clock), but an AuditRecord carries
// `timestamps.occurredAt`, a clock value. So policy emits an `AuditSignal`
// (everything an AuditRecord needs EXCEPT the timestamp) and the impure caller
// stamps `occurredAt` via `toAuditRecordInput`. REDACTION-SAFE by construction:
// a signal carries refs / hashes / codes ONLY — never raw content, prompts,
// credentials, or tokens (CLAUDE.md safety rule 7 + §16).
import type { AuditRecord } from "@sow/contracts";
import type { DenialReason } from "./denials";

// ARCH_GAP: the frozen `FailureClass` enum (packages/contracts shared-enums) has
// NO 'policy_denial' member. A policy DENY is USUALLY correct fail-closed
// behavior, not an operational health fault — so we do NOT invent a new enum
// member and `healthSignalClass` stays OPTIONAL, set only where the spec
// requires operational visibility (egress status REQ-S-002, admission
// rejection). This named constant abstracts that health class without touching
// the frozen enum. Reported in the task manifest flags.
export const POLICY_DENIAL_HEALTH_CLASS = "policy_denial" as const;

/**
 * Clock-free data needed to build an AuditRecord. `denialCode` + `healthSignalClass`
 * are policy-internal signal fields (dropped at the AuditRecord boundary — the
 * frozen AuditRecordSchema is `.strict()` and names neither).
 */
export interface AuditSignal {
  readonly actor: string;
  readonly event: string;
  readonly refs: readonly string[];
  readonly payloadHash: string;
  readonly beforeSummary: string;
  readonly afterSummary: string;
  /** Present on DENY signals; the closed §5 denial code. */
  readonly denialCode?: DenialReason;
  /** Set only where operational visibility is required (see ARCH_GAP above). */
  readonly healthSignalClass?: string;
}

/** Input to `buildAuditSignal` — structurally the signal itself. */
export interface BuildAuditSignalInput {
  readonly actor: string;
  readonly event: string;
  readonly refs: readonly string[];
  readonly payloadHash: string;
  readonly beforeSummary: string;
  readonly afterSummary: string;
  readonly denialCode?: DenialReason;
  readonly healthSignalClass?: string;
}

/**
 * Build a clock-free AuditSignal. Returns a fresh, normalized object (refs
 * copied) so the caller cannot mutate policy-internal state. Pure.
 */
export function buildAuditSignal(input: BuildAuditSignalInput): AuditSignal {
  const signal: AuditSignal = {
    actor: input.actor,
    event: input.event,
    refs: [...input.refs],
    payloadHash: input.payloadHash,
    beforeSummary: input.beforeSummary,
    afterSummary: input.afterSummary,
    ...(input.denialCode !== undefined ? { denialCode: input.denialCode } : {}),
    ...(input.healthSignalClass !== undefined
      ? { healthSignalClass: input.healthSignalClass }
      : {}),
  };
  return signal;
}

// --- redaction safety -------------------------------------------------------

// Credential-shaped prefixes (provider API keys, cloud creds, PEM blocks). A
// content hash such as "sha256:deadbeef" does NOT match any of these.
const CREDENTIAL_PREFIX =
  /(sk-[a-z0-9]|sk_(live|test)|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/;

// Sensitive keywords that indicate a raw-content / secret leak. Deliberately
// omits "token" so a structured code (e.g. AUTH_TOKEN_INVALID) — which is never
// scanned anyway (codes are excluded) — cannot cause a false positive.
const SENSITIVE_KEYWORD =
  /\b(pass(word|wd)|secret|api[_-]?key|bearer|credential|private[_ -]?key|passphrase)\b/i;

// A URL userinfo credential (`scheme://user:pass@host` or `//user:pass@host`).
// Catches an endpoint whose basic-auth secret is an arbitrary token that would
// otherwise slip past the keyword/prefix checks — so a raw endpoint ref carrying
// `user:pass@` is flagged even though the modules now emit host-only refs.
const URL_USERINFO_CREDENTIAL = /\/\/[^/\s:@]+:[^/\s@]+@/;

function looksUnsafe(s: string): boolean {
  return (
    CREDENTIAL_PREFIX.test(s) ||
    SENSITIVE_KEYWORD.test(s) ||
    URL_USERINFO_CREDENTIAL.test(s)
  );
}

// ⭐ THE PRODUCER ENUMERATION FOR `isRedactionSafe` — RE-DERIVED 2026-08-13 (task 24.45),
// reported with its method because a count without one is unfalsifiable (`L61`/`L118`).
// ⛔ RE-RUN IT RATHER THAN TRUSTING THE NUMBERS; that is the entire point of this block —
// the claim it replaces was wrong precisely because it was inherited, never re-measured:
//
//   find packages apps -name "*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*" \
//     -not -path "*/test/*" -print0 | xargs -0 awk '/buildAuditSignal\(/ {print FILENAME}'
//
// 43 matches ⇒ 41 PRODUCTION call sites across 16 files (less this file's own definition
// and one eval-suite test). By package: policy 24 · providers/src/broker 13 · knowledge 2
// · worker 2. The seven families the retracted claim enumerated covered only the broker 13
// plus provider-runner — every one of policy's 24 sites, i.e. the package that comment was
// written in, was omitted.
/**
 * True iff no scanned field matches one of the three patterns above. `denialCode` +
 * `healthSignalClass` are closed codes/class constants and are NOT scanned. Pure.
 *
 * ⛔ WHAT THIS IS, STATED PRECISELY BECAUSE THE PREVIOUS CLAIM WAS FALSE (task 24.45):
 * this is a **credential-shape HEURISTIC, not a shape allowlist.** It answers *"does
 * this look like a leaked secret?"* — NOT *"is this a permitted ref shape?"* **Anything
 * that matches none of the three patterns passes**, including a sensitive-but-not-
 * credential-shaped value such as an employer project codename, a person's name, or an
 * internal identifier. ⇒ **it cannot substitute for validating a value at its producer**,
 * and a producer that interpolates untrusted input into `refs` is not made safe by it.
 *
 * ⛔ IT REPLACES A FALSE CLAIM — RETRACTED IN FULL (`L82`), and this is the SINGLE
 * canonical statement of that retraction; it is deliberately not restated elsewhere in
 * this file, because three copies is three things to drift. A prior comment asserted
 * *"redaction-safety holds structurally at every construction site… there is no
 * representable violation."* `24.45` found one: `visibility.ts`'s
 * `validateProjectionVisibility` embedded the candidate's own unvalidated `workspaceId`
 * into `refs` **before** the branch that rejects it for being foreign. Its enumeration of
 * seven producer families reached **14 of 41** production sites and **omitted every one of
 * `packages/policy`'s 24 — the package the claim was written in.** ⭐ Confirms
 * **`contracts L5`** (redaction cannot rest on a length/shape heuristic; classify by the
 * field's known TYPE) — which names an employer codename as exactly this defeating case.
 * **Method + current counts: the `//` block directly above** (kept in `//` form because
 * the `find` globs contain the block-comment terminator — **a method you cannot paste
 * into a shell is not a method**, `L61`/`L118`).
 *
 * ⛔ BOUNDARY OF THAT SEARCH, so this claim cannot decay the same way (`L100` — a negative
 * inherits its search's boundaries): the command finds only producers that **(a)** go
 * THROUGH `buildAuditSignal` and **(b)** call it by that literal name. **Producers that
 * construct a record directly never reach this gate at all** — e.g.
 * `apps/worker/src/composition/dispositionDurable.ts` calls `deps.audit.append({refs: […]})`
 * with an interpolated `workspaceId`; an aliased or indirect call (`const b =
 * buildAuditSignal`) would likewise be invisible. **Outside what any change here can
 * reach**, and tracked separately rather than implied to be covered.
 *
 * ⚠ THE FALSE INVARIANT HAD THREE HOMES, and fixing it where it is *documented* while
 * leaving it where it is *operative* is the failure mode worth naming. Status as of
 * `993f28e8` (re-read, not remembered):
 *  1. **here** — retracted, above.
 *  2. `packages/knowledge/src/knowledge-writer/secret-scan.ts` — *consumes* the heuristic
 *     (see the warning below). **Filed, not fixed** — knowledge territory.
 *  3. `packages/knowledge/test/gcl-projection.test.ts` — cited this claim as the stated
 *     reason its suite pinned a hand-built signal rather than the real chain, so the false
 *     claim was **suppressing a test**. ⭐ **Also retracted, at `993f28e8`** (24.45's
 *     knowledge leg); that suite now drives the real chain.
 * ⭐ **Recorded because a coverage claim that justifies NOT writing a test fails silently
 * and permanently, where a doc comment only misleads a reader** — which is why home 3 was
 * the load-bearing one, not this file.
 *
 * ⚠ EXTERNAL CONSUMER — DO NOT TIGHTEN THIS INTO AN ALLOWLIST WITHOUT READING IT FIRST:
 * `packages/knowledge/src/knowledge-writer/secret-scan.ts` implements
 * `contentContainsSecret(value)` as `!isRedactionSafe(probe)` over arbitrary content, and
 * wires it as the KnowledgeWriter's **blocking pre-commit secret scan**. An allowlist here
 * would make that predicate true for essentially all content ⇒ **every KnowledgeWriter
 * commit rejected, on the sole-writer path.** The inversion is the reason `24.45` fixed
 * the producer instead of this heuristic.
 */
export function isRedactionSafe(signal: AuditSignal): boolean {
  const scanned: readonly string[] = [
    signal.actor,
    signal.event,
    signal.payloadHash,
    signal.beforeSummary,
    signal.afterSummary,
    ...signal.refs,
  ];
  for (const field of scanned) {
    if (looksUnsafe(field)) return false;
  }
  return true;
}

/**
 * Local invariant guard: throw if the signal is not redaction-safe. Intra-module
 * assertion only (not a cross-subsystem boundary) — callers that need a typed
 * outcome use `isRedactionSafe`.
 *
 * ⚠ DELIBERATELY ZERO PRODUCTION CALLERS — do NOT "helpfully" wire this into a call
 * site. **Re-measured 2026-08-13 (task 24.45) rather than re-read**: the only
 * references repo-wide are this definition and `test/audit-signal.test.ts`.
 *
 * ⛔ THE COVERAGE CLAIM THAT USED TO SIT HERE IS RETRACTED, NOT RELOCATED. It read
 * *"redaction-safety holds structurally at every construction site… there is no
 * representable violation for this assert to catch today,"* resting on an enumeration
 * of seven `providers/src/broker/*` families. **`24.45` found a representable
 * violation** (`visibility.ts` embedding an unvalidated `workspaceId` in `refs`) and
 * established that the enumeration omitted 27 of 41 production sites — including all
 * 24 in this package. **The re-derived enumeration, its method, and its boundary now
 * live on {@link isRedactionSafe}**, which is the function production code actually
 * calls; this assert carries no coverage claim of its own.
 *
 * Separately: the broker/egress-veto `AuditSignal`→`AuditRecord` persistence
 * path does not exist yet in production (`toAuditRecordInput` has zero
 * callers; `guardCopilotEgress` discards `decision.audit`; `BrokerOutcome.audits`
 * has no worker consumer) — producer-first, consumer pending, same shape as
 * #26/9.32. If that consumer is ever wired, 9.33's house rule applies: a safety
 * gate must DENY, not throw — so the correct call there is `isRedactionSafe`
 * + fail-closed deny, still not this assert.
 */
export function assertRedactionSafe(signal: AuditSignal): void {
  if (!isRedactionSafe(signal)) {
    throw new Error(
      "AuditSignal failed redaction check: a field is credential-shaped or carries raw content",
    );
  }
}

/**
 * Stamp a clock-free signal into an AuditRecord-shaped object the impure caller
 * can persist. `occurredAt` is supplied by the caller (policy has no clock).
 * The policy-internal `denialCode` / `healthSignalClass` fields are dropped —
 * the frozen `AuditRecordSchema` is `.strict()` and names neither.
 */
export function toAuditRecordInput(
  signal: AuditSignal,
  occurredAt: string,
): AuditRecord {
  return {
    actor: signal.actor,
    event: signal.event,
    refs: [...signal.refs],
    payloadHash: signal.payloadHash,
    beforeSummary: signal.beforeSummary,
    afterSummary: signal.afterSummary,
    timestamps: { occurredAt },
  };
}
