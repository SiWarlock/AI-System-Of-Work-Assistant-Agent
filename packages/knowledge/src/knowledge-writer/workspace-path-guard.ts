// Foreign-workspace path-consistency guard (24.12 remedy leg; §5 WS-8; safety rule 4).
//
// The `packages/policy` Copilot serving-time `LegacyContentPolicy` `{mode:"assign"}` bridge
// (`copilot-workspace-scope.ts`) treats every UNPREFIXED note in the combined gbrain brain as
// belonging to its one `toWorkspaceId` — sound ONLY while the brain holds a single workspace's
// unprefixed content. That precondition was previously enforced by an operator-discipline comment
// alone (contracts L123: "MUST is prose, not a gate"). This guard makes the unsound state
// UNREPRESENTABLE at the ONE place every semantic write crosses (KnowledgeWriter, safety rule 1): a
// foreign-workspace note whose path does not carry its own workspace's prefix is rejected before any
// filesystem write (`writer.ts` step 4.5, before ownership/secret-scan/commit).
//
// LAYERING (24.12 brief, deliberate): this module expresses the invariant in the WRITER's own terms
// — "a note's path must be consistent with its bound workspace" — as DATA (which one workspace may
// commit unprefixed), never as an import of `packages/policy`. `LEGACY_UNPREFIXED_WORKSPACE_ID`
// intentionally duplicates the VALUE `apps/desktop/worker-host/index.ts:178` configures as
// `copilotLegacyContentPolicy.toWorkspaceId` — never the logic — because a writer (rule-1 territory)
// importing a Copilot SERVING policy would be a layering inversion. If that value ever changes, both
// sites must move together (recorded here, not hidden — L88's accepted-duplication discipline).
//
// EXEMPTIONS + a SECOND SANCTIONED PREFIX SHAPE (24.12 brief U3 + a code-quality-review finding):
//  1. The ONE legacy workspace (`LEGACY_UNPREFIXED_WORKSPACE_ID`) may commit prefixed OR unprefixed —
//     narrowing this further would break the shipped, owner-chosen posture the `assign` bridge serves.
//  2. KN-12 structural surfaces (`index.md`/`log.md`/`Logs/<date>.md`) are writer-owned, not per-
//     workspace CONTENT, and legitimately ride inside ANY workspace's plan (13.8d: "structural parity
//     rides INSIDE the AUTO plan as ordinary KnowledgeWriter mutations") — reuses `isStructuralSurface`
//     (exported from `../synthesis/grounded-path`, L39: predicate lives once) so the two checks can
//     never drift.
//  3. `${SOURCE_NOTE_SUBTREE}/<workspaceId>/**` (`sources/<ws>/<digest>.md`) is a SECOND sanctioned
//     prefix shape, not an exemption — the workspace id still appears, as the SECOND segment rather
//     than the first. `apps/worker/src/composition/sourceNotePath.ts` derives every ingested-source
//     note at exactly this path (its own header names `SOURCE_NOTE_SUBTREE = "sources"` the "SINGLE
//     SOURCE OF TRUTH"), and left UNRECOGNIZED here, this guard rejected every real ingested source
//     for every workspace but the legacy-exempt one — caught by code-quality review BEFORE it shipped
//     (verified against real, running `apps/worker` tests, not inferred). `SOURCE_NOTE_SUBTREE` below
//     duplicates that file's constant VALUE, same "data not import" reasoning as
//     `LEGACY_UNPREFIXED_WORKSPACE_ID` (packages/knowledge cannot import apps/worker — the reverse of
//     the layering direction this whole module exists to preserve).
//
// PURE; TOTAL never-throws; fail-closed (a malformed/absent plan.workspaceId is rejected, never
// silently admitted).
import { ok, err } from "@sow/contracts";
import type { WorkspacePathCheck, WorkspacePathContext, WorkspacePathViolation } from "./writer";
import { isStructuralSurface, hasNoTraversalSegments } from "../synthesis/grounded-path";

