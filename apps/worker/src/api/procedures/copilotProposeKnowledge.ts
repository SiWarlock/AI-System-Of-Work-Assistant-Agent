// §13.10a — the Copilot SEMANTIC-WRITE propose DERIVATION (worker side). The sibling of copilotPropose.ts
// (which derives an EXTERNAL-write ProposedAction); this derives a SEMANTIC-write KnowledgeMutationPlan.
//
// When the agent calls the `copilot.propose_knowledge` tool (wired in a later slice), the model supplies ONLY an
// INTENT for a typed Project note — a projectId, title, lifecycleState, and an optional status summary. This module
// DERIVES the canonical `KnowledgeMutationPlan`:
//   - The note PATH is derived SERVER-SIDE via the SINGLE `projectNotePath` WS-8 authority from the SERVER-BOUND
//     workspace + the sanitized projectId — the model NEVER supplies a path, so it cannot escape `projects/<ws>/`
//     or redirect the write to another workspace. Reusing the SAME authority as projectSync is load-bearing: a
//     Copilot-proposed project note and its projectSync note resolve to the SAME file.
//   - `workspaceId` is the passed (server-bound) workspace, NEVER an intent field (WS-2/WS-4). The strict intent
//     shape-guard REJECTS an intent carrying a `workspaceId` (or any unexpected) key.
//   - `provenanceOrigin` is `copilot_propose` (§13.10a); `requiresApproval` is FORCED true — a Copilot semantic
//     write is NEVER auto-applied. This module only DERIVES; a later slice routes the plan to §9.8 Approvals and
//     KnowledgeWriter commits it ONLY on owner approval (safety rules 1+2: one writer, candidate-data gate).
//   - NO numeric progress/percent is emitted (REQ-F-011): a proposal has no deterministic checkbox source, and a
//     model-supplied percent is forbidden — the proposed note carries lifecycle + candidate prose only.
//   - `create` vs `patch` is chosen by a caller-supplied `noteExists` (a WS-8-scoped probe), so the function stays
//     PURE: a first proposal emits a full NoteCreate; a re-proposal of an existing note emits a region NotePatch
//     (never a whole-file overwrite — the create-vs-patch clobber fix, sess 048).
//
// The derived plan is re-validated through `KnowledgeMutationPlanSchema` (the candidate-data gate) before it is
// returned. PURE; never throws (typed Result); NO side effect — no Markdown write, no external write, no store.
import { ok, err, failure, KnowledgeMutationPlanSchema, projectLifecycleStateSchema } from "@sow/contracts";
import type {
  FailureVariant,
  KnowledgeMutationPlan,
  NoteCreate,
  NotePatch,
  Result,
  SourceRef,
  WorkspaceId,
} from "@sow/contracts";
import { buildIdempotencyKey } from "@sow/domain";
// The WS-8 path authority + the SHARED project-note conventions (region id + full-note framing) — reusing the
// SAME `noteSlug` module as projectSync is load-bearing: a Copilot-proposed project note and its synced note
// resolve to the SAME file AND the SAME region, by construction (no copy-paste drift).
import {
  projectNotePath,
  PROJECT_STATUS_REGION,
  composeProjectStatusNote,
} from "@sow/workflows/activities/projections/noteSlug";

/** A Copilot proposal is a proposal, NOT a deterministic fact — a fixed sub-1 plan confidence (never 1). */
export const COPILOT_PROPOSE_KNOWLEDGE_CONFIDENCE = 0.5;

/** Bound the model-authored summary — an unbounded model payload is a storage/render DoS surface. */
export const MAX_PROPOSE_SUMMARY_CHARS = 4 * 1024;

