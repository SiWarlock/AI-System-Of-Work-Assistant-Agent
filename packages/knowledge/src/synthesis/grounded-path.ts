// The GROUNDED-PATH SHAPE INVARIANT (§6 KN-10/KN-12; safety rule 1; 13.8k) —
//
//     every path entering THE GROUNDED SET is shape-validated, WHOEVER produced it.
//
// ⚠ SCOPE, stated precisely because this predicate is barrel-exported and the unqualified sentence
// would over-promise: the grounded set is a MEETING-path construct (`rewriteVaultForMeeting`). The
// SOURCE-ingestion path has no grounded set at all — `planSynthesis` output flows into the KMP and
// `touchedNotePaths` without one, so a model-proposed `patches:[{path:"index.md"}]` there is stopped
// only by the worker adapter's realpath containment, which prevents ESCAPE but not COLLISION with a
// writer-owned surface. That is a known, separately-tracked gap (Step-9 Finding), NOT something this
// module already covers. Applying `admitGroundedPath` to the source path's plan targets is the fix,
// and it belongs to 13.8d rather than here.
//
// Stated as an invariant rather than as a guard at one call site, deliberately: a location-scoped
// fix ("validate candidate rows in the resolver") is satisfied while a different producer still
// routes an unvalidated path into the grounded set. Three routes to this one invariant are known:
//
//   1. STUB MINTING          — closed by 13.8j (namespaced by construction).
//   2. RESOLVED CANDIDATE    — `resolveEntity` returns `candidate.path` VERBATIM from an untrusted
//                              GBrain row, shape-guarded only as a non-empty string. A poisoned row
//                              carrying `path: "index.md"` plus a faithfully-matching title resolves
//                              there, and the model may then patch the navigation catalog.
//   3. CALLER-SUPPLIED SEED  — `MeetingRewriteInput.meetingNotePath` seeds the grounded set directly.
//
// This module is the one place that decides. Every producer routes through `admitGroundedPath`, and
// a structural pin fails if a second, unguarded entry point appears.
//
// TWO NON-NEGOTIABLES:
//  · ADMITTED PATHS ARE RETURNED BYTE-IDENTICAL. Grounding matches on exact strings, so normalizing
//    or prefixing here would silently break every match while looking like a successful guard.
//  · REFUSAL WITHHOLDS, NEVER SANITIZES. Repairing a path invents a target the row never claimed
//    (REQ-F-017 no-inference), and it destroys the signal that a producer misbehaved.
//
// The owned-surface set is DERIVED from `markdown-vault/structural-files.ts`, never re-listed — a
// hand-copied list is the denylist-drift failure (L64/L65); add a surface there and this inherits it.
import {
  STRUCTURAL_INDEX_PATH,
  STRUCTURAL_LOG_POINTER_PATH,
  STRUCTURAL_LOGS_DIR,
} from "../markdown-vault/structural-files";

/** Why a path was refused. CODE-ONLY (rule 7) — GBrain/attendee-derived paths are untrusted content. */
export type GroundedPathRefusal =
  /** The path targets a KnowledgeWriter-owned KN-12 surface. The security-relevant refusal. */
  | "structural_surface"
  /** The path is not a well-formed relative vault note path. */
  | "unsafe_shape";

export type GroundedPathVerdict =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: GroundedPathRefusal };

/**
 * Written as ESCAPES, not literal bytes: a formatter, an editor's "strip control characters" pass, or
 * a copy-paste through any UI would silently delete raw bytes from the class and degrade the guard
 * with no test failure (the fixtures would be stripped in the same pass). */
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

const refuse = (reason: GroundedPathRefusal): GroundedPathVerdict => ({ ok: false, reason });

/**
 * A KnowledgeWriter-owned structural surface. Compared CASE-INSENSITIVELY: the vault is Mac-first,
 * so `Index.md` and `index.md` are the same file on a case-insensitive volume — a case-only variant
 * must not slip past the check and then collide on disk.
 */
function isStructuralSurface(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower === STRUCTURAL_INDEX_PATH.toLowerCase()) return true;
  if (lower === STRUCTURAL_LOG_POINTER_PATH.toLowerCase()) return true;
  return lower.startsWith(`${STRUCTURAL_LOGS_DIR.toLowerCase()}/`); // the whole day-log subtree
}

/**
 * Decide whether a path may enter the grounded set. Returns the path BYTE-IDENTICAL on admission, or
 * a code-only refusal reason. Pure; never throws.
 *
 * `.md`-only is deliberate and evidenced: every path that can enter the set is a vault NOTE — a
 * resolver candidate row, a `<namespace>/<slug>.md` stub (13.8j), or a `meetings/….md` subject. No
 * directory, attachment, or extensionless target exists on this path, so the narrow rule is correct
 * rather than merely convenient.
 */
export function admitGroundedPath(path: unknown): GroundedPathVerdict {
  if (typeof path !== "string") return refuse("unsafe_shape");
  // No trimming: a path with surrounding whitespace is not "nearly valid", it is malformed. Trimming
  // it would be a sanitize, and admitting it would break the byte-identity contract.
  // A real vault path is far short of PATH_MAX; an oversized one is junk or an attack, and bounding
  // it keeps the split + lowercase work below proportional to a sane input (`MAX_ENTITY_REFS` bounds
  // how MANY candidates are seen, not how big each one is).
  if (path.length === 0 || path.length > 1024 || path.trim() !== path) return refuse("unsafe_shape");
  if (CONTROL_OR_BACKSLASH.test(path)) return refuse("unsafe_shape");
  if (path.startsWith("/")) return refuse("unsafe_shape"); // absolute
  if (/^[A-Za-z]:/.test(path)) return refuse("unsafe_shape"); // drive-letter absolute
  const segments = path.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) return refuse("unsafe_shape");
  if (!path.toLowerCase().endsWith(".md")) return refuse("unsafe_shape");
  if (isStructuralSurface(path)) return refuse("structural_surface");
  return { ok: true, path };
}
