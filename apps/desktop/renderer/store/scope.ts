// The workspace SCOPE model (§9.4, locked design ui-ux-spec §"Workspace scope model").
//
// Today is ONE surface with a top-bar scope switcher. `global` is the cross-workspace
// aggregate (its data flows through the WS-8 visibility gate → query.global); each
// workspace scope re-scopes every read to that one workspace (query.workspace(id)).
//
// PER-WORKSPACE ACCENT (Treatment 1 "subtle scope"): the app accent stays system-blue
// everywhere; only the switcher DOT + the thin scope line take the workspace color.
//
// REAL onboarded ids (§19.1 / 14.1): the three workspace scopes are the three locked BUCKETS
// (one per WorkspaceType). This module holds the STATIC per-scope METADATA (label + accent +
// the global flag) only — a scope's REAL query `workspaceId` is NOT here; it is minted by
// onboarding and lives in the store's `onboarded` slice (store/onboarding.ts), resolved via
// `resolveOnboardedWorkspaceId` (store/projections.ts). A bucket absent from that slice has NO
// read path — fail-closed empty-until-onboarded (WS-8), never a placeholder id.

/** The four selectable scopes: the Global aggregate + the three isolated workspace buckets. */
export type WorkspaceScope = "global" | "employer-work" | "personal-business" | "personal-life";

export interface ScopeMeta {
  readonly id: WorkspaceScope;
  /** The switcher label ("All (Global)", "Employer-Work", …). */
  readonly label: string;
  /**
   * True ONLY for the Global cross-workspace aggregate (reads flow through the WS-8 visibility
   * gate — it has no single query workspaceId). False for every workspace bucket. This is the
   * STABLE isolation discriminator — it replaces the former placeholder-`workspaceId !== null`
   * test so `isWorkspaceScope` stays correct now that a bucket's real id lives in the store.
   */
  readonly isGlobal: boolean;
  /** The subtle scope accent (dot + scope line ONLY — the app accent stays system-blue). */
  readonly accent: string;
}

export const WORKSPACE_SCOPES: readonly ScopeMeta[] = [
  { id: "global", label: "All (Global)", isGlobal: true, accent: "#0a84ff" },
  // Employer-Work shares the system-blue accent BY DESIGN (locked): Employer-Work IS
  // the blue workspace; emerald/indigo distinguish the other two. Not a placeholder.
  { id: "employer-work", label: "Employer-Work", isGlobal: false, accent: "#0a84ff" },
  { id: "personal-business", label: "Personal-Business", isGlobal: false, accent: "#1fae6b" },
  { id: "personal-life", label: "Personal-Life", isGlobal: false, accent: "#5e5ce6" },
];

const BY_ID: ReadonlyMap<WorkspaceScope, ScopeMeta> = new Map(
  WORKSPACE_SCOPES.map((m) => [m.id, m]),
);

/** The default scope on launch: the Global cross-workspace aggregate. */
export const DEFAULT_SCOPE: WorkspaceScope = "global";

/** Look up a scope's metadata. Total over the closed union; the fallback is defensive. */
export function scopeMeta(scope: WorkspaceScope): ScopeMeta {
  return BY_ID.get(scope) ?? WORKSPACE_SCOPES[0]!;
}

/**
 * True iff a scope targets a single workspace (must NOT receive the cross-workspace fold).
 *
 * This is the workspace-ISOLATION gate for the read_model.change push path (§9.5): a
 * pushed card is folded into `cards` ONLY when this is false (the Global scope). So it
 * fails CLOSED — an UNKNOWN scope (an out-of-union value from a future untyped source: a
 * persisted last-scope, a deep link, an IPC payload) is treated as workspace-scoped → the
 * push is SUPPRESSED, never blended. Only a RECOGNIZED Global scope (`isGlobal === true`)
 * permits the cross-workspace fold. (Distinct from `scopeMeta`, which fails OPEN to Global's
 * metadata — a safe never-throw default for DISPLAY, the wrong direction here.)
 *
 * NOTE — keyed off the STABLE `isGlobal` flag, NOT a workspaceId: a bucket's real id now
 * lives in the store's `onboarded` slice, so an un-onboarded bucket (no id yet) must STILL
 * read as workspace-scoped/isolated here. Onboarding state must never relax this predicate.
 */
export function isWorkspaceScope(scope: WorkspaceScope): boolean {
  const meta = BY_ID.get(scope);
  return meta === undefined || meta.isGlobal !== true;
}
