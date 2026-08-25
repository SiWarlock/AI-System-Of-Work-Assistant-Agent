// Zod schemas for branded IDs (Phase-1 contract freeze). Authored ONCE here so
// every model IMPORTS these brand schemas and nothing drifts. Each schema's
// `z.infer` EQUALS the corresponding `Branded<>` type — existing brands re-use
// the types from `./ids`; new brands define their `Branded<>` type here too.
//
// Idiom: a non-empty-after-trim string `.transform`ed to the brand. The transform
// changes only the OUTPUT type (the brand); the INPUT schema stays a plain
// `{ type:'string', minLength:1 }`, so `emitJsonSchema` produces a clean,
// self-contained JSON Schema with no `$ref`/`$defs`. PURE.
//
// ⚠ THE IDIOM IS NOT UNIVERSAL — three schemas below are not built by the
// factory, and only one of those is new: `FactIdentitySchema` and
// `MdContentShaSchema` have ALWAYS carried their own regex shapes, and
// `WorkspaceIdSchema` was narrowed to its own bounded slug shape by task
// `### 24.84`. All three therefore emit `pattern` (and `WorkspaceId` also
// `maxLength`). Every OTHER brand below is the plain factory idiom above.
import { z } from "zod";
import type { Branded } from "./ids";
import type {
  WorkspaceId,
  AgentJobId,
  ActionId,
  PlanId,
  SourceId,
  ApprovalId,
  WorkflowId,
  AuditId,
} from "./ids";
import type { ProcessorId, ToolId } from "./enums";

/**
 * Branded-string schema factory: a trimmed-non-empty `string` whose parse OUTPUT
 * is the brand `B`. Rejects both empty and whitespace-only input; emits a clean
 * `{ type:'string', minLength:1 }` JSON Schema (the `refine`/`transform` add no
 * JSON-Schema keywords).
 */
const brandedIdSchema = <B extends string>(): z.ZodType<B, z.ZodTypeDef, string> =>
  z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, "empty/whitespace")
    .transform((s): B => s as B);

// ── Existing brands (types re-used from ./ids) ──────────────────────────────

const WORKSPACE_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const WORKSPACE_ID_MAX = 64;