/**
 * The model's UNTRUSTED semantic-write INTENT — the ONLY thing the model supplies. It carries NO path, NO keys,
 * NO workspace, NO percent: the path/keys/workspace are DERIVED server-side, and a numeric progress is forbidden
 * (REQ-F-011). Strict-parsed (extra/unexpected keys rejected) before any use.
 *   - `projectId`      — the project's stable id (the note-path leaf, sanitized by the WS-8 authority).
 *   - `title`          — the project's display title (the H1 + frontmatter title).
 *   - `lifecycleState` — must be a member of the ProjectLifecycleState enum, else fail-closed.
 *   - `summary`        — OPTIONAL candidate status prose the owner approves (bounded; region-marker-free).
 */
export interface CopilotProjectProposeIntent {
  readonly projectId: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly summary?: string;
}

/** The 4 fields a well-formed intent carries — extra keys are rejected (strict; no smuggled path/workspace/key). */
const INTENT_FIELDS: ReadonlySet<string> = new Set(["projectId", "title", "lifecycleState", "summary"]);

/** Is a value a plain (non-array, non-null) object? */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A model string that lands in a SINGLE-LINE context (the H1 line, a frontmatter `key: value` line) must be
 * single-line AND free of the HTML-comment / assistant-region marker sequence — else the model could inject a
 * newline (forging a second frontmatter key or an H2) or a `<!-- kw:region ... -->` marker (forging/closing a
 * region and spilling content into human-owned scaffold, KN-7). Fail-closed (reject; never transform).
 */
function isSafeSingleLine(s: string): boolean {
  return !s.includes("\n") && !s.includes("\r") && !s.includes("<!--") && !s.includes("-->");
}

/**
 * The summary lands INSIDE the assistant region (multi-line prose is fine), but must NOT carry an HTML-comment /
 * region marker — else it could forge or prematurely CLOSE the `kw:region:project-status` and spill the rest of
 * its content into human-owned scaffold (KN-7) or corrupt the region layout. Fail-closed.
 */
function isSafeRegionProse(s: string): boolean {
  return !s.includes("<!--") && !s.includes("-->");
}

/**
 * PURE strict shape-guard over the UNTRUSTED intent (hand-written — the worker has no zod dep; mirrors
 * `copilotPropose.ts`'s `parseCopilotProposeIntent`). Returns the typed intent or `null` on anything off:
 * not an object, an unexpected extra key (e.g. a smuggled `workspaceId`/`path`), or a wrong-typed field.
 */
function parseIntent(raw: unknown): CopilotProjectProposeIntent | null {
  if (!isPlainObject(raw)) return null;
  if (Object.keys(raw).some((k) => !INTENT_FIELDS.has(k))) return null; // strict — reject unexpected keys
  const { projectId, title, lifecycleState, summary } = raw;
  if (typeof projectId !== "string" || typeof title !== "string" || typeof lifecycleState !== "string") return null;
  if (summary !== undefined && typeof summary !== "string") return null;
  return summary === undefined
    ? { projectId, title, lifecycleState }
    : { projectId, title, lifecycleState, summary };
}

/** Fold a bounded cause code onto a redaction-safe `validation_rejected` failure (never a raw message). */
function fail(code: string): FailureVariant {
  return failure("validation_rejected", `copilot propose knowledge: ${code}`, { cause: { code } });
}

/**
 * The server-supplied, non-model dependencies. `workspaceId` is the agent-job's SERVER-BOUND workspace (WS-2/WS-4);
 * `sourceRef` is the proposal's evidence (REQ-F-006: the derived plan cites ≥1 source — the caller supplies the
 * grounding of the Copilot answer); `noteExists` is a WS-8-scoped probe result the caller computes (keeping this
 * function pure) that selects create (false) vs region-patch (true).
 */
export interface CopilotProposeKnowledgeDeps {
  readonly workspaceId: WorkspaceId;
  readonly sourceRef: SourceRef;
  readonly noteExists: boolean;
}

