// The GROUNDED-PATH SHAPE INVARIANT (§6 KN-10/KN-12; safety rule 1; 13.8k) —
//
//     every path entering a SYNTHESIS OUTPUT is shape-validated, WHOEVER produced it.
//
// Stated as an invariant rather than as a guard at one call site, deliberately: a location-scoped
// fix ("validate candidate rows in the resolver") is satisfied while a different producer still
// routes an unvalidated path into a synthesis output. FOUR routes to this one invariant are known,
// and all four are now closed:
//
//   1. STUB MINTING          — closed by 13.8j (namespaced by construction).
//   2. RESOLVED CANDIDATE    — `resolveEntity` returns `candidate.path` VERBATIM from an untrusted
//                              GBrain row, shape-guarded only as a non-empty string. A poisoned row
//                              carrying `path: "index.md"` plus a faithfully-matching title resolves
//                              there, and the model may then patch the navigation catalog.
//   3. CALLER-SUPPLIED SEED  — `MeetingRewriteInput.meetingNotePath` seeds the grounded set directly.
//   4. SOURCE-PATH PLAN TARGETS — `planSynthesis` output reached the KMP and `touchedNotePaths` with
//                              no grounded set at all, stopped only by the worker adapter's realpath
//                              containment, which prevents ESCAPE but not COLLISION with a
//                              writer-owned surface. Closed by 13.8l via `admitPlanMutations`.
//
// ⚠ What is deliberately NOT admitted: the writer's OWN KN-12 structural-parity mutations
// (`index.md` / `log.md` / `Logs/<date>.md` from the `STRUCTURAL_*` constants). Those are 13.8d's
// entire point. Admitting them would refuse the feature while still appearing to prevent collision —
// so callers admit the SEMANTIC (model-proposed) plans and merge structural parity in afterwards.
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
import { KnowledgeMutationPlanSchema } from "@sow/contracts";
import type {
  KnowledgeMutationPlan,
  NoteCreate,
  NotePatch,
  LinkMutation,
  FrontmatterPatch,
} from "@sow/contracts";
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
 * No `..`/`.`/empty path segment. `admitGroundedPath` applies this BEFORE any string-prefix/equality
 * check on the path (including `isStructuralSurface`) — a `startsWith`/`===` match on a RAW,
 * un-shape-checked path is not traversal-safe on its own: `"Logs/../employer-work-secret.md"`
 * string-STARTS-WITH `"logs/"` but RESOLVES (`path.resolve`) outside the `Logs/` subtree entirely, at
 * the vault root. EXPORTED (24.12 remedy leg, security-review finding) so a caller reusing
 * `isStructuralSurface` STANDALONE — outside `admitGroundedPath`'s own call order, which always runs
 * this check first — restores the SAME precondition instead of silently missing it.
 */
export function hasNoTraversalSegments(path: string): boolean {
  return path.split("/").every((s) => s !== ".." && s !== "." && s !== "");
}

/**
 * A KnowledgeWriter-owned structural surface. Compared CASE-INSENSITIVELY: the vault is Mac-first,
 * so `Index.md` and `index.md` are the same file on a case-insensitive volume — a case-only variant
 * must not slip past the check and then collide on disk.
 *
 * ⚠ NOT traversal-safe on its own — a `startsWith`/`===` string match, not a resolved-path check. Every
 * caller MUST pair this with {@link hasNoTraversalSegments} (`admitGroundedPath` always does, in order;
 * a bare call site is the exact bug 24.12's security review caught).
 *
 * EXPORTED (24.12 remedy leg): `knowledge-writer/workspace-path-guard.ts` reuses this SAME predicate
 * to exempt structural surfaces from the per-workspace path-prefix requirement (L39 — predicate lives
 * once; a second hand-derived "is this index.md/log.md/Logs/**" check would risk drifting from this
 * one, e.g. on the case-insensitivity handling).
 */
export function isStructuralSurface(path: string): boolean {
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
  if (!hasNoTraversalSegments(path)) return refuse("unsafe_shape");
  if (!path.toLowerCase().endsWith(".md")) return refuse("unsafe_shape");
  if (isStructuralSurface(path)) return refuse("structural_surface");
  return { ok: true, path };
}

