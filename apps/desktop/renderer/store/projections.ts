import type { StreamEvent } from "@sow/contracts/api/events";
import type {
  UiSafeApproval,
  UiSafeDashboardCard,
  UiSafeHealthItem,
  UiSafeGclProjection,
  UiSafeRecentChange,
  UiSafeProjectDashboard,
  UiSafeIngestionItem,
} from "@sow/contracts/api/ui-safe";
import type { ConnectionStatus, UiSafeStoreState } from "./index";
import { isWorkspaceScope, type WorkspaceScope } from "./scope";
import type { OnboardedWorkspace, WorkspaceBucketScope } from "./onboarding";
import { routeEquals, type Route } from "./route";

// Pure reducers that fold validated UI-safe StreamEvents into the store. Every
// payload is an allowlisted `UiSafe*` shape (the wire is validated by
// streamEventSchema before it reaches here — see lib/event-stream validateStreamEvent).

function cloneSet<V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

export function withConnection(
  state: UiSafeStoreState,
  connection: ConnectionStatus,
): UiSafeStoreState {
  if (state.connection === connection) return state;
  return { ...state, connection };
}

/** Set the active workspace scope (top-bar switcher). Identity when unchanged. */
export function setScope(state: UiSafeStoreState, scope: WorkspaceScope): UiSafeStoreState {
  if (state.scope === scope) return state;
  return { ...state, scope };
}

// ── Onboarding slice (§19.1 / 14.1) — the source of REAL workspace ids ─────────────
//
// A workspace bucket is SELECTABLE / QUERYABLE only once onboarded (its real minted id is
// recorded here). These selectors REPLACE the former static-placeholder `resolveWorkspaceId`
// at every read site: a bucket absent from the onboarded set resolves to `null` (no read
// path — fail-closed empty-until-onboarded, WS-8), never a resurrected placeholder id.

/**
 * Record a freshly onboarded workspace, keyed by its bucket. Immutable (new state + new Map);
 * LAST-WRITE-WINS per bucket (re-onboarding a bucket replaces its entry — the 3-bucket model
 * allows one workspace per bucket). Identity when the identical entry is already recorded.
 */
export function recordOnboardedWorkspace(
  state: UiSafeStoreState,
  ow: OnboardedWorkspace,
): UiSafeStoreState {
  const existing = state.onboarded.get(ow.scope);
  if (
    existing !== undefined &&
    existing.workspaceId === ow.workspaceId &&
    existing.name === ow.name &&
    existing.type === ow.type &&
    existing.preset === ow.preset
  ) {
    return state; // identical — no state churn
  }
  const next = new Map(state.onboarded);
  next.set(ow.scope, ow);
  return { ...state, onboarded: next };
}

/**
 * Resolve a scope to its REAL onboarded query workspaceId, or `null`. FAIL-CLOSED: Global (a
 * cross-workspace aggregate, no single id), a NON-onboarded bucket, and any unknown/out-of-union
 * scope ALL resolve to `null` → no scoped read path. This is the read-direction replacement for
 * the removed static `resolveWorkspaceId`; the isolation predicate `isWorkspaceScope` (scope.ts)
 * is INDEPENDENT and unchanged (an un-onboarded bucket still reads as isolated there).
 */
export function resolveOnboardedWorkspaceId(
  state: UiSafeStoreState,
  scope: WorkspaceScope,
): string | null {
  if (scope === "global") return null;
  const ow = state.onboarded.get(scope as WorkspaceBucketScope);
  return ow?.workspaceId ?? null;
}

/** True once AT LEAST ONE workspace bucket is onboarded (the first-run gate: false ⇒ onboarding). */
export function hasAnyOnboardedWorkspace(state: UiSafeStoreState): boolean {
  return state.onboarded.size > 0;
}

/**
 * The scope bucket owning a given REAL workspaceId, or `null` if no onboarded workspace matches.
 * Used to map a permitted drill-down's workspaceId back to a selectable scope (App.onDrillDown)
 * — replaces the former placeholder-id `WORKSPACE_SCOPES.find(m => m.workspaceId === id)`.
 */
export function scopeForWorkspaceId(
  state: UiSafeStoreState,
  workspaceId: string,
): WorkspaceScope | null {
  for (const ow of state.onboarded.values()) {
    if (ow.workspaceId === workspaceId) return ow.scope;
  }
  return null;
}

/**
 * Set the mounted SURFACE (left-rail nav; §9.5). Ref-stable no-op when the route is
 * structurally unchanged. INDEPENDENT of scope — never touches the `scope` slice or any
 * scope-hydrated data (cards / projects / recentChanges): the route only chooses which
 * surface renders that already-hydrated data.
 */
