// EntityResolver (§6 KN-10 living-vault synthesis; §5 WS-8; 13.8a) — the ⭐ start of
// the ARC-4 keystone. Grounds a referenced entity (person/project/concept) to an
// EXISTING canonical vault note path via a workspace-scoped GBrain read, returning a
// RESOLVED path, a CREATE-STUB decision, or WITHHELD — and NEVER fabricating a path.
// This is osb's ground-before-write rule, governed: "a synthesis-named path is never
// proof the note exists." SoW had no resolver today (vault paths were lossily slug-
// derived); this is the net-new load-bearing primitive 13.8b/c/d/f/g build on.
//
// SAFETY (rule 4 / WS-8): the read port is workspace-scoped BY CONSTRUCTION, and the
// resolver additionally re-gates — a port bound to a different workspace never reads,
// and any candidate carrying a foreign workspaceId is DROPPED (defense-in-depth,
// mirrors mcp-read-adapter / worker L12/L32). A cross-workspace hit is never resolved.
//
// Match strictness (13.8b faithful-match, Q1 STRICTER-withhold ruling): a FAITHFUL key
// (NFC + fold em/en-dashes + lowercase + trim; spaces are NOT flattened to hyphens)
// must match a candidate's slug / title / alias to RESOLVE. A match only under lossy
// slugification (e.g. `C++`→`c`, or `Acme API`→`acme-api` vs a slug-only note) is
// WITHHELD — resolving it would risk binding to a DIFFERENT note that slugifies the
// same. TOTAL never-throws; fail-closed to withheld on any fault/empty/malformed.
import { isErr } from "@sow/contracts";
import type { Result, WorkspaceId, EntityKind, EntityRef as ContractsEntityRef, NoteCreate } from "@sow/contracts";
import { faithfulKey, entitySlug, identifiers } from "./match-keys";
import { admitGroundedPath, type GroundedPathRefusal } from "./grounded-path";
import { renderGeneratedRegion } from "../markdown-vault/sections";

/**
 * `EntityKind` is the `packages/contracts` frozen contract (§DEC-CANDGATE leg 1, task 13.18) —
 * re-exported here so every existing importer of `./entity-resolver` (planner.ts, meeting-rewrite.ts,
 * attendee-refs.ts, this file's own tests, and — via the `@sow/knowledge` barrel —
 * packages/evals/src/synthesis/corpus.ts) keeps resolving unchanged. This file no longer declares
 * its own copy (leg 2, task 13.19); the `EntityRefSchema` candidate-data gate is called at the
 * `planSynthesis` boundary (`planner.ts`'s `collectEntities`) — the actual point model-supplied
 * candidate data crosses in — not here. `resolveEntity` below stays schema-agnostic on purpose (the
 * gate runs ONCE at the boundary, not per consumer); a deterministic caller (e.g. the meeting path's
 * attendee-supplied refs) calls it directly and is unaffected by that gate.
 */
export type { EntityKind };

