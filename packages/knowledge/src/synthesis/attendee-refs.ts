// Attendee → person-entity refs (§9 workflow-1 L297; §6 KN-11; §5 WS-8; REQ-F-017; 13.8g-A) — the
// missing PRODUCER of the person refs 13.8f-A already grounds and fans out. Meeting attendees exist
// today only as free-text strings rendered into the meeting note body; §9 W1 specifies them in the
// correlate step AND `person` as a KnowledgeWriter target. This module closes that gap.
//
// It does NOT resolve. Grounding, matching and stub decisions belong to the 13.8a EntityResolver over
// its own workspace scope; this is pure normalization of untrusted free text into `EntityRef`s.
//
// ── THE THREE RULES (all fail toward NO ENTITY) ────────────────────────────────────────────────────
//
// 1. A NAME IS EVIDENCE, NEVER SYNTHESIS (REQ-F-017). A display name is taken only from the string
//    that carries it — `"Jane Doe" <jane@acme.com>` ⇒ `Jane Doe`. A bare address's local-part is an
//    IDENTIFIER, not a claimed name: `jane.doe@acme.com` must never become "Jane Doe". Address-only
//    attendees are emitted VERBATIM into `identifierOnlyRefs` (below), never title-cased.
//
// 2. IDENTIFIER-ONLY REFS MAY RESOLVE BUT MUST NEVER MINT A NOTE (Q1 = b′). A bare address is
//    evidence of a PERSON but not of a NAME. Passed verbatim it can still match an existing person
//    note by alias — the case that matters. But if it matches nothing, minting a stub would create a
//    machine-named page (`jane-acme-com.md`) that duplicates the real `jane-doe.md` for the same
//    human — corroding the KN-11 entity convergence this chain exists to provide, and leaving a
//    human-only cleanup. So they ride a SEPARATE output bucket that the planner grounds
//    resolve-only. (`resolveEntity` returns `create_stub` — not `withheld` — on a no-match, so
//    suppression has to be explicit here; it does not come for free.)
//
// 3. A ROOM IS NOT A PERSON — and the bias is toward EXCLUDING. Conference rooms, calendar
//    resources, distribution lists and group aliases are excluded STRUCTURALLY (never by model
//    judgement): a group/resource-shaped local part, a calendar-resource domain, or a
//    resource-shaped display name. A missed attendee costs a re-run; a conference-room person note
//    is vault corruption a human has to clean up. The cost of this bias is real — a person whose
//    display name contains "Team"/"Room" as a whole word is excluded — and it is accepted.
//
// PURE; TOTAL never-throws (per ELEMENT — one hostile entry never costs the rest of the list);
// bounded by the shared `MAX_ENTITY_REFS`; DORMANT (the worker threads real strings in as 13.8g-B).
import { faithfulKey } from "./match-keys";
import type { EntityRef } from "./entity-resolver";
import { MAX_ENTITY_REFS } from "./meeting-rewrite";

/** Why an attendee string produced no ref. CODE-ONLY (rule 7): an attendee string is untrusted
 *  imported content and may carry PII or employer-work content — it is NEVER echoed into a record. */
export type AttendeeWithheldReason =
  | "not_a_string"
  | "empty"
  | "too_long"
  | "no_evidence"
  | "non_person"
  | "over_cap";

export interface WithheldAttendee {
  readonly reason: AttendeeWithheldReason;
}

export interface AttendeeNormalization {
  /** Named people — safe to ground AND to create-stub (a real name makes a legible note). */
  readonly refs: readonly EntityRef[];
  /** Address-only people — ground if they RESOLVE, but never mint a note (rule 2). */
  readonly identifierOnlyRefs: readonly EntityRef[];
  /** Code-only withholding reasons, in input order. */
  readonly withheld: readonly WithheldAttendee[];
}

/**
 * A whole attendee string longer than this is not a name or an address — it is junk or an attack.
 * LOad-BEARING for cost: `ADDRESS` is quadratic by construction (its class includes `.`, so it
 * re-scans per dot), and this cap is what keeps a single parse sub-millisecond. Do not raise it
 * without re-measuring.
 */
const MAX_ATTENDEE_LENGTH = 512;
/**
 * How many raw entries are examined at all. The ref cap bounds ACCEPTED refs; withheld/deduped
 * entries never advance it, so without this a hostile list of near-cap strings costs unbounded
 * parse time (measured: 50k entries ≈ 3.7s) while emitting one ref. Bounds work, not just output.
 */
const MAX_ATTENDEE_ENTRIES = 2000;

