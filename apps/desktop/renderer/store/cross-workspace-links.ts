// Task 14.7 (desktop leg) — the cross-workspace-link UI-safe view type + the deterministic
// anchor-derived linkId mint.
//
// The rule-4 owner-approval surface (§19.1 / §5-§6). The view mirrors the worker's
// UiSafeCrossWorkspaceLink — every field is non-secret (ids / scope descriptors / status /
// timestamps); there is NO raw cross-workspace content in the shape. Defined store-side so the
// slice + reducers depend on it without a lib→store→lib cycle; the command-caller re-exports it.
export interface UiSafeCrossWorkspaceLinkView {
  readonly linkId: string;
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly scopeProjectionType: string;
  readonly scopeVisibilityLevel: string;
  /** "pending" | "approved" | "revoked" (the worker's frozen status; a plain string at the UI). */
  readonly status: string;
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * Mint the DETERMINISTIC linkId from the (from, to, scope) anchor. Idempotent per anchor
 * (re-authorizing the same directional+scoped link is a no-op update, not a duplicate); a scope
 * CHANGE yields a DIFFERENT id ⇒ a NEW link that needs its own owner approval (never a silent
 * widening of an approved link — aligns with worker Lesson 32's immutable-scoped-anchor).
 *
 * COLLISION-FREE BY CONSTRUCTION: each component is percent-escaped so the `~` delimiter can never
 * occur INSIDE a component (even for an arbitrary workspace id), making the join injective — two
 * distinct anchors can never collapse to one linkId. `%` is escaped first so the escaping itself is
 * unambiguous. Not user-typed / not forgeable — computed from the selected registered ids + enums.
 */
export function mintCrossWorkspaceLinkId(
  fromWorkspaceId: string,
  toWorkspaceId: string,
  scopeProjectionType: string,
  scopeVisibilityLevel: string,
): string {
  const enc = (s: string): string => s.replace(/%/g, "%25").replace(/~/g, "%7E");
  return [fromWorkspaceId, toWorkspaceId, scopeProjectionType, scopeVisibilityLevel].map(enc).join("~");
}