/**
 * 13.21 (owner ruling, Option C of four): an ELEMENT-IMMUTABLE narrowing of contracts' `EntityRef`,
 * under the SAME name so every existing importer of `./entity-resolver` inherits it with zero
 * call-site churn. `readonly EntityRef[]` at every consumption site (planner.ts, attendee-refs.ts,
 * meeting-rewrite.ts) only ever protected the ARRAY (rejecting element replacement) — never a field
 * on an element (`arr[0].name = "x"`), because leg 2 (13.19) re-exported contracts' EntityRef, whose
 * fields are mutable by that package's own (deliberate, documented at contracts entity-ref.ts:25-27)
 * house convention. This is a DERIVED narrowing, not a second declaration — it is *computed* from
 * contracts' type, so unlike the duplicate leg 2 deleted, it cannot drift: a future field add to
 * contracts' EntityRef appears here automatically, still readonly-at-this-level. `packages/contracts`
 * is NOT modified (owner ruling — its non-readonly convention for Appendix-A seam models stays
 * untouched). ⚠ `Readonly<T>` is SHALLOW: both current fields (`name`/`kind`) are primitives, so this
 * is a complete guarantee today — but a future non-primitive field (an array/object) would have its
 * own reassignment blocked, never its contents' mutation (`ref.tags.push(...)` would still
 * type-check). Re-examine this narrowing (a deep-readonly form) if contracts ever adds one.
 *
 * ⚠ RESIDUAL, recorded rather than guarded: this narrowing is inherited only through `./entity-
 * resolver` (or the `@sow/knowledge` barrel, which re-exports it). A hypothetical future consumer
 * inside `packages/knowledge` importing `EntityRef` DIRECTLY from `@sow/contracts` would get the
 * mutable form instead. No such import exists today — verified repo-wide; this file was the only
 * `packages/knowledge` site importing the bare contracts type, and it is what this comment replaces.
 * Not backed by a scanner: a source-scan over import statements for this is a negative claim over an
 * unbounded space (a detector, not a gate — 9.39's precedent), so it is recorded here instead.
 */
export type EntityRef = Readonly<ContractsEntityRef>;

/** An existing vault note candidate from the workspace-scoped GBrain read. */
export interface EntityCandidate {
  readonly path: string;
  readonly slug: string;
  readonly title?: string;
  readonly aliases?: readonly string[];
  readonly workspaceId: WorkspaceId;
}

/** A typed read fault (§16, code-only — rule 7). */
export interface EntityReadFault {
  readonly code: string;
}

/**
 * The injected GBrain read port — workspace-scoped BY CONSTRUCTION (`workspaceId`
 * bound; a cross-workspace query is structurally impossible). Returns candidate notes
 * for an entity as a typed Result; NEVER trusted to be well-formed.
 */
export interface EntityGbrainReadPort {
  readonly workspaceId: WorkspaceId;
  findCandidates(entityRef: EntityRef): Promise<Result<readonly EntityCandidate[], EntityReadFault>>;
}

/** Why the resolver withheld (code-only, redaction-safe — rule 7). */
export type WithheldReason =
  | "ambiguous"
  | "lossy_match"
  | "gbrain_unavailable"
  | "malformed_entity"
  | "ws_scope_mismatch"
  /**
   * 13.8k path refusals, COMPOSED from the guard's own union rather than re-declared: a new
   * `GroundedPathRefusal` member propagates here automatically instead of being silently funnelled
   * into a catch-all by a non-exhaustive mapping.
   */
  | GroundedPathRefusal;

/**
 * The three-way resolution: a resolved EXISTING path, a create-stub proposal (no note
 * exists yet), or withheld (never a fabricated or arbitrary path).
 */
export type EntityResolution =
  | { readonly kind: "resolved"; readonly path: string }
  | { readonly kind: "create_stub"; readonly proposedSlug: string }
  | { readonly kind: "withheld"; readonly reason: WithheldReason };

function withheld(reason: WithheldReason): EntityResolution {
  return { kind: "withheld", reason };
}

// ── stub note paths — namespaced, derived ONCE (13.8j; §6 KN-12, safety rule 1) ──────────────
//
// An entity name is UNTRUSTED (13.8g-A feeds it from meeting attendee strings). Minting a stub at
// the vault ROOT let a name like `Index`/`Log`/`README` collide with the KnowledgeWriter-owned KN-12
// structural surfaces — the navigation catalog and the append-only op-log. `MeetingRewriteDeps`
// deliberately omits the `structural` port so a meeting CANNOT touch those; root-level minting
// reached them by another door.
//
// The fix is a NAMESPACE, not a reserved-name denylist. A namespace is complete-by-construction: a
// namespaced note cannot collide with a root structural file, for every present AND FUTURE
// structural filename, with no list to maintain. Enumeration is structurally unwinnable and this
// codebase has paid for it twice (the subscription shadow-env key set needed three re-grounds and
// still missed a switch — worker L72; the settings-injection FIELD enumeration was retired for a
// presence-degrade — §ARM-18 18.39-B). Do not "simplify" this into a denylist.
//
// It is derived HERE, once, so both consumers (13.8c `planner.ts`, 13.8f-A `meeting-rewrite.ts`)
// inherit it by construction — the previous duplication is exactly what let the same defect exist in
// two places, and a namespace applied twice by hand is one edit away from being applied once.