/**
 * A workspace id is a bounded lowercase slug: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`,
 * at most 64 chars. `WorkspaceId` is the only *id* brand narrowed away from the
 * generic factory (task `### 24.84`, contracts leg — §5/§16), because it is the
 * id that builds vault paths and reaches logs, audit rows and the renderer.
 * (`FactIdentity` and `MdContentSha` are also non-factory, but have always been.)
 *
 * ⛔ WHAT THIS IS: a WELL-FORMEDNESS rule. It makes a malformed workspace id
 * unrepresentable ON THE VALIDATING PATH, at one site, inherited by every model
 * that validates through the brand — including models not yet written. It also
 * forecloses path-traversal ids (`ws/../etc`), which matters because this id is
 * a path segment.
 *
 * ⚠ NOT "unrepresentable" FULL STOP — that would be this project's strongest
 * phrase (`L161`) and it would be false. Any cast into the brand bypasses the
 * runtime parse entirely, and such casts exist in production today (e.g. a
 * stored read-model row cast straight into the brand — `L76`'s shape, untouched
 * by this slice).
 * ⇒ the guarantee is "everything that PARSES is well-formed", never "every
 * value of this type is well-formed."
 *
 * ⛔⛔ DO NOT CENSUS THIS BY SPELLING — AND AN EARLIER DRAFT OF THIS DOCBLOCK DID,
 * WHICH IS WHY THE WARNING IS HERE RATHER THAN A COMMAND. It prescribed
 * `grep -rnE 'as (unknown as )?WorkspaceId\b'`. Measured against
 * `packages/knowledge/test/gcl-projection.test.ts` — THE file carrying this
 * repo's deliberate named bypass — that pattern returns **ZERO**, because the
 * casts there are spelled through INDEXED ACCESS:
 *     `as GclProjection["workspaceId"]`   `as Workspace["id"]`
 * ⇒ ⭐ the prescribed instrument returned a confident ALL-CLEAR about the one
 * file in the repo that is a known bypass site — the expensive direction, and
 * from the instrument this docblock supplied.
 *
 * ⇒ DERIVE BY POSITION/TYPE, NOT BY SPELLING (`### 24.92`, `L179`): the property
 * is "a `WorkspaceId` produced WITHOUT passing this schema's parse", and no
 * single pattern enumerates it — a brand alias, a helper's return type, a
 * generic, or a `satisfies` can each carry it. Any grep below is a STARTING
 * POINT whose miss-set is unknown, never a census:
 *     as (unknown as )?WorkspaceId      # direct
 *     as \w+\["(workspaceId|id)"\]      # indexed access — the family that was missed
 * ⚠ STATE THE UNIT when reporting one (`L183`): "cast sites" and "lines matching
 * the spelling" are different populations — the second includes return-type
 * annotations, which are not bypasses.
 *
 * ⛔⛔ A FOURTH SPELLING THE `as` CENSUS CANNOT FIND (task `### 24.100`,
 * corrected here so the census guidance can locate this CLASS, not just the
 * cast forms above): a NAMED FUNCTION that mints a brand without ever
 * invoking the brand's own schema is a bypass too, and it carries no `as`
 * token to grep for — `ids.ts`'s `workspaceId(raw)` was exactly this until
 * `### 24.100`: it routed through `makeId`'s bare `raw.trim().length===0`
 * check + `raw as Branded<...>` cast, never touching `WorkspaceIdSchema`, so
 * `workspaceId("NOT a valid workspace id!!")` returned a value this schema
 * would reject. FIXED: `makeId` now REQUIRES and RUNS the brand's governing
 * schema (`ids.ts`'s `BrandParser<B>` parameter) — every constructor it
 * backs (`workspaceId`, `agentJobId`, …, `processorId`, `toolId`) invokes its
 * own `*Schema.safeParse` and wraps a rejection in `InvalidIdError`, so this
 * particular named-function bypass is closed. The CLASS remains real for any
 * future brand constructor: to find one, do not grep for a spelling — read
 * every EXPORTED function whose return type is a brand and check whether its
 * body references that brand's `*Schema` (position/type census, `L179`, the
 * same method this file's `as`-cast guidance above already prescribes).
 *
 * ⛔ WHAT THIS IS NOT: a credential detector. Lowercase credential-shaped
 * strings ACCEPT (`sk-ant-api03-abc123def456`, `akiaiosfodnn7example`, a 32-char
 * lowercase hex, …) and `test/primitives/zod-brands.test.ts` PINS that
 * acceptance so the limitation stays stated rather than assumed away (`L82`).
 * "Is this a credential?" is a structurally unwinnable denylist (`worker L73`);
 * the question asked here is "is this a well-formed workspace id?".
 *
 * ⛔ THE 64-CHAR BOUND IS BOUNDED-INPUT HYGIENE, NOT CREDENTIAL DEFENSE — it
 * bounds an unbounded string at a durable sink. Measured: every credential shape
 * above accepts under BOTH max(64) and max(40), so no plausible bound buys
 * credential rejection, and this rationale must not drift into one.
 *
 * ⚠ Unlike the factory brands, this emits `pattern` + `maxLength` alongside
 * `minLength` (see the file header's JSON-Schema note).
 *
 * ⛔ `.min(1)` IS DELIBERATELY REDUNDANT — DO NOT "SIMPLIFY" IT AWAY. The regex
 * already requires at least one char, so `.min(1)` buys no validation. It is
 * retained so the emitted JSON Schema KEEPS `minLength: 1`, which makes this
 * change purely ADDITIVE across the 15 regenerated schemas (`pattern` +
 * `maxLength` added, nothing removed). Deleting it silently drops `minLength`
 * from all 15 — caught only as an unexplained snapshot red in `workspace.test.ts`
 * et al., far from this line.
 */
export const WorkspaceIdSchema: z.ZodType<WorkspaceId, z.ZodTypeDef, string> = z
  .string()
  .min(1)
  .max(WORKSPACE_ID_MAX)
  .regex(WORKSPACE_ID_RE, "workspace id must be a lowercase alphanumeric slug (`-` separated)")
  .transform((s): WorkspaceId => s as WorkspaceId);
export const AgentJobIdSchema = brandedIdSchema<AgentJobId>();
export const ActionIdSchema = brandedIdSchema<ActionId>();
export const PlanIdSchema = brandedIdSchema<PlanId>();
export const SourceIdSchema = brandedIdSchema<SourceId>();
export const ApprovalIdSchema = brandedIdSchema<ApprovalId>();
export const WorkflowIdSchema = brandedIdSchema<WorkflowId>();
export const AuditIdSchema = brandedIdSchema<AuditId>();
export const ProcessorIdSchema = brandedIdSchema<ProcessorId>();
export const ToolIdSchema = brandedIdSchema<ToolId>();

// ── New brands (Branded<> type defined here + schema + inferred export) ──────
export type Capability = Branded<string, "Capability">;
export const CapabilitySchema = brandedIdSchema<Capability>();

export type RevisionId = Branded<string, "RevisionId">;
export const RevisionIdSchema = brandedIdSchema<RevisionId>();

export type ProposalId = Branded<string, "ProposalId">;
export const ProposalIdSchema = brandedIdSchema<ProposalId>();

export type ReportId = Branded<string, "ReportId">;
export const ReportIdSchema = brandedIdSchema<ReportId>();

export type BrainId = Branded<string, "BrainId">;
export const BrainIdSchema = brandedIdSchema<BrainId>();

// §13.5 — the typed Project's stable identity (independent of its note slug).
export type ProjectId = Branded<string, "ProjectId">;
export const ProjectIdSchema = brandedIdSchema<ProjectId>();