/** `Display Name <addr@host>` — the RFC-5322-ish form calendar/meeting sources emit. */
const ANGLE_FORM = /^(.*?)<([^<>]*)>\s*$/;
/** A conservative address shape: exactly one `@`, a dotted domain, no delimiters. */
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
/**
 * A display name may never contain `@`, `<` or `>`. Such a string is an IDENTIFIER or a joined
 * multi-attendee list, not a human's name — and treating it as one is the worst failure this module
 * has: it mints a machine-named note (`jane-doe-acme-com.md`, `a-x-com-b-y-com.md`), which is rule 1
 * and rule 2 bypassed at once. Real-world sources produce these routinely: an ICS `CN` equal to the
 * address (`jane@acme.com <jane@acme.com>`), and comma-joined attendee lists.
 */
const NOT_A_NAME = /[@<>]/;

/** Group / distribution-list / automation local parts — never an individual. */
const GROUP_LOCALS = new Set([
  "all", "everyone", "team", "teams", "staff", "group", "list", "info", "contact", "hello", "help",
  "support", "sales", "marketing", "hr", "it", "admin", "administrator", "noreply", "no-reply",
  "donotreply", "do-not-reply", "notifications", "announce", "announcements", "office", "reception",
]);
/**
 * Resource-shaped local-part prefixes (`room-3@`, `conf-room-2@`, `meeting-b@`). `rm` is deliberately
 * NOT here — `rm.patel@` is a person's initials, and no calendar emits `rm-` for a room.
 */
const RESOURCE_LOCAL_PREFIX = /^(?:room|rooms|conf|conference|meeting|resource|desk|projector|zoom)[-._]/i;
/**
 * Group-shaped local-part segments (`eng-team@`, `all@`, `x-list@`). `hands` is deliberately NOT here
 * — it is a real surname, and `all-hands@` is already caught by the `all` segment.
 */
const GROUP_LOCAL_SEGMENT = /(?:^|[-._])(?:team|teams|group|list|all|everyone|dl)(?:$|[-._])/i;
/** Calendar-resource domains (Google Workspace rooms and equivalents). */
const RESOURCE_DOMAIN = /(?:^|\.)resource\.calendar\.google\.com$|(?:^|\.)resource\./i;
/**
 * Resource-shaped DISPLAY names. Whole-word matched so ordinary names survive ("Roomi Patel" is a
 * person). Accepted cost of the exclusion bias: a person whose display name contains one of these as
 * a whole word is excluded.
 */
const NON_PERSON_DISPLAY =
  /\b(?:room|rooms|boardroom|conference|meeting|projector|resource|distribution\s?list|mailing\s?list|team|group|everyone|all\s?hands|zoom|webex|hangout|bridge|huddle|calendar)\b/i;

interface ParsedAttendee {
  readonly displayName?: string;
  readonly address?: string;
}

