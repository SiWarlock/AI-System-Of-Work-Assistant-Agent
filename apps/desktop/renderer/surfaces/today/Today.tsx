// Today surface — the content pane that mounts inside the AppShell (LOCKED 2026-07-03).
//
// The persistent shell (top bar · scope switcher · scope line · left rail · Copilot rail)
// lives in chrome/AppShell; this file renders ONLY the Today <main> content. It is one of
// several routable surfaces (§9.5); it receives the scope-hydrated read-models as props.
//
// Imports:
//   - react (types)                   — ReactElement, type only
//   - ../../store                     — (unused type import removed with the shell)
//   - @sow/contracts                  — UiSafe* (types only)
// NEVER import electron, node, or @sow/worker from a renderer file.

import { type ReactElement } from "react";
import { WORKSPACE_SCOPES, type WorkspaceScope } from "../../store/scope";
import { groupGlobalByWorkspace } from "../../store/projections";
import { accentVar } from "../../lib/accent";
import type {
  UiSafeDashboardCard,
  UiSafeHealthItem,
  UiSafeGclProjection,
  UiSafeRecentChange,
} from "@sow/contracts/api/ui-safe";

export interface TodayProps {
  /** The active workspace scope (drives the Global-only cross-workspace section). */
  readonly scope: WorkspaceScope;
  readonly cards: readonly UiSafeDashboardCard[];
  readonly health: readonly UiSafeHealthItem[];
  /** The Global-scope cross-workspace GCL surface (§9.4). */
  readonly global: readonly UiSafeGclProjection[];
  /** The active workspace scope's Recent activity (§9.5; empty under Global — WS-8). */
  readonly recentChanges: readonly UiSafeRecentChange[];
  /** Request a policy-gated drill-down into a workspace's context (worker-enforced). */
  readonly onDrillDown: (workspaceId: string, projectionType: string) => void;
}

// ── Waiting-on-you cards ───────────────────────────────────────────────────

function DashboardCards({ cards }: { readonly cards: readonly UiSafeDashboardCard[] }): ReactElement {
  if (cards.length === 0) {
    return (
      <div className="sow-empty" role="status">
        Nothing waiting
      </div>
    );
  }
  return (
    <div className="sow-cards-grid">
      {cards.map((card) => (
        <div className="sow-stat-card" key={card.cardId} tabIndex={0}>
          <span className="sow-card-arr" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
          <div className="sow-card-num" aria-label={`${String(card.count)} ${card.title}`}>
            {card.count}
          </div>
          <div className="sow-card-name">{card.title}</div>
        </div>
      ))}
    </div>
  );
}

// ── System health ──────────────────────────────────────────────────────────

