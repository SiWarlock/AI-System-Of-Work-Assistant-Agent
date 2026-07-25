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
import type { Result, WorkspaceId } from "@sow/contracts";
import { faithfulKey, entitySlug, identifiers } from "./match-keys";

/** The entity classes the living-vault synthesis resolves (knowledge-local, not a frozen contract). */
export type EntityKind = "person" | "project" | "concept";

/** A referenced entity to ground: a display name + its class. */
export interface EntityRef {
  readonly name: string;
  readonly kind: EntityKind;
}

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
  | "ws_scope_mismatch";

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
    if (matchedPaths.size === 1) return { kind: "resolved", path: matches[0]!.path };
    if (matchedPaths.size >= 2) return withheld("ambiguous");

    // No faithful match — a lossy collision with an existing note ⇒ withhold (never
    // fabricate a path nor create a stub that would collide); else propose a stub.
    const collides = valid.some((c) => identifiers(c).some((id) => entitySlug(id) === proposedSlug));
    return collides ? withheld("lossy_match") : { kind: "create_stub", proposedSlug };
  } catch {
    return withheld("gbrain_unavailable");
  }
}
