// §5 audit signal — the CLOCK-FREE precursor to a contracts AuditRecord.
//
// `packages/policy` is PURE (no clock), but an AuditRecord carries
// `timestamps.occurredAt`, a clock value. So policy emits an `AuditSignal`
// (everything an AuditRecord needs EXCEPT the timestamp) and the impure caller
// stamps `occurredAt` via `toAuditRecordInput`. REDACTION-SAFE by construction:
// a signal carries refs / hashes / codes ONLY — never raw content, prompts,
// credentials, or tokens (CLAUDE.md safety rule 7 + §16).
import type { AuditRecord } from "@sow/contracts";
import { looksUnsafe as domainLooksUnsafe } from "@sow/domain";
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
//
// task 24.110 — the `/i` IS LOAD-BEARING AND WAS MISSING. This alternation is
// character-identical to `@sow/domain`'s `CREDENTIAL_PREFIX` and had drifted from it by
// exactly this one flag, so a case-transformed credential shape (`SK-ANT-...`,
// `-----Begin Certificate-----`, a lowercased `AKIA...`) was judged SAFE here while
// domain judged it unsafe. That mattered because this predicate is not only an audit
// gate — see the EXTERNAL CONSUMER note on {@link isRedactionSafe}, which is this file's
// single statement of that reach and is deliberately not restated here.
//
// ⚠ THE COST, NAMED — this widening cuts BOTH ways and the block below argued only one.
// `sk-[a-z0-9]` has no word boundary, so `/i` also newly refuses benign prose: `TASK-1`,
// `RISK-001`, `Full-Disk-Access`. That class is pre-existing in the lowercase direction
// (`task-123` was already refused) and this change extends it to every casing — measured
// at 9 newly-rejected of 612 repo Markdown files, atop 236 already rejected. On the
// reject-not-redact sole-writer path that is an AVAILABILITY cost, not a leak. Shipped
// deliberately: parity with domain (which carries the identical unbounded alternative)
// is worth more than shaving it here, and a word boundary is a domain-parity question.
// Pinned by `known_false_positives_are_pinned_so_the_class_is_not_INVISIBLE`.
//
// WHY THIS IS STILL A LOCAL COPY, AND WHY DELEGATING IS NOT THE OBVIOUS CLEANUP:
// `@sow/domain` exports these patterns and its own `looksUnsafe`, and consuming them
// wholesale would remove this copy entirely. That remains DEFERRED — see (B) below,
// which is STILL BLOCKED. This module's nets stay declared here even after (C')
// landed, because (C') is additive (an OR with domain's verdict), never a replacement.
//
// ⛔ TWO SHAPES WERE ON THIS TABLE. THEY FAIL IN OPPOSITE DIRECTIONS, AND STATING ONLY
// THE OBVIOUS ONE LETS THE OTHER SHAPE OUT:
//   (B) WHOLESALE — this module ADOPTS domain's `looksUnsafe` in place of its own nets,
//       which applies `stripMarkers` before any net sees the value, so it STOPS refusing
//       already-redacted content (`[REDACTED:credential]` is refused here, judged SAFE
//       there). A LOOSENING on the reject-not-redact sole-writer path — see the EXTERNAL
//       CONSUMER note on {@link isRedactionSafe}. ⛔ STILL BLOCKED. Nothing in this commit
//       implements it, and (C') landing below does not relax this prohibition — they are
//       independent shapes with opposite costs, and only one shipped.
//   (C') UNION — `domain.looksUnsafe(s) || <these nets, un-stripped>`. ⛔ THE (B) REASON
//       DOES NOT APPLY HERE AND MUST NOT BE READ AS COVERING IT: the un-stripped arm
//       still fires, so `[REDACTED:credential]` STAYS refused. (C') moves the OTHER
//       direction — this module now INHERITS domain's refusals, so
//       `private[REDACTED:raw]key` is refused where it was admitted before, and a
//       KnowledgeWriter commit carrying already-redacted content is now REJECTED. An
//       AVAILABILITY cost on rule 1, ORDER-COUPLED with task 24.123 (out of this
//       module's scope), which is weighing REMOVING exactly those matches from domain.
//       ⭐ LANDED (task 24.110, this commit) — see `looksUnsafe` below.
//
// ⛔ WHAT WOULD UNBLOCK (B): still a ruling that PERMITS the change — not a ruling merely
// OCCURRING, and not a task being ticked. (C') landing supplies NO such ruling; it is a
// different, additive shape with a measured, recorded cost of its own, not a step toward
// (B). Checkable in place: `the_marker_axis_still_diverges_and_that_divergence_is_OWNED`
// in this package's suite asserts the marker verdict (STILL diverges — policy stricter,
// unaffected by (C')) and the spaceManufactured verdict (NOW closed by (C') — both
// modules refuse it). ⚠ That pin ALSO carries a control pair that reds for OTHER
// reasons — a deliberate 24.123 tripwire — so a red there does not by itself mean the
// marker axis moved further. Read that pin's own comment before repairing it.
//
// ⚠ MECHANISM CORROBORATION ONLY, NOT A SECOND BLOCKER: task 24.129 measured the same
// ordering independently, from `packages/domain`'s side. It blocks a DIFFERENT thing:
// promoting a net INTO domain.
//
// ⚠ THE REASON ORIGINALLY RECORDED HERE IS SPENT. It is RETAINED rather than deleted because
// it is the only PRODUCTION-SOURCE artifact naming this relationship (`L194`), and because
// striking a block does not tense-shift the sentences inside it (`L195`). It read: domain's
// `stripMarkers` substituted a SPACE, which the whitespace-excluding
// `URL_USERINFO_CREDENTIAL` character classes could not match, so a frozen marker inside a
// `//user:pass@host` span BROKE the span and the value stopped being refused
// (`//u:p[REDACTED:raw]q@h` was unsafe here, safe in domain).
// ⛔ THAT AXIS CLOSED on 2026-08-18 — task 24.120, commits `65524874` + `8b2b53ac` +
// `bf442753`. As of those commits the filler is a span-preserving `^` with the space retained
// as a second, fail-safe arm, and both modules refuse that value.
// ⇒ THE AXIS IS CLOSED; THE BLOCK IS NOT. A precondition that has been SATISFIED reads as an
// instruction to PROCEED.
//
// task 24.124 — the leading `sk-[a-z0-9]` alternative gained a `\b` word boundary,
// PRODUCER-FIRST alongside the identical fix in `@sow/domain`'s `CREDENTIAL_PREFIX`
// (same commit round — see that module's comment for the full measurement: 235
// lines of this repo's own Markdown corpus newly admitted end-to-end, a real but
// accepted AVAILABILITY-direction gain with a named LEAK-direction cost). Retires
// this file's `known_false_positives_are_pinned_so_the_class_is_not_INVISIBLE`
// pin DELIBERATELY — see that test, rewritten below to assert the new behaviour
// rather than silently going green.
const CREDENTIAL_PREFIX =
  /(\bsk-[a-z0-9]|sk_(live|test)|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/i;

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

// task 24.110 — (C') LANDED. `domainLooksUnsafe(s)` is the UN-STRIPPED union arm
// recorded above as the (C') candidate: `domain.looksUnsafe(s) || <this module's
// own nets, un-stripped>`. Measured effect (this module's test suite, task 24.110):
//   * it does NOT strip markers before testing — the (B)-WHOLESALE hazard (stop
//     refusing `[REDACTED:credential]`) does not apply, because this arm is added
//     to the disjunction, never substituted for the local nets;
//   * it DOES make this module inherit every refusal domain's own two arms
//     produce, including domain's legacy-space arm — so a value refused ONLY
//     because domain's `stripMarkers(s, " ")` manufactures a `private key` match
//     (e.g. `private[REDACTED:raw]key`) is now ALSO refused here, where it was
//     judged safe before. That is an AVAILABILITY cost on the reject-not-redact
//     KnowledgeWriter pre-commit path (rule 1 by reach), not a leak — see
//     `the_marker_axis_still_diverges_and_that_divergence_is_OWNED` in this
//     module's test suite for the measured before/after and the one direction
//     that does NOT close (this module's un-stripped nets still refuse an
//     already-redacted marker on its own keyword — domain, which strips first,
//     does not; (C') does not touch that direction because domain agreeing
//     "safe" cannot flip an OR whose other arm is already "unsafe").
//   * it does NOT moot the divergence — it closes exactly the ONE direction
//     (policy looser than domain) that was open, and leaves the other (policy
//     stricter than domain, on an already-redacted marker's own keyword) exactly
//     as it was. The pin above states this as a fact to re-derive, not a note to
//     trust.
function looksUnsafe(s: string): boolean {
  return (
    domainLooksUnsafe(s) ||
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