export function navigate(state: UiSafeStoreState, route: Route): UiSafeStoreState {
  if (routeEquals(state.route, route)) return state;
  return { ...state, route };
}

/** True when `event.seq` is not the immediate successor of the last applied seq (a dropped event). */
export function isGap(state: UiSafeStoreState, event: StreamEvent): boolean {
  return state.lastSeq !== null && event.seq !== state.lastSeq + 1;
}

/** Fold one validated UI-safe event into state, upserting by id and advancing the resume cursor. */
export function applyStreamEvent(state: UiSafeStoreState, event: StreamEvent): UiSafeStoreState {
  const base: UiSafeStoreState = { ...state, lastEventId: event.eventId, lastSeq: event.seq };
  switch (event.name) {
    case "approval.update":
      // UNCONDITIONAL fold — the Approvals inbox is GLOBAL by design (App.tsx passes the whole map with no
      // scope prop; live.ts hydrateApprovalInbox unions the 3 scoped queries). Per-workspace ISOLATION for
      // approvals lives ENTIRELY in the UiSafeApproval projection (which carries NO workspaceId + no raw
      // content), NOT in this stream fold. ⚠ If a future slice adds `workspaceId` to UiSafeApproval (a
      // per-card workspace label) OR makes the inbox scope-follow, it MUST ALSO scope-guard this fold (mirror
      // the `read_model.change` case below) — otherwise this unconditional fold silently re-surfaces foreign
      // workspace cards, re-opening the WS-4 leak the server-side `listByStatusAndWorkspace` scoping closed.
      // Pinned by the "approvals inbox is intentionally global" test in store/*.test.ts.
      return { ...base, approvals: cloneSet(state.approvals, event.payload.id, event.payload) };
    case "system.health":
      return { ...base, health: cloneSet(state.health, event.payload.id, event.payload) };
    case "workflow.status":
      return {
        ...base,
        workflows: cloneSet(state.workflows, event.payload.workflowId, event.payload),
      };
    case "read_model.change":
      // Workspace isolation (§9.5): a read_model.change carries a `dashboard_cards`
      // change — the cross-workspace aggregate `cards` holds ONLY in Global scope. In a
      // workspace scope `cards` holds that ONE workspace's `query.workspace` read-model,
      // and the pushed card carries no workspaceId, so folding it in could surface a
      // FOREIGN workspace's card under this tab. Apply it ONLY in Global; in a workspace
      // scope advance the resume cursor (never re-request a dropped event / no false gap)
      // but NEVER blend the card. Switching scope re-hydrates the scoped pull path, so no
      // change is lost. Live in-workspace push updates are a scoped-subscription follow-up.
      if (isWorkspaceScope(state.scope)) return base;
      return { ...base, cards: cloneSet(state.cards, event.payload.cardId, event.payload) };
    default: {
      // Exhaustiveness: a new §10 event class must be handled above.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

// ── initial hydrate (9.4b) ───────────────────────────────────────────────────
// Bulk-upsert the read-model an INITIAL query returns (persisted data shows on
// load; the live stream then keeps it current). Keyed identically to the stream
// reducers, so a subsequent stream event for the same id is a clean upsert. The
// resume cursor is untouched — hydrate is a snapshot, not a stream event.

/** Fold an initial dashboard-cards query result into state (upsert by cardId). */
export function hydrateCards(
  state: UiSafeStoreState,
  cards: readonly UiSafeDashboardCard[],
): UiSafeStoreState {
  if (cards.length === 0) return state;
  const next = new Map(state.cards);
  for (const card of cards) next.set(card.cardId, card);
  return { ...state, cards: next };
}

/**
 * REPLACE the cards with a scope's snapshot (clear the prior scope's cards first) —
 * used on a scope change so switching scope NEVER blends the previous scope's cards
 * under the new scope (§9.5 workspace isolation). Distinct from the upsert `hydrateCards`.
 * Empty→empty is a ref-stable no-op.
 */
export function replaceCards(
  state: UiSafeStoreState,
  cards: readonly UiSafeDashboardCard[],
): UiSafeStoreState {
  if (cards.length === 0 && state.cards.size === 0) return state;
  const next = new Map<string, UiSafeDashboardCard>();
  for (const card of cards) next.set(card.cardId, card);
  return { ...state, cards: next };
}

/**
 * REPLACE the active workspace scope's Recent activity with a snapshot (§9.5). Like
 * `replaceCards`, switching scope fully replaces (never blends) — and a scope with no recent
 * changes (incl. Global, where recent changes never surface; WS-8) clears it to `[]`.
 * `query.recentChanges` returns the whole scoped list, so this replaces rather than upserts;
 * only empty→empty is a ref-stable no-op.
 */
export function replaceRecentChanges(
  state: UiSafeStoreState,
  changes: readonly UiSafeRecentChange[],
): UiSafeStoreState {
  if (changes.length === 0 && state.recentChanges.length === 0) return state;
  return { ...state, recentChanges: changes };
}

/**
 * REPLACE the active workspace scope's project dashboards with a snapshot (§9.5). Like
 * `replaceCards`/`replaceRecentChanges`: switching scope fully replaces (never blends), and a
 * scope with no projects (incl. Global, where projects never surface; WS-8) clears it to `[]`.
 * `query.projectList` returns the whole scoped list, so this replaces; empty→empty is a
 * ref-stable no-op.
 */
export function replaceProjects(
  state: UiSafeStoreState,
  projects: readonly UiSafeProjectDashboard[],
): UiSafeStoreState {
  if (projects.length === 0 && state.projects.length === 0) return state;
  return { ...state, projects };
}

/**
 * REPLACE the active workspace scope's ingestion inbox (§9.7) with a fresh `query.ingestionInbox`
 * snapshot — like `replaceProjects`/`replaceRecentChanges`, it is a scope-REPLACE (no blend across
 * workspaces; WS-8) rather than an upsert. Under Global the caller replaces with `[]` (ingestion never
 * aggregates cross-workspace). Empty→no-op (same ref — no needless re-render); the resume cursor is
 * untouched (a hydrate snapshot, not a stream event).
 */
export function replaceIngestion(
  state: UiSafeStoreState,
  ingestion: readonly UiSafeIngestionItem[],
): UiSafeStoreState {
  if (ingestion.length === 0 && state.ingestion.length === 0) return state;
  return { ...state, ingestion };
}

/**
 * Fold approvals into the GLOBAL inbox Map (upsert by id) — used both to seed the inbox
 * from an initial `query.approvalInbox` snapshot on cold load AND to fold the authoritative
 * post-decision record `command.decideApproval` returns (a re-query is unnecessary; the
 * returned record IS the new truth). Keyed identically to the `approval.update` stream
 * reducer, so a subsequent stream event for the same id is a clean upsert.
 *
 * The inbox is NOT scope-cleared (unlike cards/recentChanges/projects): `UiSafeApproval`
 * carries only ids + status + channel + timing — no raw workspace content — so a single
 * cross-scope inbox is WS-8-safe by construction. Empty→no-op (same ref); the resume cursor
 * is untouched (hydrate is a snapshot, not a stream event).
 */
export function hydrateApprovals(
  state: UiSafeStoreState,
  approvals: readonly UiSafeApproval[],
): UiSafeStoreState {
  if (approvals.length === 0) return state;
  const next = new Map(state.approvals);
  for (const approval of approvals) next.set(approval.id, approval);
  return { ...state, approvals: next };
}

/** Fold an initial System-Health query result into state (upsert by id). */
export function hydrateHealth(
  state: UiSafeStoreState,
  items: readonly UiSafeHealthItem[],
): UiSafeStoreState {
  if (items.length === 0) return state;
  const next = new Map(state.health);
  for (const item of items) next.set(item.id, item);
  return { ...state, health: next };
}

// ── Global (§9.4) cross-workspace surface ────────────────────────────────────
// `query.global` returns the WHOLE current global surface, so hydrate REPLACES the
// snapshot (unlike the upsert reducers) — a projection that dropped off the surface
// must disappear, INCLUDING a full retraction (non-empty → empty replaces with []).
// Only empty→empty is a ref-stable no-op (nothing changed).

/** Replace the Global-scope GCL snapshot with the latest query.global result. */
export function hydrateGlobal(
  state: UiSafeStoreState,
  projections: readonly UiSafeGclProjection[],
): UiSafeStoreState {
  if (projections.length === 0 && state.global.length === 0) return state;
  return { ...state, global: [...projections] };
}

/** A workspace's grouped Global items (the §9.4 "sanitized grouped results"). */
export interface GlobalGroup {
  readonly workspaceId: string;
  readonly items: readonly UiSafeGclProjection[];
}

/** Group Global projections by workspaceId, preserving first-seen workspace order. */
export function groupGlobalByWorkspace(
  projections: readonly UiSafeGclProjection[],
): readonly GlobalGroup[] {
  const order: string[] = [];
  const byWs = new Map<string, UiSafeGclProjection[]>();
  for (const p of projections) {
    let bucket = byWs.get(p.workspaceId);
    if (bucket === undefined) {
      bucket = [];
      byWs.set(p.workspaceId, bucket);
      order.push(p.workspaceId);
    }
    bucket.push(p);
  }
  return order.map((workspaceId) => ({
    workspaceId,
    items: byWs.get(workspaceId) ?? [],
  }));
}