/** Render an enum token ("connector_unreachable") as readable text ("Connector unreachable"). */
function humanizeToken(token: string): string {
  const spaced = token.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0 ? token : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function HealthSection({ health }: { readonly health: readonly UiSafeHealthItem[] }): ReactElement {
  if (health.length === 0) {
    return (
      <div className="sow-callout sow-callout--healthy" role="status">
        <span className="sow-callout-ico sow-callout-ico--healthy" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 12l2 2 4-4" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </span>
        <div className="sow-callout-body">
          <div className="sow-callout-title">All systems healthy</div>
        </div>
      </div>
    );
  }
  return (
    <div className="sow-health-list">
      {health.map((item) => (
        <div className="sow-callout" key={item.id}>
          <span className="sow-callout-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4l9 15.5H3z" />
              <path d="M12 10v4.5M12 17.2v.3" />
            </svg>
          </span>
          <div className="sow-callout-body">
            <div className="sow-callout-title">{humanizeToken(item.failureClass)}</div>
            <div className="sow-callout-sub">
              {item.severity} · {humanizeToken(item.state)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Global (§9.4) cross-workspace grouped surface ──────────────────────────

function GlobalGroups({
  global,
  onDrillDown,
}: {
  readonly global: readonly UiSafeGclProjection[];
  readonly onDrillDown: (workspaceId: string, projectionType: string) => void;
}): ReactElement {
  const groups = groupGlobalByWorkspace(global);
  if (groups.length === 0) {
    return (
      <div className="sow-empty" role="status">
        Nothing across your workspaces yet
      </div>
    );
  }
  return (
    <div className="sow-global-groups">
      {groups.map((group) => {
        // Resolve the workspace's label + subtle accent; unknown ids (pre-onboarding)
        // fall back to the raw id + the app blue.
        const meta = WORKSPACE_SCOPES.find((m) => m.workspaceId === group.workspaceId);
        const label = meta?.label ?? group.workspaceId;
        return (
          <section
            className="sow-global-group"
            key={group.workspaceId}
            style={accentVar(meta?.accent ?? "#0a84ff")}
          >
            <div className="sow-global-group-head">
              <span className="sow-ws-dot" aria-hidden="true" />
              <span className="sow-global-group-name">{label}</span>
            </div>
            <div className="sow-grouped" role="list" aria-label={`${label} — across workspaces`}>
              {group.items.map((item, i) => (
                <div className="sow-row sow-global-row" role="listitem" key={`${item.workspaceId}-${item.projectionType}-${String(i)}`}>
                  <span className="sow-global-type">{humanizeToken(item.projectionType)}</span>
                  <span className="sow-global-summary">{item.summary}</span>
                  {item.drillable ? (
                    <button
                      className="sow-global-drill"
                      type="button"
                      aria-label={`Open ${label} — ${humanizeToken(item.projectionType)}`}
                      onClick={() => onDrillDown(item.workspaceId, item.projectionType)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Today date subtitle ────────────────────────────────────────────────────

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// ── Recent activity (§9.5) ─────────────────────────────────────────────────

/** A short human relative-time from an ISO instant ("just now" / "3h" / "2d"). Display-only. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/**
 * Recent activity (§9.5) — a hairline-divided list of the active WORKSPACE scope's committed
 * knowledge mutations / audit-linked changes (never cards). Workspace-scoped: under Global
 * scope `changes` is empty (recent changes never blend cross-workspace; WS-8). `summary` is
 * the worker's single-line projector-built line; `kind` is a display token; `changeId` rides
 * as a data-attr — the (worker-mediated, scope-checked) audit-drill handle for a later slice.
 */
function RecentActivity({
  changes,
}: {
  readonly changes: readonly UiSafeRecentChange[];
}): ReactElement {
  if (changes.length === 0) {
    return (
      <div className="sow-activity" role="list" aria-label="Recent activity">
        <div className="sow-activity-row sow-activity-empty" role="listitem">
          No recent activity yet
        </div>
      </div>
    );
  }
  return (
    <div className="sow-activity" role="list" aria-label="Recent activity">
      {changes.map((change) => (
        <div
          className="sow-activity-row"
          role="listitem"
          key={change.changeId}
          data-change-id={change.changeId}
        >
          <span className="sow-activity-kind">{change.kind}</span>
          <span className="sow-activity-summary">{change.summary}</span>
          <span className="sow-activity-when">{relativeTime(change.occurredAt)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function Today(props: TodayProps): ReactElement {
  const { scope, cards, health, global, recentChanges, onDrillDown } = props;

  return (
    <main className="sow-content" aria-label="Today dashboard">
      {/* Page header */}
      <div className="sow-page-head">
        <div>
          <h1>Today</h1>
          <div className="sow-subtitle">{todayLabel()}</div>
        </div>
      </div>

      {/* Across your workspaces — the §9.4 Global GCL surface (Global scope only).
          Sanitized grouped results; drill-down is worker-enforced + workspace-scoped. */}
      {scope === "global" ? (
        <>
          <div className="sow-section-label">Across your workspaces</div>
          <GlobalGroups global={global} onDrillDown={onDrillDown} />
        </>
      ) : null}

      {/* Daily brief — static illustrative content (§ material-direction.md) */}
      <div className="sow-section-label">Daily brief</div>
      <p className="sow-brief-text">
        Two meetings on the calendar and one blocker to clear. Vendor review
        still needs close-out. Granola sync is degraded, so the standup
        transcript has not landed yet.
      </p>
      <div className="sow-brief-meta">
        3 decisions logged · 2 meetings · 1 open blocker
      </div>

      {/* Waiting on you — driven from props.cards */}
      <div className="sow-section-label">Waiting on you</div>
      <DashboardCards cards={cards} />

      {/* Today's schedule — static illustrative content */}
      <div className="sow-section-label">{"Today's schedule"}</div>
      <div className="sow-grouped" role="list" aria-label="Today's schedule">
        <div className="sow-row" role="listitem">
          <span className="sow-row-time">09:30</span>
          <span className="sow-row-title">Standup</span>
          <span className="sow-row-people">2 people</span>
          <span className="sow-row-state">transcript pending</span>
        </div>
        <div className="sow-row" role="listitem">
          <span className="sow-row-time">11:00</span>
          <span className="sow-row-title">Vendor review</span>
          <span className="sow-row-people">4 people</span>
          <span className="sow-row-state sow-row-state--attn">
            needs close-out
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </span>
        </div>
        <div className="sow-row" role="listitem">
          <span className="sow-row-time">15:00</span>
          <span className="sow-row-title">1:1 with Priya</span>
          <span className="sow-row-people">2 people</span>
          <span className="sow-row-state">in 4 hours</span>
        </div>
      </div>

      {/* System health — driven from props.health */}
      <div className="sow-section-label">System health</div>
      <HealthSection health={health} />

      {/* Recent activity — workspace-scoped, from props.recentChanges (§9.5) */}
      <div className="sow-section-label">Recent activity</div>
      <RecentActivity changes={recentChanges} />
    </main>
  );
}