/**
 * DERIVE the canonical `KnowledgeMutationPlan` from the model's UNTRUSTED project intent (server-derived path/keys;
 * never model-supplied). Fail-closed at every step (never throws — typed Result):
 *   - the intent is STRICT-PARSED first → `COPILOT_PROPOSE_KNOWLEDGE_MALFORMED` on a non-object / extra key /
 *     wrong-typed field (so no `.trim()`/derivation ever runs on unvalidated input).
 *   - `projectId` / `title` must be non-blank AND single-line + marker-free → else BAD_PROJECT_ID / BAD_TITLE.
 *   - `lifecycleState` must be a ProjectLifecycleState member → else BAD_LIFECYCLE (never lands in frontmatter).
 *   - `summary` (if present) must be bounded + region-marker-free → else SUMMARY_TOO_LARGE / SUMMARY_UNSAFE.
 *   - the note PATH is `projectNotePath(workspaceId, projectId)` (the WS-8 authority) → null → UNSAFE_PATH.
 * The derived plan carries `provenanceOrigin: copilot_propose`, `requiresApproval: true`, a sub-1 `confidence`, and
 * the passed `sourceRef` (REQ-F-006); it is re-validated through `KnowledgeMutationPlanSchema` (SCHEMA_REJECTED on
 * a shape failure — belt-and-suspenders). PURE; never throws.
 */