// §13.15 — the typed Task's stable identity (independent of its note slug).
export type TaskId = Branded<string, "TaskId">;
export const TaskIdSchema = brandedIdSchema<TaskId>();

// ── FactIdentity — content-INDEPENDENT structured identity (Appendix A) ──────
// Forms (lenient inner chars):
//   page:<slug>  |  link:<src>-><dst>:<field>  |  timeline:<page>:<seq>  |  tag:<page>:<tag>
export type FactIdentity = Branded<string, "FactIdentity">;
const FACT_IDENTITY_RE = /^(?:page:.+|link:.+->.+:.+|timeline:.+:.+|tag:.+:.+)$/;
export const FactIdentitySchema = z
  .string()
  .regex(FACT_IDENTITY_RE, "invalid fact identity")
  .transform((s): FactIdentity => s as FactIdentity);

/** Structured parts for building a `FactIdentity` string. */
export type FactIdentityParts =
  | { kind: "page"; slug: string }
  | { kind: "link"; src: string; dst: string; field: string }
  | { kind: "timeline"; page: string; seq: string | number }
  | { kind: "tag"; page: string; tag: string };

/**
 * Builder: assemble (but do not validate) a `FactIdentity` from typed parts.
 *
 * ⚠ TASK 24.100 DISPOSITION — this is the ONE genuine member the census found (method below), and it is
 * KEPT as a deliberate builder, not bound to `FactIdentitySchema.parse`: unlike `makeId`'s constructors
 * (which parse an UNTRUSTED raw string), this assembles from ALREADY-TYPED `FactIdentityParts` — there is
 * no untrusted string to validate, only a template to apply. Running the schema here would be a
 * structural-shape re-check of the function's OWN output, not a boundary gate. The compensating control is
 * test/primitives/shared.test.ts's four `factIdentity() '<kind>' branch parses via FactIdentitySchema`
 * pins (one per switch arm, mutation-verified) — they prove every template still produces a string
 * `FACT_IDENTITY_RE` accepts, so a future edit that drifts a template from the regex reds THERE instead of
 * silently minting an identity its own schema would reject.
 *
 * CENSUS METHOD (24.100 — "derive by the PROPERTY 'produces a branded id without running its schema'",
 * never by spelling): read every function in `packages/contracts/src` EXPORTING a return type naming one of
 * the 19 `Branded<string, "…">` brands defined in this file + `./ids.ts` + `./enums.ts`, and check whether
 * its body references that brand's own `*Schema`. BOUNDARY: `packages/contracts/src` only (this task's
 * `Track:`). Population = 11 such functions: `workspaceId`/`agentJobId`/`actionId`/`planId`/`sourceId`/
 * `approvalId`/`workflowId`/`auditId` (`./ids.ts`) + `processorId`/`toolId` (`./enums.ts`) — all 10 route
 * through `makeId`'s required `schema` parameter (fixed at `27640ebe`) — + `factIdentity` here, the sole
 * remaining bypass, dispositioned above. The other 8 brands (`Capability`/`RevisionId`/`ProposalId`/
 * `ReportId`/`BrainId`/`ProjectId`/`TaskId`/`MdContentSha`) have NO exported constructor function in this
 * package at all — nothing to census; callers invoke their `*Schema` directly.
 */
export function factIdentity(parts: FactIdentityParts): FactIdentity {
  switch (parts.kind) {
    case "page":
      return `page:${parts.slug}` as FactIdentity;
    case "link":
      return `link:${parts.src}->${parts.dst}:${parts.field}` as FactIdentity;
    case "timeline":
      return `timeline:${parts.page}:${parts.seq}` as FactIdentity;
    case "tag":
      return `tag:${parts.page}:${parts.tag}` as FactIdentity;
  }
}

// ── MdContentSha — sha256 hex of normalized semantic content (Appendix A) ────
export type MdContentSha = Branded<string, "MdContentSha">;
//
// ⛔ NO `/i` FLAG (task ### 24.89 — do not re-add it). `zod-to-json-schema`
// emits a `.regex()` brand's `pattern` as the regex SOURCE only — JSON
// Schema draft-07's `pattern` keyword carries no flags mechanism, so a Zod
// `/i` flag is silently DROPPED the moment this schema is emitted and
// compiled by ajv. Verified: with `/i`, Zod ACCEPTED an uppercase sha256 hex
// that every emitted embedding schema (`semantic-fact.schema.json`,
// `fact-provenance.schema.json`, `signed-provenance-stamp.schema.json`,
// `divergence.schema.json`, `knowledge-mutation-plan.schema.json` — all
// embed this brand) compiled to REJECT via ajv, a live Zod-vs-ajv
// candidate-data-gate disagreement. sha256 hex is canonically lowercase, so
// the fix is to TIGHTEN Zod to match every emitted `pattern`, not to widen
// ajv. Pinned: `test/primitives/zod-ajv-regex-parity.test.ts`.
export const MdContentShaSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "sha256 hex")
  .transform((s): MdContentSha => s as MdContentSha);