/** Split an attendee string into its evidence: a display name and/or an address. Pure; never throws. */
function parseAttendee(raw: string): ParsedAttendee | null {
  const s = raw.trim();
  if (s === "") return null;

  const angle = ANGLE_FORM.exec(s);
  if (angle) {
    const rawDisplay = angle[1]!.trim().replace(/^["']|["']$/g, "").trim();
    const address = angle[2]!.trim();
    const validAddress = ADDRESS.test(address) ? address : undefined;
    // A display part carrying `@`/`<`/`>` is an identifier or a joined attendee list, NOT a name —
    // discard it and fall back to the address (⇒ identifier-only), never emit it as a person's name.
    const display = rawDisplay !== "" && !NOT_A_NAME.test(rawDisplay) ? rawDisplay : "";
    if (display === "" && validAddress === undefined) return null;
    return { ...(display !== "" ? { displayName: display } : {}), ...(validAddress ? { address: validAddress } : {}) };
  }

  if (ADDRESS.test(s)) return { address: s };
  // A plain string with no address: usable as a name only if it carries a letter or digit AND is not
  // identifier/list-shaped. `a@x.com, b@y.com` and `jane@localhost` fail here — dropped, never named.
  if (NOT_A_NAME.test(s)) return null;
  if (!/[\p{L}\p{N}]/u.test(s)) return null;
  return { displayName: s };
}

/**
 * Structural non-person test on an ADDRESS (rule 3) — group/resource shapes, never model judgement.
 * Runs on any `@`-bearing string, including one that failed the strict `ADDRESS` shape (an internal
 * `all-hands@acme` with no dotted TLD must still be recognized as a distribution list).
 */
function addressIsNonPerson(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  const local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();
  if (RESOURCE_DOMAIN.test(domain)) return true;
  // `+tag` suffixes must not smuggle a group alias past the exact-match set (`noreply+bounce@`).
  const untagged = local.split("+")[0]!;
  if (GROUP_LOCALS.has(local) || GROUP_LOCALS.has(untagged)) return true;
  if (RESOURCE_LOCAL_PREFIX.test(local)) return true;
  return GROUP_LOCAL_SEGMENT.test(local);
}

interface Accumulated {
  readonly ref: EntityRef;
  readonly identifierOnly: boolean;
}

/**
 * Normalize a meeting's raw attendee strings into person `EntityRef`s for `MeetingRewriteInput`:
 * `refs` → `entityRefs`, `identifierOnlyRefs` → `identifierOnlyRefs`. PURE; TOTAL never-throws.
 */
export function normalizeAttendees(raw: unknown): AttendeeNormalization {
  const empty: AttendeeNormalization = { refs: [], identifierOnlyRefs: [], withheld: [] };
  if (!Array.isArray(raw)) return empty;

  const withheld: WithheldAttendee[] = [];
  // Dedupe (rule: STRING EVIDENCE only). Identity is keyed on the address when present — the one
  // axis the string actually proves — else on the faithful key of the name. Two DIFFERENT addresses
  // are never merged even under an identical display name: that call belongs to the resolver.
  const byKey = new Map<string, Accumulated>();
  // `withheld` is an audit surface, not a channel — bound it so a hostile list can't balloon it.
  const withhold = (reason: AttendeeWithheldReason): void => {
    if (withheld.length < MAX_ENTITY_REFS) withheld.push({ reason });
  };

  try {
    // Bound the WORK, not just the output (the whole loop is inside one try — a hostile iterable or
    // a throwing index getter must not escape the total-function contract).
    for (const entry of raw.slice(0, MAX_ATTENDEE_ENTRIES)) {
      if (byKey.size >= MAX_ENTITY_REFS) {
        withhold("over_cap");
        break; // the ref budget is spent; nothing later can be accepted
      }
      if (typeof entry !== "string") {
        withhold("not_a_string");
        continue;
      }
      const trimmed = entry.trim();
      if (trimmed === "") {
        withhold("empty");
        continue;
      }
      if (trimmed.length > MAX_ATTENDEE_LENGTH) {
        withhold("too_long");
        continue;
      }
      // Structural exclusion runs on the RAW string FIRST: an `@`-bearing entry that fails the
      // strict ADDRESS shape (an internal `all-hands@acme`) must be classified as a group, not fall
      // through as "no evidence" — same outcome, but the audit reason has to be truthful.
      if (trimmed.includes("@") && addressIsNonPerson(trimmed)) {
        withhold("non_person");
        continue;
      }
      const parsed = parseAttendee(trimmed);
      if (parsed === null) {
        withhold("no_evidence");
        continue;
      }

      // Rule 3, in two tiers. An address that is structurally a room/list is excluded OUTRIGHT.
      // A merely non-person-looking DISPLAY name over a person-shaped address DEGRADES to
      // identifier-only rather than dropping: "Jane Doe (Platform Team)" is the norm in Teams/Zoom/
      // Granola exports, and dropping it loses a real attendee. Identifier-only can never mint a
      // note (rule 2), so the degrade is safe by construction while still recovering her by alias.
      const addressNonPerson = parsed.address !== undefined && addressIsNonPerson(parsed.address);
      // Also test the raw string: an `@`-bearing entry that failed the strict ADDRESS shape (an
      // internal `all-hands@acme`) still gets its local part inspected rather than slipping through.
      const rawNonPerson = trimmed.includes("@") && addressIsNonPerson(trimmed);
      if (addressNonPerson || rawNonPerson) {
        withhold("non_person");
        continue;
      }
      const displayNonPerson = parsed.displayName !== undefined && NON_PERSON_DISPLAY.test(parsed.displayName);
      if (displayNonPerson && parsed.address === undefined) {
        withhold("non_person"); // no address to fall back to ⇒ nothing usable survives
        continue;
      }

      const degraded = displayNonPerson; // keep the person, drop the (suspect) name
      const identifierOnly = parsed.displayName === undefined || degraded;
      const name = identifierOnly ? parsed.address! : parsed.displayName!;
      const key = parsed.address !== undefined ? `addr:${parsed.address.toLowerCase()}` : `name:${faithfulKey(name)}`;
      const candidate: Accumulated = { ref: { name, kind: "person" }, identifierOnly };

      const existing = byKey.get(key);
      // Same address seen twice: the form carrying a display NAME wins — strictly more evidence,
      // not a guess. Otherwise first occurrence stands.
      if (existing === undefined || (existing.identifierOnly && !identifierOnly)) byKey.set(key, candidate);
    }
  } catch {
    // fail safe: return whatever was accumulated before the hostile element (never throw)
  }

  const all = [...byKey.values()];
  return {
    refs: all.filter((a) => !a.identifierOnly).map((a) => a.ref),
    identifierOnlyRefs: all.filter((a) => a.identifierOnly).map((a) => a.ref),
    withheld,
  };
}
