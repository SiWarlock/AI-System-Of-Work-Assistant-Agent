// EntityRef contract (§DEC-CANDGATE leg 1 — task 13.18; §2/§3/REQ-S-006). The
// candidate-data gate for a model-supplied reference to an entity (person/
// project/concept) that the §6 KN-10 living-vault synthesis (packages/knowledge)
// grounds via resolveEntity before any write. LEG 1 OF 3 — contracts-only: this
// slice defines the type + schema here; packages/knowledge's entity-resolver.ts
// still declares its own EntityRef with the same two fields and the same
// EntityKind union (knowledge's fields are `readonly`; this one's aren't — a
// narrowing, not a divergence leg 2 needs to reconcile). Self-described there as
// "knowledge-local, not a frozen contract" — that comment goes stale the moment
// this lands, but editing it is leg 2's territory, not this slice's. Duplicate
// persists until leg 2 re-points the import and deletes it. Recorded interim,
// not an oversight — the standing rule is no cross-area single-implementer
// verticals.
// This slice closes NOTHING at runtime yet; leg 2 calls this schema at the
// planSynthesis boundary.
//
// Closes the class-fix named by contracts L57/L60/L65 + task 13.8h: `kind:
// EntityKind` was a compile-time claim about runtime-untrusted model output with
// no schema anywhere enforcing it — `kind` was trusted enough to index an object
// literal (L65's prototype-chain hole) purely because nothing at the boundary
// rejected `"__proto__"`/`"constructor"`/`"prototype"`. `.strict()` additionally
// closes the shape the §ARM-RESEARCH residuals (13.8j/13.8k/13.8l) are all about:
// a model-supplied `path` cannot arrive on an EntityRef at all.
//
// Zod is the single source of truth; the TS type is hand-declared as an
// interface (house convention, contracts LESSONS #1) even though no field here
// is branded — matches proposed-action.ts / task.ts. A candidate-data gate
// rejects or passes; it never rewrites (no `.trim()` transform on `name` —
// a transforming schema would silently change entitySlug/faithfulKey derivation
// downstream, making the schema a second producer).
// PURE — imports only zod.
import { z } from "zod";

/** Stable JSON-Schema `$id` for the schema registry. */
export const ENTITY_REF_SCHEMA_ID = "sow:entity-ref" as const;

/**
 * The entity classes the living-vault synthesis resolves. Mirrors
 * packages/knowledge/src/synthesis/entity-resolver.ts's `EntityKind` — that
 * declaration is the interim duplicate leg 2 deletes, not re-derived from here.
 */
export const EntityKind = ["person", "project", "concept"] as const;
export const entityKindSchema = z.enum(EntityKind);
export type EntityKind = z.infer<typeof entityKindSchema>;

/**
 * A model-supplied reference to an entity to ground: a display name + its
 * class. Candidate data (REQ-S-006) until it passes `EntityRefSchema`.
 */
export interface EntityRef {
  name: string;
  kind: EntityKind;
}

interface EntityRefInput {
  name: string;
  kind: EntityKind;
}

/** Rejects an empty OR whitespace-only name (L60) without transforming it (never `.trim()`ed). */
const isNotBlank = (s: string): boolean => s.trim().length > 0;

export const EntityRefSchema: z.ZodType<EntityRef, z.ZodTypeDef, EntityRefInput> = z
  .object({
    // `.min(1)` + the blank-refine are each independently sufficient against an
    // empty string; kept together because they read as two distinct claims (non-
    // empty, non-blank) to a cold reader — harmless overlap, house style prefers
    // explicit-over-implicit bounds. 1024 mirrors the UI-safe single-line string
    // cap (ui-safe.ts's uiSafeSummaryLine) — a generous per-field bound, distinct
    // from the SEPARATE MAX_MODEL_ENTITY_REFS=200 array-length cap (planner.ts,
    // a different concern: fan-out, not per-field length).
    name: z.string().min(1).max(1024).refine(isNotBlank, { message: "name must not be blank" }),
    kind: entityKindSchema,
  })
  .strict();
