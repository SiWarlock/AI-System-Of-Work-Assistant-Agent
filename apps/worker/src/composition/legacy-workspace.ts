// @sow/worker — the ONE worker-side home for the legacy unprefixed workspace id.
//
// WHAT THIS IS (task 24.26, step 2 of 3): the workspace whose notes may commit at
// UNPREFIXED vault paths, because it predates the per-workspace path prefixing that
// safety rule 4 / WS-8 enforces for every other workspace. `makeEnforceWorkspacePathScope`
// (@sow/knowledge, step 1) takes it as a REQUIRED argument; both worker
// `KnowledgeWriterDeps` literals supply it from here.
//
// ⛔ WHY A CONST AND NOT CONFIG — traced at 24.26 step 2's Step 2.5, so nobody re-derives it:
// NO config surface carries this concept. `ProofSpineParams` has no workspace-identity
// field, and `bootWorker`'s config has five workspace-ish fields, none of which mean this
// (`copilotGbrainWorkspaceId`, `copilotWorkspaceScoping`, `copilotLegacyContentPolicy`,
// `ingestWorkspaceId`, `vaultWatch.workspaceId`).
//
// ⛔⛔ AND SPECIFICALLY — DO NOT "FIX" THIS BY SOURCING IT FROM `copilotLegacyContentPolicy`.
// That field's `toWorkspaceId` holds the SAME STRING today and sits in config and already
// reaches the composition root, so it looks exactly like the source this const should have
// used. IT IS A DIFFERENT CONCEPT: it governs which workspace UNASSIGNED COPILOT LEGACY
// CONTENT IS ASSIGNED TO; this governs WHICH WORKSPACE MAY COMMIT UNPREFIXED PATHS. Binding
// them because the values coincide today would mean a Copilot CONTENT-POLICY change silently
// re-points a rule-4 PATH GUARD. The coincidence is the trap, not the answer.
//
// ⛔ LIFECYCLE — read this before deleting anything during 24.26 step 3:
// Step 3 deletes `LEGACY_UNPREFIXED_WORKSPACE_ID` ON THE KNOWLEDGE SIDE and makes
// `KnowledgeWriterDeps.workspacePathCheck` REQUIRED. At that point THIS const is the single
// home for the value and the only thing supplying a required parameter. It is the
// DESTINATION of that migration, not a casualty of it — do NOT delete it alongside the
// knowledge-side constant.
//
// ⚠ 24.61 does NOT apply to this leg: a compile-time const cannot produce a zero-width or
// whitespace id, so it is not one of the "legs that will supply it" that tripwire guards.
// That changes the moment anyone moves this to config — at which point 24.61 applies to
// THAT slice.

/**
 * The one legacy workspace exempt from vault-path prefixing (safety rule 4 / WS-8).
 * Supplied to `makeEnforceWorkspacePathScope` at both worker composition sites.
 */
export const LEGACY_UNPREFIXED_WORKSPACE_ID = "personal-business";