/**
 * Filter a plan's four mutation arrays through {@link admitGroundedPath}, returning the surviving
 * mutations plus the code-only refusal reasons (13.8l/13.8m-A). Lives HERE, beside the predicate,
 * so the source and meeting paths share ONE implementation — the duplication that let 13.8j's defect
 * exist in two call sites is the thing this placement prevents.
 *
 * ⚠ Callers must apply this to MODEL-PROPOSED (semantic) plans ONLY. The writer's own KN-12
 * structural-parity mutations legitimately target `index.md`/`log.md`/`Logs/<date>.md`; running them
 * through this would refuse them and destroy structural parity while still appearing to "prevent
 * collision". Admit the semantic plans BEFORE the structural mutations are merged in.
 */
export function admitPlanMutations(plan: KnowledgeMutationPlan): {
  readonly creates: NoteCreate[];
  readonly patches: NotePatch[];
  readonly linkMutations: LinkMutation[];
  readonly frontmatterUpdates: FrontmatterPatch[];
  readonly refusals: GroundedPathRefusal[];
} {
  const refusals: GroundedPathRefusal[] = [];
  const keep = <T>(items: readonly T[], pathOf: (t: T) => unknown): T[] => {
    const out: T[] = [];
    if (!Array.isArray(items)) return out; // TOTAL: a mis-shaped plan yields no mutations, never a throw
    for (const item of items) {
      const verdict = admitGroundedPath(pathOf(item));
      if (verdict.ok) out.push(item);
      else refusals.push(verdict.reason);
    }
    return out;
  };
  return {
    creates: keep(plan.creates, (c) => c.path),
    patches: keep(plan.patches, (p) => p.path),
    linkMutations: keep(plan.linkMutations, (l) => l.srcPath),
    frontmatterUpdates: keep(plan.frontmatterUpdates, (f) => f.path),
    refusals,
  };
}

/**
 * Rebuild a plan from an admitted (filtered) mutation set, re-validating through the candidate-data
 * gate. The filter only ever REMOVES mutations, so every non-mutation field must survive verbatim —
 * including the three optionals. Dropping `expectedProjectId` here would strip a §13.10a verification
 * field from a plan that carried one; dropping `signedProvenanceStamp` would strip provenance. Both
 * synthesis paths share this so the two gates cannot drift (the duplication defect 13.8j was about).
 *
 * Returns `null` when nothing survived or the rebuilt plan fails the schema gate (fail-safe drop).
 */
export function rebuildPlanWithMutations(
  original: KnowledgeMutationPlan,
  m: {
    readonly creates: readonly NoteCreate[];
    readonly patches: readonly NotePatch[];
    readonly linkMutations: readonly LinkMutation[];
    readonly frontmatterUpdates: readonly FrontmatterPatch[];
  },
): KnowledgeMutationPlan | null {
  if (m.creates.length + m.patches.length + m.linkMutations.length + m.frontmatterUpdates.length === 0) return null;
  const parsed = KnowledgeMutationPlanSchema.safeParse({
    planId: original.planId as unknown as string,
    workspaceId: original.workspaceId as unknown as string,
    sourceRefs: original.sourceRefs.map((s) => ({
      sourceId: s.sourceId as unknown as string,
      ...(s.span !== undefined ? { span: s.span } : {}),
    })),
    creates: [...m.creates],
    patches: [...m.patches],
    linkMutations: [...m.linkMutations],
    frontmatterUpdates: [...m.frontmatterUpdates],
    externalActionProposals: original.externalActionProposals,
    confidence: original.confidence,
    requiresApproval: original.requiresApproval,
    provenanceOrigin: original.provenanceOrigin,
    ...(original.gbrainProposalRef !== undefined ? { gbrainProposalRef: original.gbrainProposalRef } : {}),
    ...(original.signedProvenanceStamp !== undefined ? { signedProvenanceStamp: original.signedProvenanceStamp } : {}),
    ...(original.expectedProjectId !== undefined ? { expectedProjectId: original.expectedProjectId } : {}),
  });
  return parsed.success ? parsed.data : null;
}