export function deriveCopilotProjectKnowledgePlan(
  intent: unknown,
  deps: CopilotProposeKnowledgeDeps,
): Result<KnowledgeMutationPlan, FailureVariant> {
  const i = parseIntent(intent);
  if (i === null) return err(fail("COPILOT_PROPOSE_KNOWLEDGE_MALFORMED"));

  const projectId = i.projectId.trim();
  if (projectId.length === 0 || !isSafeSingleLine(projectId)) {
    return err(fail("COPILOT_PROPOSE_KNOWLEDGE_BAD_PROJECT_ID"));
  }
  const title = i.title.trim();
  if (title.length === 0 || !isSafeSingleLine(title)) {
    return err(fail("COPILOT_PROPOSE_KNOWLEDGE_BAD_TITLE"));
  }

  const lc = projectLifecycleStateSchema.safeParse(i.lifecycleState);
  if (!lc.success) return err(fail("COPILOT_PROPOSE_KNOWLEDGE_BAD_LIFECYCLE"));
  const lifecycleState = lc.data;

  let summary: string | undefined;
  if (i.summary !== undefined) {
    if (i.summary.length > MAX_PROPOSE_SUMMARY_CHARS) {
      return err(fail("COPILOT_PROPOSE_KNOWLEDGE_SUMMARY_TOO_LARGE"));
    }
    if (!isSafeRegionProse(i.summary)) {
      return err(fail("COPILOT_PROPOSE_KNOWLEDGE_SUMMARY_UNSAFE"));
    }
    summary = i.summary;
  }

  // WS-8: the note path is derived from the SERVER-BOUND workspace + the sanitized projectId — the SINGLE authority
  // shared with projectSync (so a Copilot-proposed note and its synced note are the SAME file). Fail-closed on null.
  //
  // ⚠ GO-LIVE PRECONDITION (slug collision — review MEDIUM, needs the routing/executor slice, NOT fixable here):
  // `safeNoteSlug` is lossy, so two DISTINCT raw projectIds can resolve to the SAME note (`Acme Corp` vs `Acme  Corp!`
  // -> `acme-corp`). This pure derivation cannot read the existing note, so a re-proposal (noteExists) that collides
  // with an UNRELATED project's slug would region-PATCH that project's note. Bounded TODAY by the structural human
  // gate (requiresApproval:true — the owner approves the card before KnowledgeWriter commits). The routing/executor
  // slice MUST, on a patch, verify the existing note's frontmatter `projectId` === this intent's projectId before
  // applying (the raw projectId is stamped into the create frontmatter above for exactly this check), else reject.
  const path = projectNotePath(deps.workspaceId, projectId);
  if (path === null) return err(fail("COPILOT_PROPOSE_KNOWLEDGE_UNSAFE_PATH"));

  // The region INNER body — shared by the NoteCreate full note and the NotePatch newBody (byte-idempotent across
  // create -> re-propose). NO percent/progress (REQ-F-011): lifecycle + candidate prose only.
  const regionBody = composeRegionBody(lifecycleState, summary);

  // create-vs-patch (sess 048): re-proposal region-PATCHes ONLY (preserves H1 + frontmatter + human scaffold); a
  // first proposal emits the full NoteCreate. A NoteCreate over an existing note would overwrite the whole file.
  const creates: NoteCreate[] = [];
  const patches: NotePatch[] = [];
  if (deps.noteExists) {
    patches.push({ path, regionId: PROJECT_STATUS_REGION, newBody: regionBody });
  } else {
    // ⚠ GO-LIVE PRECONDITION (frontmatter escaping — review MEDIUM, KnowledgeWriter track, NOT this pure slice):
    // `title`/`projectId` are model-authored VALUES here; the KnowledgeWriter's frontmatter serializer
    // (writer.ts `serializeScalar`/`composeNote`) writes them VERBATIM/UNESCAPED into `key: value` lines. Safe for
    // this repo's naive line-parser, but a real-YAML consumer (Obsidian, a gbrain ingest) could misparse a value
    // starting with a YAML indicator (`#`, `-`, `[`, `{`, quotes). isSafeSingleLine blocks newlines + region
    // markers (the injection vectors); before the propose path COMMITS to a real vault, the serializer must
    // YAML-escape frontmatter values. This slice only DERIVES a schema-valid KMP; it never serializes/commits.
    creates.push({
      path,
      title,
      frontmatter: {
        projectId,
        title,
        workspaceId: String(deps.workspaceId), // display copy; the physical path is workspace-rooted (WS-8)
        lifecycleState,
        provenanceOrigin: "copilot_propose",
      },
      body: composeProjectStatusNote(title, regionBody),
    });
  }

  // Stable planId: keyed on the derived NOTE PATH (the actual write target — already workspace-rooted), NOT the raw
  // projectId. So two raw projectIds that slug-collide onto the SAME note derive the SAME plan id -> one idempotent
  // Approval card (not two cards racing last-write-wins on one region); a re-propose of the same note replays to the
  // same id; a different workspace/note can never share the id.
  const planKey = buildIdempotencyKey({
    operation: "copilot.propose.project",
    identity: { notePath: path },
  });

  // The candidate plan: raw strings (the schema brands planId/workspaceId/sourceId on parse — mirrors
  // copilotPropose's `ProposedActionSchema.safeParse`). provenanceOrigin is copilot_propose (Slice A landed it);
  // requiresApproval is forced true; confidence is sub-1 (a proposal, not a deterministic fact).
  const parsed = KnowledgeMutationPlanSchema.safeParse({
    planId: planKey,
    workspaceId: String(deps.workspaceId),
    sourceRefs: [deps.sourceRef],
    creates,
    patches,
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: COPILOT_PROPOSE_KNOWLEDGE_CONFIDENCE,
    requiresApproval: true,
    provenanceOrigin: "copilot_propose",
  });
  if (!parsed.success) {
    return err(
      failure("schema_rejected", "copilot propose knowledge: derived plan failed the schema gate", {
        cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_SCHEMA_REJECTED" },
      }),
    );
  }
  return ok(parsed.data);
}

/**
 * Compose the `project-status` region INNER body: the proposed lifecycle + the OPTIONAL candidate summary prose.
 * NO percent/progress (REQ-F-011). No H1 and no markers (the create wraps it; the patch uses it as `newBody`, and
 * the KnowledgeWriter's `applyRegionPatch` adds the markers).
 */
function composeRegionBody(lifecycleState: string, summary: string | undefined): string {
  const lines = [`**Proposed lifecycle:** ${lifecycleState}`];
  const trimmed = summary?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    lines.push("", trimmed);
  }
  return lines.join("\n");
}