/**
 * The one workspace `packages/policy`'s `LegacyContentPolicy` `{mode:"assign"}` bridge rescues
 * unprefixed legacy content FOR. A plain string, not the branded `WorkspaceId`, matching
 * `KnowledgeMutationPlan.workspaceId`'s own (structurally-required, non-branded) contract type.
 *
 * ⛔ ASSERTED, NOT DERIVED (24.6's own definition of the class this task exists to fix) — recorded
 * honestly rather than silently repeating it. This value DUPLICATES, and does NOT read from,
 * `apps/desktop/worker-host/index.ts:178`'s `copilotLegacyContentPolicy.toWorkspaceId` — a writer
 * (rule-1 territory) importing that Copilot SERVING config would be the layering inversion this
 * module exists to avoid, so the two sites are two hardcoded copies of one fact, not two readers of
 * one source. ⚠ DRIFT DIRECTION, so a future reader does not have to re-derive it: if the two sites
 * ever disagree, this guard's exemption stays pinned to WHATEVER STRING IS WRITTEN HERE — a `toWorkspaceId`
 * change at the config site without a matching edit here makes the NEW legacy workspace's unprefixed
 * writes REJECTED (fail-closed, breaks LOUDLY — every write for that workspace starts erroring) while
 * the OLD one becomes writable-but-no-longer-served (inert, not a leak). Both directions are safe;
 * neither is silent. The real fix — make this a REQUIRED value supplied at the composition root so the
 * two sites can never disagree (L87/L103, one value one home) — is deliberately NOT this slice: it
 * needs a worker-side wiring leg (`apps/worker`/`apps/desktop` are out of this slice's territory).
 */
export const LEGACY_UNPREFIXED_WORKSPACE_ID = "personal-business";

/**
 * DUPLICATES (never imports — `packages/knowledge` cannot depend on `apps/worker`)
 * `apps/worker/src/composition/sourceNotePath.ts`'s `SOURCE_NOTE_SUBTREE` constant. Drift direction:
 * if that file's value ever changes without a matching edit here, EVERY workspace's real source
 * ingestion starts failing this guard (fail-closed, breaks loudly) until the two are re-aligned — the
 * same safe-but-loud direction as `LEGACY_UNPREFIXED_WORKSPACE_ID`'s drift.
 */
export const SOURCE_NOTE_SUBTREE = "sources";

function violation(path: string): WorkspacePathViolation {
  return { code: "workspace_path_violation", path };
}

/**
 * Reject a changed path unless it is (a) a KN-12 structural surface, (b) targeted by the ONE
 * legacy-exempt workspace, (c) prefixed with its OWN `plan.workspaceId` as the first `/`-delimited
 * path segment, or (d) under `${SOURCE_NOTE_SUBTREE}/<workspaceId>/` (segment-wise throughout,
 * mirroring `copilot-workspace-scope.ts`'s own boundary-correct matching — `employer-work` never
 * matches `employer-work-x`).
 */
export const enforceWorkspacePathScope: WorkspacePathCheck = (ctx: WorkspacePathContext) => {
  const path = ctx?.path;
  if (typeof path !== "string" || path.length === 0) return err(violation(typeof path === "string" ? path : ""));
  // Security-review finding (24.12): EVERY check below is a raw string match on path SEGMENTS
  // (prefix/equality), never a resolved-path check — so a `..`/`.`/empty segment can satisfy ANY of
  // them (the structural exemption, the plain prefix match, AND the sources/<ws>/ match) while
  // RESOLVING (`path.resolve`) somewhere else entirely: "Logs/../employer-work-secret.md"
  // string-starts-with "logs/" but resolves outside Logs/; "employer-work/../secret.md" string-starts
  // with "employer-work" but resolves to the vault ROOT, unprefixed — the exact unsound state this
  // whole guard exists to prevent. Reject up front (mirrors the order `admitGroundedPath` always
  // uses) — no exemption or prefix match downstream is meaningful on a traversal-crafted path, for
  // ANY workspace including the legacy-exempt one.
  if (!hasNoTraversalSegments(path)) return err(violation(path));
  if (isStructuralSurface(path)) return ok(undefined);
  const workspaceId = ctx?.plan?.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return err(violation(path)); // fail closed on a malformed plan
  if (workspaceId === LEGACY_UNPREFIXED_WORKSPACE_ID) return ok(undefined);
  const segments = path.split("/");
  if (segments[0] === workspaceId) return ok(undefined);
  if (segments[0] === SOURCE_NOTE_SUBTREE && segments[1] === workspaceId) return ok(undefined);
  return err(violation(path));
};