/**
 * The vault namespace each entity kind's STUB notes are minted under. Module-private on purpose:
 * `stubNotePathFor` is the sanctioned way to get a path, and exporting the table would invite a
 * downstream consumer to build its own — the very duplication this slice exists to remove.
 *
 * A `Map`, NOT an object literal. `kind` is runtime-untrusted, and an object index inherits
 * `Object.prototype`: `kind = "__proto__"` / `"toString"` / `"constructor"` would return a
 * non-undefined value, so `?? FALLBACK` would never fire and the path would land back at the ROOT
 * (`"[object Object]index.md"`). A Map has no prototype keys and is immune to a polluted
 * `Object.prototype` injecting new ones — the namespace stays complete-by-construction rather than
 * "complete except ~9 magic strings", which would be the denylist posture this design rejects.
 */
const ENTITY_NAMESPACES: ReadonlyMap<string, string> = new Map([
  ["person", "people/"],
  ["project", "projects/"],
  ["concept", "concepts/"],
]);

/** The entity kinds with a dedicated namespace — exported for exhaustiveness tests only. */
export const NAMESPACED_ENTITY_KINDS: readonly EntityKind[] = ["person", "project", "concept"];

/**
 * The namespace for an UNRECOGNIZED kind. ⚠ LOAD-BEARING — do not "tighten" this into a rejection.
 * `kind` reaches the planner from `candidate.entityRefs`, i.e. MODEL-SUPPLIED CANDIDATE DATA, so a
 * malformed value is reachable rather than hypothetical. Falling through to a bare `<slug>.md` would
 * silently reopen the exact collision hole above, on the exact path (untrusted input) that makes it
 * dangerous — a fail-safe that fails back to the vulnerable state is not a fail-safe. Rejecting the
 * ref instead would silently LOSE a legitimately-resolved entity over a typo; filing it here loses
 * nothing (the note exists, grounds, and a human can re-file it). The model may influence WHERE
 * within a namespace, never WHETHER there is one.
 */
const FALLBACK_NAMESPACE = "entities/";

/**
 * The ONE place an entity stub's vault path is derived. Returns `null` for anything that is not a
 * mintable stub — a `resolved` note keeps the path the resolver returned (never re-pathed, which
 * would break grounding), and `withheld`/empty-slug mint nothing. Pure; never throws.
 */
export function stubNotePathFor(resolution: EntityResolution, kind: EntityKind | undefined): string | null {
  if (resolution == null || resolution.kind !== "create_stub") return null;
  const slug = resolution.proposedSlug;
  if (typeof slug !== "string" || slug.length === 0) return null;
  // `kind` is declared possibly-absent so the fallback is reachable BY THE TYPE SYSTEM — the callers
  // read it off runtime-untrusted candidate data, and a signature that claimed otherwise would just
  // push the dishonesty into a cast at the call site.
  const namespace = ENTITY_NAMESPACES.get(kind ?? "") ?? FALLBACK_NAMESPACE;
  return `${namespace}${slug}.md`;
}

/**
 * The ONE place an entity stub's `NoteCreate` BODY is derived (13-residual-1) — the companion to
 * {@link stubNotePathFor} immediately above, which derives the PATH once. Before this, `planner.ts`
 * and `meeting-rewrite.ts` each built `{ path, body: renderGeneratedRegion("stub", "") }` inline,
 * independently, from the SAME `stubNotePathFor` result — identical today by coincidence, not by
 * construction, so a future edit to one call site would not propagate to the other (the exact
 * duplication shape `stubNotePathFor`'s own header names as the reason it was pulled out once).
 * Returns `null` in EXACTLY the cases `stubNotePathFor` returns `null` — never partially construct a
 * `NoteCreate` from a path that was refused a mint.
 */
