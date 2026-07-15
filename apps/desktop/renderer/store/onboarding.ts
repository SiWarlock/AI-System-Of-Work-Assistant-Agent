// Task 14.1 (desktop leg) — the onboarding store slice: the renderer's source of REAL,
// minted workspace ids.
//
// The locked design has THREE workspace buckets (Employer-Work / Personal-Business /
// Personal-Life), one per `WorkspaceType`. A bucket becomes SELECTABLE / QUERYABLE only
// once it has been ONBOARDED — i.e. `onboarding.createWorkspace` minted a real workspaceId
// into the fail-closed WS-8 registry and the result was recorded here. Until then the bucket
// has NO read path (its scoped reads resolve to `null` → empty; never a placeholder id).
//
// This module is WINDOW-FREE (pure data) so the DOM-less node test tsconfig compiles it
// (apps/desktop LESSONS §3). The reducer + selectors over the full store state live in
// `projections.ts` (the reducers home), keyed off the types here.
import type { WorkspaceType } from "@sow/contracts/primitives/enums";
import type { WorkspaceScope } from "./scope";

/** A workspace scope that targets a single bucket — the closed union minus the Global aggregate. */
export type WorkspaceBucketScope = Exclude<WorkspaceScope, "global">;

/**
 * A real onboarded workspace: the minted id + its bucket + the display/provisioning metadata.
 * Keyed in the store by `scope` (its bucket) — the 3-bucket model means one workspace per bucket.
 */
export interface OnboardedWorkspace {
  /** The REAL workspaceId minted by `onboarding.createWorkspace` (drives every scoped read). */
  readonly workspaceId: string;
  /** The bucket this workspace occupies (derived from its `type`). */
  readonly scope: WorkspaceBucketScope;
  /** The user-entered display name. */
  readonly name: string;
  /** The isolation class (WorkspaceType) — immutable binding anchor (worker Lesson 30). */
  readonly type: WorkspaceType;
  /** The preset chosen at onboarding (Simple/Professional/Founder/Advanced). */
  readonly preset: string;
}

/**
 * The 3-bucket model: each `WorkspaceType` maps 1:1 to its scope bucket. TOTAL over the closed
 * `WorkspaceType` union — a new type would be a compile error here, never a silent miss.
 */
export const WORKSPACE_TYPE_TO_SCOPE: Record<WorkspaceType, WorkspaceBucketScope> = {
  employer_work: "employer-work",
  personal_business: "personal-business",
  personal_life: "personal-life",
};

/** The scope bucket a workspace of `type` occupies. Total over `WorkspaceType`. */
export function scopeForType(type: WorkspaceType): WorkspaceBucketScope {
  return WORKSPACE_TYPE_TO_SCOPE[type];
}
