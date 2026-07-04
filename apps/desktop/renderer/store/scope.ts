// The workspace SCOPE model (§9.4, locked design ui-ux-spec §"Workspace scope model").
//
// Today is ONE surface with a top-bar scope switcher. `global` is the cross-workspace
// aggregate (its data flows through the WS-8 visibility gate → query.global); each
// workspace scope re-scopes every read to that one workspace (query.workspace(id)).
//
// PER-WORKSPACE ACCENT (Treatment 1 "subtle scope"): the app accent stays system-blue
// everywhere; only the switcher DOT + the thin scope line take the workspace color.
//
// NOTE — the `workspaceId`s are provisioning placeholders. Real workspace ids are
// minted by onboarding (§9.12); until then the read-model is empty, so a scoped query
// returns empty/not-found. The scope→id mapping firms up when workspaces are created.

/** The four selectable scopes: the Global aggregate + the three isolated workspaces. */
export type WorkspaceScope = "global" | "employer-work" | "personal-business" | "personal-life";

export interface ScopeMeta {
  readonly id: WorkspaceScope;
  /** The switcher label ("All (Global)", "Employer-Work", …). */
  readonly label: string;
  /** The query workspaceId for a workspace scope; `null` for Global (cross-workspace). */
  readonly workspaceId: string | null;
  /** The subtle scope accent (dot + scope line ONLY — the app accent stays system-blue). */
  readonly accent: string;
}

export const WORKSPACE_SCOPES: readonly ScopeMeta[] = [
  { id: "global", label: "All (Global)", workspaceId: null, accent: "#0a84ff" },
  // Employer-Work shares the system-blue accent BY DESIGN (locked): Employer-Work IS
  // the blue workspace; emerald/indigo distinguish the other two. Not a placeholder.
  { id: "employer-work", label: "Employer-Work", workspaceId: "employer-work", accent: "#0a84ff" },
  { id: "personal-business", label: "Personal-Business", workspaceId: "personal-business", accent: "#1fae6b" },
  { id: "personal-life", label: "Personal-Life", workspaceId: "personal-life", accent: "#5e5ce6" },
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
 * True iff a scope targets a single workspace (has a `workspaceId` to scope reads to).
 *
 * This is the workspace-ISOLATION gate for the read_model.change push path (§9.5): a
 * pushed card is folded into `cards` ONLY when this is false (the Global scope). So it
 * fails CLOSED — an UNKNOWN scope (an out-of-union value from a future untyped source:
 * a persisted last-scope, a deep link, an IPC payload) is treated as workspace-scoped →
 * the push is SUPPRESSED, never blended. Only a RECOGNIZED Global scope (workspaceId ===
 * null) permits the cross-workspace fold. (Distinct from `scopeMeta`, which fails OPEN to
 * Global's accent — a safe, never-throw default for DISPLAY, the wrong direction here.)
 */
export function isWorkspaceScope(scope: WorkspaceScope): boolean {
  const meta = BY_ID.get(scope);
  return meta === undefined || meta.workspaceId !== null;
}

/**
 * The query `workspaceId` for a scope that targets a single RECOGNIZED workspace, else `null`.
 *
 * This is the fail-closed gate for the ASK / read direction — the MIRROR of `isWorkspaceScope`
 * (which fails closed for the push-FOLD direction). Here `null` means "not a queryable single
 * workspace": Global → null (cross-workspace, no single id) AND any UNKNOWN / out-of-union scope
 * → null (not recognized). Only the three known workspaces return their id. Use THIS — not
 * `isWorkspaceScope` — wherever an unknown scope must NOT be treated as a queryable workspace
 * (the Copilot ask gate; A5's per-scope read): `isWorkspaceScope` returns `true` for an unknown
 * value, which is the wrong direction for gating a read.
 */
export function resolveWorkspaceId(scope: WorkspaceScope): string | null {
  return BY_ID.get(scope)?.workspaceId ?? null;
}