export function mintEntityStub(resolution: EntityResolution, kind: EntityKind | undefined): NoteCreate | null {
  const path = stubNotePathFor(resolution, kind);
  if (path === null) return null;
  return { path, body: renderGeneratedRegion("stub", "") };
}

// The faithful-match discipline — the key (`faithfulKey`), the lossy slug (`entitySlug`), and the
// comparable-identifier set (`identifiers`) — lives in `./match-keys`, the ONE source 13.8a + 13.8b
// (LinkHealer) both ground on so they can never drift (Lesson 17).

/**
 * Resolve a referenced entity to an EXISTING canonical vault note path, a create-stub
 * decision, or withheld — grounding before any write. Pure over the injected read
 * port; TOTAL never-throws; fail-closed to withheld.
 */
export async function resolveEntity(
  entityRef: EntityRef,
  workspaceId: WorkspaceId,
  deps: { readonly gbrain: EntityGbrainReadPort },
): Promise<EntityResolution> {
  // 1. WS-8 defense-in-depth — a port bound to a different workspace NEVER reads.
  if (deps.gbrain.workspaceId !== workspaceId) return withheld("ws_scope_mismatch");

  // 2. Malformed entity — no usable slug anchor ⇒ withheld, no query issued.
  const proposedSlug = entitySlug(entityRef.name);
  const key = faithfulKey(entityRef.name);
  if (proposedSlug === "" || key === "") return withheld("malformed_entity");

  // 3. Read + match — the WHOLE untrusted-payload map runs under ONE try (Lesson 11:
  //    a mis-shaped `ok` array or an element with a throwing accessor can't escape).
  try {
    const read = await deps.gbrain.findCandidates(entityRef);
    if (isErr(read) || !Array.isArray(read.value)) return withheld("gbrain_unavailable");

    // WS-8 re-gate + shape guard — drop foreign-workspace or malformed candidates.
    const valid = read.value.filter(
      (c): c is EntityCandidate =>
        c != null &&
        typeof c.path === "string" &&
        c.path.length > 0 &&
        typeof c.slug === "string" &&
        c.slug.length > 0 &&
        c.workspaceId === workspaceId,
    );

    // Faithful match — resolve iff exactly ONE DISTINCT note matches. Counting by
    // distinct `path` (not row) so a read adapter that unions slug/title/alias hits
    // into duplicate rows for one note resolves, not a false `ambiguous`.
    const matches = valid.filter((c) => identifiers(c).some((id) => faithfulKey(id) === key));
    const matchedPaths = new Set(matches.map((c) => c.path));
    if (matchedPaths.size === 1) {
      // 13.8k: `candidate.path` is UNTRUSTED data from the GBrain read — a non-empty-string check is
      // not a path check. Refuse here so every consumer of a `resolved` result inherits the
      // invariant, and WITHHOLD rather than sanitize (a repaired path is a target the row never
      // claimed). An admitted path is returned byte-identical, so grounding still matches exactly.
      const verdict = admitGroundedPath(matches[0]!.path);
      if (!verdict.ok) return withheld(verdict.reason);
      return { kind: "resolved", path: verdict.path };
    }
    if (matchedPaths.size >= 2) return withheld("ambiguous");

    // No faithful match — a lossy collision with an existing note ⇒ withhold (never
    // fabricate a path nor create a stub that would collide); else propose a stub.
    const collides = valid.some((c) => identifiers(c).some((id) => entitySlug(id) === proposedSlug));
    return collides ? withheld("lossy_match") : { kind: "create_stub", proposedSlug };
  } catch {
    return withheld("gbrain_unavailable");
  }
}
