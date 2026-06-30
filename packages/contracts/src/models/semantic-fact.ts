// SemanticFact seam model (task WT, §6/§12). The NORMALIZED unit that BOTH the
// SoW `CanonicalFactDeriver` (derives from canonical Markdown) and the read-only
// `DbProjector` (projects the GBrain DB) emit, so parity reconciliation compares
// like for like. Its identity is content-INDEPENDENT — the fact's *location*
// (page/link/timeline/tag), never its content hash — so a content change keeps
// the same identity and surfaces as an `mdContentSha` divergence, not a phantom
// new/missing fact. Zod is the single source of truth: the TS type is `z.infer`
// (surfaced as the explicit `SemanticFact` interface), the JSON Schema is
// generated via `emitJsonSchema`. PURE — imports only foundation primitives.
import { z } from "zod";
import {
  FactIdentitySchema,
  MdContentShaSchema,
  RevisionIdSchema,
  WorkspaceIdSchema,
} from "../primitives/zod-brands";
import { factKindSchema } from "./shared-enums";
import type {
  FactIdentity,
  MdContentSha,
  RevisionId,
} from "../primitives/zod-brands";
import type { WorkspaceId } from "../primitives/ids";
import type { FactKind } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const SEMANTIC_FACT_SCHEMA_ID = "sow:semantic-fact" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `egress-policy.ts`/`shared-shapes.ts`
// use. A nameable `SemanticFact` type sidesteps that; `.strict()` runtime
// rejection of unknown keys and the `.refine()` invariant are unaffected.
export interface SemanticFact {
  factIdentity: FactIdentity;
  factKind: FactKind;
  workspaceId: WorkspaceId;
  mdContentSha: MdContentSha;
  revisionId: RevisionId;
}

interface SemanticFactInput {
  factIdentity: string;
  factKind: FactKind;
  workspaceId: string;
  mdContentSha: string;
  revisionId: string;
}

// The content-INDEPENDENT `factIdentity` encodes its kind as a structural prefix:
//   page:<slug> | link:<src>-><dst>:<field> | timeline:<page>:<seq> | tag:<page>:<tag>
// For those four kinds the prefix MUST agree with `factKind`, so the same
// normalized unit round-trips between CanonicalFactDeriver and DbProjector
// unambiguously. The fifth kind, `frontmatter_value`, has no identity form named
// in Appendix A (arch_gap), so its coupling is intentionally left unconstrained.
const FACT_KIND_IDENTITY_PREFIX: Partial<Record<FactKind, string>> = {
  page: "page:",
  link: "link:",
  timeline: "timeline:",
  tag: "tag:",
};

export const SemanticFactSchema: z.ZodType<SemanticFact, z.ZodTypeDef, SemanticFactInput> = z
  .object({
    factIdentity: FactIdentitySchema,
    factKind: factKindSchema,
    workspaceId: WorkspaceIdSchema,
    mdContentSha: MdContentShaSchema,
    revisionId: RevisionIdSchema,
  })
  .strict()
  // Conditional invariant: the factIdentity prefix agrees with factKind for the
  // four spec-named forms. arch_gap: `frontmatter_value` has no identity form
  // upstream, so `prefix` is undefined for it and the check is skipped.
  .refine(
    (f) => {
      const prefix = FACT_KIND_IDENTITY_PREFIX[f.factKind];
      return prefix === undefined || f.factIdentity.startsWith(prefix);
    },
    {
      message:
        "factIdentity prefix must match factKind (page|link|timeline|tag); frontmatter_value identity form is unspecified upstream",
      path: ["factIdentity"],
    },
  );
